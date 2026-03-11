/**
 * ACP Agent server — maps Agent Client Protocol to the Helios Orchestrator.
 *
 * Lifecycle:
 *   Client → initialize        → negotiate capabilities
 *   Client → session/new       → create orchestrator session
 *   Client → session/prompt    → stream model output as session/update notifications
 *   Client → session/cancel    → interrupt generation
 *   Client → session/list      → list past sessions
 *   Client → session/set_config_option → switch provider/model
 */

import { StdioTransport } from "./transport.js";
import type {
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionCancelParams,
  SessionListParams,
  SessionListResult,
  SetConfigOptionParams,
  SetConfigOptionResult,
  TextContent,
  ContentBlock,
  SessionConfigSelectOption,
  ToolCallKind,
  SessionUpdate,
} from "./types.js";
import type { HeliosRuntime } from "../init.js";
import type { ToolCallEvent } from "../providers/types.js";
import type { MonitorConfig } from "../core/monitor.js";
import type { Message } from "../ui/types.js";
import { VERSION } from "../version.js";
import { COMMANDS, handleSlashCommand, type CommandContext } from "../ui/commands.js";
import { pollTaskStatuses, handleFinishedTasks, buildMonitorMessage } from "../core/task-poller.js";

/** Map helios tool names to ACP tool call kinds. */
function toolKind(name: string): ToolCallKind {
  if (/read|download|task_output|show_metrics|memory_ls|memory_read/.test(name)) return "read";
  if (/write|upload|patch|memory_write|memory_rm|clear/.test(name)) return "edit";
  if (/exec|kill/.test(name)) return "execute";
  if (/fetch|web/.test(name)) return "fetch";
  if (/list|compare|hub_leaves|hub_log|hub_read/.test(name)) return "search";
  if (/consult|writeup/.test(name)) return "think";
  return "other";
}

/** Build a descriptive title for a tool call from the tool name + args. */
function toolTitle(event: ToolCallEvent): string {
  const args = event.args;
  const machine = args.machine_id as string | undefined;
  switch (event.name) {
    case "remote_exec":
    case "remote_exec_background": {
      const label = machine ?? event.name;
      const cmd = args.command as string | undefined;
      return cmd ? `${label}: ${cmd}` : label;
    }
    case "remote_upload":
    case "remote_download":
      return `${machine ?? event.name}: ${args.remote_path ?? args.local_path ?? ""}`;
    case "memory_write":
    case "memory_read":
    case "memory_ls":
    case "memory_rm":
      return `${event.name}: ${args.path ?? "/"}`;
    case "metrics_query":
      return `${event.name}: ${args.name ?? "all"}`;
    default:
      return event.name;
  }
}

export class AcpServer {
  private transport = new StdioTransport();
  private runtime: HeliosRuntime;
  private activeSessions = new Map<string, { cwd: string }>();
  private activePromptSession: string | null = null;
  private initialized = false;
  private prompting = false;
  private static readonly MAX_SESSIONS = 100;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(runtime: HeliosRuntime) {
    this.runtime = runtime;
    this.registerHandlers();
    this.wireMonitor();
    this.wireSleepWake();
    this.startTaskPoll();
  }

  private get orchestrator() { return this.runtime.orchestrator; }
  private get experimentTracker() { return this.runtime.experimentTracker; }

  start(): void {
    this.transport.start();
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.transport.stop();
  }

  // ── Monitor & sleep/wake wiring ────────────────────

  private wireMonitor(): void {
    this.runtime.monitorManager.on("tick", (config: MonitorConfig) => {
      if (this.prompting) return;

      const sessionId = this.getActiveSessionId();
      if (!sessionId) return;

      const message = buildMonitorMessage(config, this.runtime.executor, this.runtime.metricStore);
      this.injectPrompt(sessionId, message);
    });
  }

  private wireSleepWake(): void {
    this.runtime.sleepManager.on("wake", (_session: unknown, _reason: string, wakeMessage: string) => {
      if (this.prompting) return;
      const sessionId = this.getActiveSessionId();
      if (!sessionId) return;
      this.injectPrompt(sessionId, wakeMessage);
    });
  }

  /**
   * Poll background tasks every 5s — detect completion, collect final metrics,
   * update experiment tracker, and fire notifications.
   * Uses setTimeout + re-arm to prevent overlapping polls under high latency.
   */
  private startTaskPoll(): void {
    const { executor, metricCollector } = this.runtime;

    const poll = async () => {
      try {
        const procs = executor.getBackgroundProcesses();
        if (procs.length === 0) {
          await metricCollector.collectAll().catch(() => {});
          return;
        }

        const { finished } = await pollTaskStatuses(executor);

        if (finished.length > 0) {
          await handleFinishedTasks(finished, {
            executor: this.runtime.executor,
            connectionPool: this.runtime.connectionPool,
            metricCollector: this.runtime.metricCollector,
            metricStore: this.runtime.metricStore,
            experimentTracker: this.runtime.experimentTracker,
            notifier: this.runtime.notifier,
          });
        } else {
          await metricCollector.collectAll().catch(() => {});
        }
      } catch {
        // Non-fatal — will retry on next tick
      } finally {
        if (this.pollTimer !== null) {
          this.pollTimer = setTimeout(poll, 5000);
        }
      }
    };

    this.pollTimer = setTimeout(poll, 5000);
  }

  /** Get the most recently used session ID. */
  private getActiveSessionId(): string | null {
    if (this.activePromptSession) return this.activePromptSession;
    // Fall back to the last session we know about
    const ids = [...this.activeSessions.keys()];
    return ids.length > 0 ? ids[ids.length - 1] : null;
  }

  /**
   * Inject a synthetic prompt into the session (monitor tick, sleep wake, etc.)
   * and stream the model's response as ACP session updates.
   */
  private async injectPrompt(sessionId: string, text: string): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;

    try {
      for await (const event of this.orchestrator.send(text)) {
        this.experimentTracker?.onEvent(event);

        switch (event.type) {
          case "text":
            if (event.delta) {
              this.sendUpdate(sessionId, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: event.delta },
              });
            }
            break;

          case "tool_call":
            this.sendUpdate(sessionId, {
              sessionUpdate: "tool_call",
              toolCallId: event.id,
              title: toolTitle(event),
              kind: toolKind(event.name),
              status: "in_progress",
            });
            break;

          case "tool_result": {
            const content: ContentBlock[] = event.result
              ? [{ type: "text", text: event.result }]
              : [];
            this.sendUpdate(sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: event.callId,
              status: event.isError ? "failed" : "completed",
              content,
            });
            break;
          }

          case "error":
            this.sendUpdate(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Error: ${event.error.message}` },
            });
            break;
        }
      }
    } catch (err) {
      process.stderr.write(`[helios-acp] inject prompt error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      this.prompting = false;
    }
  }

  // ── Handler registration ────────────────────────────

  private registerHandlers(): void {
    this.transport.onMethod("initialize", (params) =>
      this.handleInitialize(params as unknown as InitializeParams));

    this.transport.onMethod("session/new", (params) =>
      this.handleSessionNew(params as unknown as SessionNewParams));

    this.transport.onMethod("session/prompt", (params) =>
      this.handleSessionPrompt(params as unknown as SessionPromptParams));

    this.transport.onMethod("session/list", (params) =>
      this.handleSessionList(params as unknown as SessionListParams));

    this.transport.onMethod("session/set_config_option", (params) =>
      this.handleSetConfigOption(params as unknown as SetConfigOptionParams));

    this.transport.onNotification("session/cancel", (params) =>
      this.handleSessionCancel(params as unknown as SessionCancelParams));
  }

  // ── Protocol methods ────────────────────────────────

  private async handleInitialize(_params: InitializeParams): Promise<InitializeResult> {
    this.initialized = true;
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        sessionCapabilities: { list: {} },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: {
        name: "helios",
        title: "Helios — Autonomous ML Research Agent",
        version: VERSION,
      },
      authMethods: [],
    };
  }

  private async handleSessionNew(params: SessionNewParams): Promise<SessionNewResult> {
    if (!this.initialized) throw new Error("Not initialized");

    const session = await this.orchestrator.ensureSession();
    this.activeSessions.set(session.id, { cwd: params.cwd });

    // Evict oldest entries to bound memory
    if (this.activeSessions.size > AcpServer.MAX_SESSIONS) {
      const oldest = this.activeSessions.keys().next().value!;
      this.activeSessions.delete(oldest);
    }

    // Advertise slash commands
    this.sendUpdate(session.id, {
      sessionUpdate: "available_commands_update",
      availableCommands: COMMANDS.map((c) => ({
        name: c.name,
        description: c.description,
        input: c.args ? { hint: c.args } : undefined,
      })),
    });

    // Advertise config options
    const configOptions = this.getConfigOptions();
    this.sendUpdate(session.id, {
      sessionUpdate: "config_option_update",
      configOptions,
    });

    return { sessionId: session.id, configOptions };
  }

  private async handleSessionPrompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    if (!this.initialized) throw new Error("Not initialized");
    this.activePromptSession = params.sessionId;

    // Extract text from content blocks
    const text = params.prompt
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!text.trim()) {
      return { stopReason: "end_turn" };
    }

    // Handle slash commands via the shared command handler
    if (text.startsWith("/")) {
      await handleSlashCommand(text, this.buildCommandContext(params.sessionId));
      return { stopReason: "end_turn" };
    }

    this.prompting = true;
    try {
      let stopReason: SessionPromptResult["stopReason"] = "end_turn";

      for await (const event of this.orchestrator.send(text)) {
        // Check for cancellation
        if (this.activePromptSession !== params.sessionId) {
          stopReason = "cancelled";
          break;
        }

        // Feed to experiment tracker
        this.experimentTracker?.onEvent(event);

        switch (event.type) {
          case "text":
            if (event.delta) {
              this.sendUpdate(params.sessionId, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: event.delta },
              });
            }
            break;

          case "tool_call":
            this.sendUpdate(params.sessionId, {
              sessionUpdate: "tool_call",
              toolCallId: event.id,
              title: toolTitle(event),
              kind: toolKind(event.name),
              status: "in_progress",
            });
            break;

          case "tool_result": {
            const content: ContentBlock[] = event.result
              ? [{ type: "text", text: event.result }]
              : [];
            this.sendUpdate(params.sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: event.callId,
              status: event.isError ? "failed" : "completed",
              content,
            });
            break;
          }

          case "error":
            this.sendUpdate(params.sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Error: ${event.error.message}` },
            });
            break;
        }
      }

      return { stopReason };
    } catch {
      return { stopReason: "end_turn" };
    } finally {
      this.activePromptSession = null;
      this.prompting = false;
    }
  }

  private handleSessionCancel(params: SessionCancelParams): void {
    if (this.activePromptSession === params.sessionId) {
      this.orchestrator.interrupt();
      this.activePromptSession = null;
    }
  }

  private async handleSessionList(_params: SessionListParams): Promise<SessionListResult> {
    if (!this.initialized) throw new Error("Not initialized");
    const summaries = this.orchestrator.sessionStore.listSessionSummaries(50);
    return {
      sessions: summaries.map((s) => ({
        sessionId: s.id,
        cwd: this.activeSessions.get(s.id)?.cwd ?? process.cwd(),
        title: s.firstUserMessage ?? undefined,
        updatedAt: new Date(s.lastActiveAt).toISOString(),
      })),
    };
  }

  private async handleSetConfigOption(params: SetConfigOptionParams): Promise<SetConfigOptionResult> {
    if (!this.initialized) throw new Error("Not initialized");
    if (params.configId === "provider") {
      await this.orchestrator.switchProvider(params.value as "claude" | "openai");
    }
    return { configOptions: this.getConfigOptions() };
  }

  // ── Helpers ─────────────────────────────────────────

  private sendUpdate(sessionId: string, update: SessionUpdate): void {
    this.transport.notify("session/update", {
      sessionId,
      update,
    } as unknown as Record<string, unknown>);
  }

  private getConfigOptions(): SessionConfigSelectOption[] {
    const currentProvider = this.orchestrator.currentProvider?.name ?? "claude";
    return [
      {
        id: "provider",
        name: "Provider",
        type: "select",
        category: "model",
        currentValue: currentProvider,
        options: [
          { value: "claude", name: "Claude" },
          { value: "openai", name: "OpenAI" },
        ],
      },
    ];
  }

  /**
   * Build a CommandContext adapter that routes TUI command output
   * through ACP session/update notifications.
   */
  private buildCommandContext(sessionId: string): CommandContext {
    const messages: Message[] = [];
    let nextId = 1;

    const addMessage = (role: Message["role"], content: string): number => {
      const id = nextId++;
      this.sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: content },
      });
      return id;
    };

    return {
      orchestrator: this.orchestrator,
      addMessage,
      updateMessage: (_id, updates) => {
        // For streaming updates (like /writeup), send incremental chunks
        if (updates.content) {
          this.sendUpdate(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: updates.content },
          });
        }
      },
      setMessages: () => {},
      messages,
      setIsStreaming: () => {},
      connectionPool: this.runtime.connectionPool,
      metricStore: this.runtime.metricStore,
      metricCollector: this.runtime.metricCollector,
      memoryStore: this.runtime.memoryStore,
      stickyManager: this.runtime.stickyManager,
      setStickyNotes: () => {},
      executor: this.runtime.executor,
      restoreMessages: () => [],
    };
  }
}
