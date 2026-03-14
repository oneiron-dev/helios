import type {
  ModelProvider,
  ModelInfo,
  ToolDefinition,
  Session,
  SessionConfig,
  AgentEvent,
  ReasoningEffort,
  Attachment,
} from "../providers/types.js";
import { AgentStateMachine } from "./state-machine.js";
import { SessionStore, isEphemeralSession } from "../store/session-store.js";
import { savePreferences } from "../store/preferences.js";
import type { ContextGate } from "../memory/context-gate.js";
import type { StickyManager } from "./stickies.js";
import { debugLog } from "../paths.js";
import { formatError, truncate } from "../ui/format.js";

export interface OrchestratorConfig {
  defaultProvider: "claude" | "openai";
  systemPrompt: string;
  agentId?: string;
  sessionStore?: SessionStore;
}

export class Orchestrator {
  private providers = new Map<string, ModelProvider>();
  private activeProvider: ModelProvider | null = null;
  private _activeSession: Session | null = null;
  private tools: ToolDefinition[] = [];
  private _totalCostUsd = 0;
  private _lastInputTokens = 0;
  private _sendLock = false;
  private _contextGate: ContextGate | null = null;
  private _stickyManager: StickyManager | null = null;
  readonly stateMachine = new AgentStateMachine();
  readonly sessionStore: SessionStore;
  readonly config: OrchestratorConfig;

  get activeSession(): Session | null { return this._activeSession; }

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.sessionStore = config.sessionStore ?? new SessionStore(config.agentId ?? "");
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  registerTool(tool: ToolDefinition): void {
    if (!this.tools.some((t) => t.name === tool.name)) {
      this.tools.push(tool);
    }
  }

  registerTools(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  setContextGate(gate: ContextGate): void {
    this._contextGate = gate;
  }

  get contextGate(): ContextGate | null {
    return this._contextGate;
  }

  setStickyManager(manager: StickyManager): void {
    this._stickyManager = manager;
  }

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  getProvider(name?: string): ModelProvider | null {
    if (name) return this.providers.get(name) ?? null;
    return this.activeProvider;
  }

  async switchProvider(name: "claude" | "openai"): Promise<void> {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Provider "${name}" not registered`);
    debugLog("orchestrator", "switching provider", name);

    // Capture the old session ID so we can carry context to the new provider
    const previousSessionId = this._activeSession?.id;

    // Clean up old session before switching
    if (this._activeSession && this.activeProvider) {
      await this.activeProvider.closeSession(this._activeSession).catch(() => {});
      this._activeSession = null;
    }

    await provider.authenticate();
    debugLog("orchestrator", "authenticated", name);

    this.activeProvider = provider;
    savePreferences({ lastProvider: name });

    // If there was an active session with messages, carry context to the new provider
    if (previousSessionId) {
      const hasMessages = this.sessionStore.hasMessages(previousSessionId);
      if (hasMessages) {
        try {
          // Update the session's provider in the DB so resume works
          this.sessionStore.updateProvider(previousSessionId, name);
          const session = await provider.resumeSession(previousSessionId, this.config.systemPrompt);
          this._activeSession = session;

          if (this._contextGate) {
            this._contextGate.onSessionStart(session.id);
          }
          debugLog("orchestrator", "context carried to new provider", previousSessionId);
        } catch (err) {
          debugLog("orchestrator", "failed to carry context", String(err));
          // Fall through — next send() will create a fresh session
        }
      }
    }
  }

  async ensureSession(): Promise<Session> {
    if (this._activeSession) return this._activeSession;
    return this.startSession();
  }

  async startSession(config?: Partial<SessionConfig>): Promise<Session> {
    if (!this.activeProvider) {
      await this.switchProvider(this.config.defaultProvider);
    }

    const sessionConfig: SessionConfig = {
      systemPrompt: this.config.systemPrompt,
      ...config,
    };

    const session =
      await this.activeProvider!.createSession(sessionConfig);
    this._activeSession = session;

    // Bind memory store to this session
    if (this._contextGate) {
      this._contextGate.onSessionStart(session.id);
    }

    if (this.stateMachine.state === "idle") {
      this.stateMachine.transition("active", "Session started");
    }

    return session;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const stored = this.sessionStore.getSession(sessionId);
    if (!stored) throw new Error(`Session "${sessionId}" not found`);

    // Ensure the correct provider is active
    const providerName = stored.providerId as "claude" | "openai";
    if (!this.activeProvider || this.activeProvider.name !== providerName) {
      await this.switchProvider(providerName);
    }

    // Ask the provider to resume its side (re-hydrate conversation history etc.)
    const session = await this.activeProvider!.resumeSession(stored.id, this.config.systemPrompt);
    this._activeSession = session;

    // Backfill title for sessions created before title generation was added
    if (!this.sessionStore.getSessionTitle(session.id)) {
      const msgs = this.sessionStore.getMessages(session.id, 1);
      if (msgs.length > 0 && msgs[0].role === "user") {
        this.sessionStore.updateSessionTitle(session.id, truncate(msgs[0].content, 60, true));
      }
    }

    // Bind memory store to the resumed session
    if (this._contextGate) {
      this._contextGate.onSessionStart(session.id);
    }

    if (this.stateMachine.state === "idle") {
      this.stateMachine.transition("active", "Session resumed");
    }

    return session;
  }

  async *send(message: string, attachments?: Attachment[]): AsyncGenerator<AgentEvent> {
    if (this._sendLock) {
      throw new Error("Another message is already being processed");
    }
    this._sendLock = true;
    try {
      if (!this.activeProvider) {
        await this.switchProvider(this.config.defaultProvider);
      }

      const session = await this.ensureSession();
      const isEphemeral = isEphemeralSession(session);
      const model = this.activeProvider!.currentModel;
      debugLog("orchestrator", "send", { provider: this.activeProvider!.name, model, session: session.id, messageLen: message.length });
      this.sessionStore.updateLastActive(session.id);

      // Check if this is the first message (for title generation)
      const isFirstMessage = !isEphemeral && !this.sessionStore.hasMessages(session.id);
      if (!isEphemeral) {
        this.sessionStore.addMessage(session.id, "user", message);
      }

      // Prepend sticky notes to the message so the model always sees them
      let augmentedMessage = message;
      if (this._stickyManager) {
        const stickies = this._stickyManager.formatForModel();
        if (stickies) {
          augmentedMessage = stickies + "\n\n---\n\n" + message;
        }
      }

      // Per-turn tracking for tool call persistence
      let turnText: string[] = [];
      let turnToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
      let turnFlushed = false;
      let lastOutputTokens: number | undefined;

      try {
        for await (const event of this.activeProvider!.send(
          session,
          augmentedMessage,
          this.tools,
          attachments,
        )) {
          if (event.type === "text" && event.delta) {
            // New text after tool results = new turn
            if (turnFlushed) {
              turnText = [];
              turnToolCalls = [];
              turnFlushed = false;
            }
            turnText.push(event.delta);
          }

          if (event.type === "tool_call") {
            turnToolCalls.push({ id: event.id, name: event.name, args: event.args });
          }

          if (event.type === "tool_result" && !isEphemeral) {
            // Flush the assistant turn that produced these tool calls
            if (!turnFlushed && (turnText.length > 0 || turnToolCalls.length > 0)) {
              this.sessionStore.addMessage(
                session.id,
                "assistant",
                turnText.join(""),
                {
                  toolCalls: turnToolCalls.length > 0 ? JSON.stringify(turnToolCalls) : undefined,
                  tokenCount: lastOutputTokens,
                  model,
                },
              );
              turnFlushed = true;
              lastOutputTokens = undefined;
            }
            // Store tool result
            this.sessionStore.addMessage(
              session.id,
              "tool",
              event.result,
              { toolCalls: JSON.stringify({ callId: event.callId, isError: event.isError }) },
            );
          }

          if (event.type === "done") {
            debugLog("orchestrator", "done", event.usage ?? {});
            if (event.usage) {
              this.addCost(event.usage.costUsd ?? 0, event.usage.inputTokens, event.usage.outputTokens);
              lastOutputTokens = event.usage.outputTokens;
            }
            if (event.usage?.inputTokens) {
              this._lastInputTokens = event.usage.inputTokens;
            }
          }

          yield event;
        }
      } catch (err) {
        debugLog("orchestrator", "ERROR", formatError(err));
        throw err;
      }

      // Check if context window is filling up — trigger checkpoint if needed
      yield* this.maybeCheckpoint(session);

      // Store the final assistant turn (no tool calls — just text)
      if (!turnFlushed && !isEphemeral) {
        const finalText = turnText.join("");
        if (finalText) {
          this.sessionStore.addMessage(
            session.id,
            "assistant",
            finalText,
            { tokenCount: lastOutputTokens, model },
          );
        }
      }

      // Generate session title from first user message
      if (isFirstMessage) {
        this.sessionStore.updateSessionTitle(session.id, truncate(message, 60, true));
      }
    } finally {
      this._sendLock = false;
    }
  }

  /** Optional secondary abort controller (e.g. for looping skills). */
  private _activeAbort: AbortController | null = null;

  /** Register an AbortController to be aborted on interrupt(). */
  setActiveAbort(controller: AbortController | null): void {
    this._activeAbort = controller;
  }

  interrupt(): void {
    if (this.activeProvider && this._activeSession) {
      this.activeProvider.interrupt(this._activeSession);
    }
    if (this._activeAbort) {
      this._activeAbort.abort();
      this._activeAbort = null;
    }
    // Release send lock so the next message isn't permanently blocked
    this._sendLock = false;
  }

  get currentSession(): Session | null {
    return this._activeSession;
  }

  get currentProvider(): ModelProvider | null {
    return this.activeProvider;
  }

  get currentState() {
    return this.stateMachine.state;
  }

  get totalCostUsd(): number {
    return this._totalCostUsd;
  }

  /** Record cost from external sources (e.g. skill executor). */
  addCost(costUsd: number, inputTokens?: number, outputTokens?: number): void {
    this._totalCostUsd += costUsd;
    if (this._activeSession && !isEphemeralSession(this._activeSession)) {
      this.sessionStore.addCost(
        this._activeSession.id,
        costUsd,
        inputTokens ?? 0,
        outputTokens ?? 0,
      );
    }
  }

  get currentModel(): string | null {
    return this.activeProvider?.currentModel ?? null;
  }

  async setModel(model: string): Promise<void> {
    if (!this.activeProvider) {
      await this.switchProvider(this.config.defaultProvider);
    }
    this.activeProvider!.currentModel = model;
    // Reset session so next message uses the new model
    if (this._activeSession) {
      await this.activeProvider!.closeSession(this._activeSession);
      this._activeSession = null;
    }
  }

  async fetchModels(): Promise<ModelInfo[]> {
    if (!this.activeProvider) {
      await this.switchProvider(this.config.defaultProvider);
    }
    if (this.activeProvider!.fetchModels) {
      return this.activeProvider!.fetchModels();
    }
    // Return current model as the only option
    return [{ id: this.activeProvider!.currentModel, name: this.activeProvider!.currentModel }];
  }

  get reasoningEffort(): ReasoningEffort | null {
    return this.activeProvider?.reasoningEffort ?? null;
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<void> {
    if (!this.activeProvider) {
      await this.switchProvider(this.config.defaultProvider);
    }
    this.activeProvider!.reasoningEffort = effort;
  }

  /** Last input token count reported by the provider (for context budget tracking). */
  get lastInputTokens(): number {
    return this._lastInputTokens;
  }

  private async *maybeCheckpoint(session: Session): AsyncGenerator<AgentEvent> {
    if (!this._contextGate || !this.activeProvider) return;

    const model = this.activeProvider.currentModel;
    const threshold = this._contextGate.checkThreshold(model, this._lastInputTokens);
    if (!threshold) return;

    // Ask the model to write a gist of the conversation before we wipe it
    const gist = await this.generateCheckpointGist(session);

    // Save gist to memory and build briefing
    const briefing = this._contextGate.performCheckpointWithGist(gist);

    // Reset provider history with the briefing
    this.activeProvider.resetHistory(session, briefing);
    this._lastInputTokens = 0;

    yield {
      type: "text",
      text: "\n\n---\n*[Context checkpoint — conversation archived, continuing from memory]*\n\n",
      delta: "\n\n---\n*[Context checkpoint — conversation archived, continuing from memory]*\n\n",
    };
  }

  private async generateCheckpointGist(session: Session): Promise<string> {
    const provider = this.activeProvider!;
    let gist = "";

    try {
      for await (const event of provider.send(session, CHECKPOINT_GIST_PROMPT, [])) {
        if (event.type === "text" && event.delta) {
          gist += event.delta;
        }
        if (event.type === "done" && event.usage) {
          this.addCost(event.usage.costUsd ?? 0, event.usage.inputTokens, event.usage.outputTokens);
        }
      }
    } catch {
      // If gist generation fails, continue with empty gist
      gist = "(gist generation failed)";
    }

    return gist;
  }
}

const CHECKPOINT_GIST_PROMPT = `SYSTEM: Your conversation context is about to be archived because it's getting too long. You'll be resumed with your memory tree and this gist.

Write a concise gist covering:
1. **Goal**: What you're trying to achieve
2. **Status**: Where you are right now — what's running, what just finished, what the latest results are
3. **Plan**: What you were about to do next, and why
4. **Key context**: Anything critical that isn't already in your memory tree (observations not yet saved, hunches, dead ends to avoid)

Be direct and dense. This is a note to yourself.`;
