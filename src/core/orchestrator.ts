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
import { SessionStore } from "../store/session-store.js";
import { savePreferences } from "../store/preferences.js";
import type { ContextGate } from "../memory/context-gate.js";
import type { StickyManager } from "./stickies.js";

export interface OrchestratorConfig {
  defaultProvider: "claude" | "openai";
  systemPrompt: string;
  agentId?: string;
  sessionStore?: SessionStore;
}

export class Orchestrator {
  private providers = new Map<string, ModelProvider>();
  private activeProvider: ModelProvider | null = null;
  private activeSession: Session | null = null;
  private tools: ToolDefinition[] = [];
  private _totalCostUsd = 0;
  private _lastInputTokens = 0;
  private _contextGate: ContextGate | null = null;
  private _stickyManager: StickyManager | null = null;
  readonly stateMachine = new AgentStateMachine();
  readonly sessionStore: SessionStore;
  readonly config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.sessionStore = config.sessionStore ?? new SessionStore(config.agentId ?? "");
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.push(tool);
  }

  registerTools(tools: ToolDefinition[]): void {
    this.tools.push(...tools);
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

    // Clean up old session before switching
    if (this.activeSession && this.activeProvider) {
      await this.activeProvider.closeSession(this.activeSession).catch(() => {});
      this.activeSession = null;
    }

    await provider.authenticate();

    this.activeProvider = provider;
    savePreferences({ lastProvider: name });
  }

  async ensureSession(): Promise<Session> {
    if (this.activeSession) return this.activeSession;
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
    this.activeSession = session;

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
    const session = await this.activeProvider!.resumeSession(stored.id);
    this.activeSession = session;

    if (this.stateMachine.state === "idle") {
      this.stateMachine.transition("active", "Session resumed");
    }

    return session;
  }

  async *send(message: string, attachments?: Attachment[]): AsyncGenerator<AgentEvent> {
    if (!this.activeProvider) {
      await this.switchProvider(this.config.defaultProvider);
    }

    const session = await this.ensureSession();
    this.sessionStore.updateLastActive(session.id);
    this.sessionStore.addMessage(session.id, "user", message);

    // Prepend sticky notes to the message so the model always sees them
    let augmentedMessage = message;
    if (this._stickyManager) {
      const stickies = this._stickyManager.formatForModel();
      if (stickies) {
        augmentedMessage = stickies + "\n\n---\n\n" + message;
      }
    }

    let fullResponse = "";

    for await (const event of this.activeProvider!.send(
      session,
      augmentedMessage,
      this.tools,
      attachments,
    )) {
      if (event.type === "text" && event.delta) {
        fullResponse += event.delta;
      }

      if (event.type === "done") {
        if (event.usage?.costUsd) {
          this._totalCostUsd += event.usage.costUsd;
        }
        if (event.usage?.inputTokens) {
          this._lastInputTokens = event.usage.inputTokens;
        }
        // Persist cost to session
        if (event.usage && session) {
          this.sessionStore.addCost(
            session.id,
            event.usage.costUsd ?? 0,
            event.usage.inputTokens ?? 0,
            event.usage.outputTokens ?? 0,
          );
        }
      }

      yield event;
    }

    // Check if context window is filling up — trigger checkpoint if needed
    yield* this.maybeCheckpoint(session);

    if (fullResponse) {
      this.sessionStore.addMessage(
        session.id,
        "assistant",
        fullResponse,
      );
    }
  }

  interrupt(): void {
    if (this.activeProvider && this.activeSession) {
      this.activeProvider.interrupt(this.activeSession);
    }
  }

  get currentSession(): Session | null {
    return this.activeSession;
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

  get currentModel(): string | null {
    return this.activeProvider?.currentModel ?? null;
  }

  async setModel(model: string): Promise<void> {
    if (!this.activeProvider) {
      await this.switchProvider(this.config.defaultProvider);
    }
    this.activeProvider!.currentModel = model;
    // Reset session so next message uses the new model
    if (this.activeSession) {
      await this.activeProvider!.closeSession(this.activeSession);
      this.activeSession = null;
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
