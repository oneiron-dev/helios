import {
  query as sdkQuery,
  createSdkMcpServer,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  Query,
  Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { z } from "zod";
import { TransientError, isTransient, sleep } from "../retry.js";
import {
  CHECKPOINT_ACK,
  type ModelProvider,
  type ModelInfo,
  type ToolDefinition,
  type Session,
  type SessionConfig,
  type AgentEvent,
  type ReasoningEffort,
  type Attachment,
} from "../types.js";
import type { AuthManager } from "../auth/auth-manager.js";
import { SessionStore } from "../../store/session-store.js";
import { parseSSELines } from "../sse.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-4-6";

type AuthMode = "cli" | "api_key";

// Claude supports medium, high, max. Map any OpenAI-style values to nearest Claude equivalent.
const THINKING_BUDGETS: Record<string, number> = {
  none: 0,
  minimal: 2000,
  low: 5000,
  medium: 16000,
  high: 50000,
  xhigh: 100000,
  max: 100000,
};

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

// Internal streaming event
type StreamResult =
  | { kind: "delta"; text: string }
  | {
      kind: "complete";
      text: string;
      toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
      serverToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
      usage?: { input: number; output: number };
    };

export class ClaudeProvider implements ModelProvider {
  readonly name = "claude" as const;
  readonly displayName = "Claude";
  currentModel: string = DEFAULT_MODEL;
  reasoningEffort: ReasoningEffort = "medium";

  private authManager: AuthManager;
  private sessionStore: SessionStore;
  private authMode: AuthMode = "api_key";
  private preferredAuthMode: AuthMode | null;
  private activeQuery: Query | null = null;
  private abortController: AbortController | null = null;
  private sdkSessionIds = new Map<string, string>();
  private conversationHistory = new Map<string, AnthropicMessage[]>();
  private systemPrompts = new Map<string, string>();
  // CLI mode: correlate MCP tool executions back to tool_use IDs for UI updates
  // Keyed by original tool name → queue of call IDs (per-tool FIFO, not global FIFO)
  private cliPendingByName = new Map<string, string[]>();
  private cliToolResults: Array<{ callId: string; result: string; isError?: boolean }> = [];

  constructor(authManager: AuthManager, preferredMode?: "cli" | "api", sessionStore?: SessionStore) {
    this.authManager = authManager;
    this.sessionStore = sessionStore ?? new SessionStore();
    this.preferredAuthMode = preferredMode === "cli" ? "cli" : preferredMode === "api" ? "api_key" : null;
  }

  get currentAuthMode(): AuthMode {
    return this.authMode;
  }

  /** Force a specific auth mode. Re-authenticates on next send. */
  setPreferredAuthMode(mode: "cli" | "api"): void {
    this.preferredAuthMode = mode === "cli" ? "cli" : "api_key";
  }

  async isAuthenticated(): Promise<boolean> {
    // CLI mode — claude binary handles its own auth
    if (this.isClaudeCliAvailable()) return true;
    return this.authManager.isAuthenticated("claude");
  }

  async authenticate(): Promise<void> {
    const cliAvailable = this.isClaudeCliAvailable();
    const envKey = process.env.ANTHROPIC_API_KEY;

    // If user explicitly requested a mode, honor it
    if (this.preferredAuthMode === "cli") {
      if (!cliAvailable) {
        throw new Error(
          "Claude CLI mode requested but `claude` binary not found.\n" +
          "Install it: npm i -g @anthropic-ai/claude-code && claude login",
        );
      }
      this.authMode = "cli";
      return;
    }
    if (this.preferredAuthMode === "api_key") {
      if (!envKey) {
        throw new Error(
          "Claude API mode requested but ANTHROPIC_API_KEY not set.",
        );
      }
      await this.authManager.setApiKey("claude", envKey);
      this.authMode = "api_key";
      return;
    }

    // Auto-detect: CLI first, then API key
    if (cliAvailable) {
      this.authMode = "cli";
      return;
    }
    if (envKey) {
      await this.authManager.setApiKey("claude", envKey);
      this.authMode = "api_key";
      return;
    }

    throw new Error(
      "Claude auth required. Either:\n" +
      "  1. Install the `claude` CLI (npm i -g @anthropic-ai/claude-code) and run `claude login`\n" +
      "  2. Set ANTHROPIC_API_KEY environment variable",
    );
  }

  async createSession(config: SessionConfig): Promise<Session> {
    const session = this.sessionStore.createSession(
      "claude",
      config.model ?? this.currentModel,
    );

    if (config.systemPrompt) {
      this.systemPrompts.set(session.id, config.systemPrompt);
    }

    this.conversationHistory.set(session.id, []);
    return session;
  }

  async resumeSession(id: string): Promise<Session> {
    const session = this.sessionStore.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (!this.conversationHistory.has(id)) {
      this.conversationHistory.set(id, []);
    }
    return session;
  }

  async *send(
    session: Session,
    message: string,
    tools: ToolDefinition[],
    attachments?: Attachment[],
  ): AsyncGenerator<AgentEvent> {
    if (this.authMode === "cli") {
      if (attachments?.length) {
        process.stderr.write(
          "[helios] Warning: file attachments are not supported in Claude CLI mode. Switch to API mode (--claude-mode api) to send files.\n",
        );
      }
      yield* this.sendViaCli(session, message, tools);
    } else {
      const creds = await this.authManager.getCredentials("claude");
      if (!creds?.apiKey) throw new Error("No API key — re-authenticate");
      yield* this.sendViaRawApi(session, message, tools, creds.apiKey, attachments);
    }
  }

  interrupt(_session: Session): void {
    if (this.activeQuery) {
      this.activeQuery.interrupt();
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  resetHistory(session: Session, briefingMessage: string): void {
    // Replace conversation history with a single user message containing the briefing
    this.conversationHistory.set(session.id, [
      { role: "user", content: briefingMessage },
      { role: "assistant", content: CHECKPOINT_ACK },
    ]);
  }

  async closeSession(session: Session): Promise<void> {
    if (this.activeQuery) {
      this.activeQuery.close();
      this.activeQuery = null;
    }
    this.sdkSessionIds.delete(session.id);
    this.conversationHistory.delete(session.id);
    this.systemPrompts.delete(session.id);
  }

  async fetchModels(): Promise<ModelInfo[]> {
    return [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", description: "Higher-end reasoning/coding (200k)" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", description: "Balanced speed vs reasoning (200k)" },
    ];
  }

  // ========== CLI Mode (via Agent SDK) ==========

  private async *sendViaCli(
    session: Session,
    message: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<AgentEvent> {
    yield* this.doSendViaCli(session, message, tools, true);
  }

  private async *doSendViaCli(
    session: Session,
    message: string,
    tools: ToolDefinition[],
    allowRetry: boolean,
  ): AsyncGenerator<AgentEvent> {
    const mcpServer = this.buildMcpServer(tools);

    const options: SDKOptions = {
      model: this.currentModel,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      maxTurns: 50,
      mcpServers: { helios: mcpServer },
      tools: [],
      persistSession: true,
    };

    const sdkSessionId = this.sdkSessionIds.get(session.id);
    if (sdkSessionId) {
      options.resume = sdkSessionId;
    }

    this.cliPendingByName.clear();
    this.cliToolResults = [];

    let q: Query;
    try {
      q = sdkQuery({ prompt: message, options });
    } catch (err) {
      // If resume fails at creation, retry without resume
      if (allowRetry && sdkSessionId) {
        this.sdkSessionIds.delete(session.id);
        yield* this.doSendViaCli(session, message, tools, false);
        return;
      }
      throw err;
    }
    this.activeQuery = q;

    try {
      for await (const msg of q) {
        if (
          "session_id" in msg &&
          msg.session_id &&
          !this.sdkSessionIds.has(session.id)
        ) {
          this.sdkSessionIds.set(session.id, msg.session_id);
          session.providerSessionId = msg.session_id;
        }

        // Check for SDK errors that indicate stale session — retry without resume
        if (msg.type === "result" && msg.subtype !== "success" && allowRetry && sdkSessionId) {
          const errMsg = msg as { errors?: string[] };
          const errors = errMsg.errors?.join(" ") ?? "";
          if (errors.includes("No conversation found") || errors.includes("session")) {
            this.sdkSessionIds.delete(session.id);
            this.activeQuery = null;
            yield* this.doSendViaCli(session, message, tools, false);
            return;
          }
        }

        yield* this.mapSdkMessage(msg);

        // Drain tool results that completed since the last SDK message
        while (this.cliToolResults.length > 0) {
          const tr = this.cliToolResults.shift()!;
          yield { type: "tool_result", callId: tr.callId, result: tr.result, isError: tr.isError };
        }
      }
    } finally {
      this.activeQuery = null;
      this.cliPendingByName.clear();
      this.cliToolResults = [];
    }
  }

  // ========== Raw API Mode (API Key) — Streaming ==========

  private async *sendViaRawApi(
    session: Session,
    message: string,
    tools: ToolDefinition[],
    apiKey: string,
    attachments?: Attachment[],
  ): AsyncGenerator<AgentEvent> {
    const history = this.conversationHistory.get(session.id) ?? [];

    // Build user message — plain text or multimodal with attachments
    if (attachments && attachments.length > 0) {
      const content: AnthropicContent[] = [];
      for (const att of attachments) {
        if (att.mediaType === "application/pdf") {
          content.push({ type: "document", source: { type: "base64", media_type: att.mediaType, data: att.data } });
        } else if (att.mediaType.startsWith("image/")) {
          content.push({ type: "image", source: { type: "base64", media_type: att.mediaType, data: att.data } });
        }
      }
      content.push({ type: "text", text: message });
      history.push({ role: "user", content });
    } else {
      history.push({ role: "user", content: message });
    }

    const MAX_RETRIES = 3;
    let continueLoop = true;
    while (continueLoop) {
      continueLoop = false;

      let streamResult: (StreamResult & { kind: "complete" }) | undefined;
      let lastError: unknown;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const delayMs = Math.min(1000 * 2 ** (attempt - 1), 15000);
          yield { type: "text", text: `\n*[retrying in ${Math.round(delayMs / 1000)}s — attempt ${attempt + 1}/${MAX_RETRIES + 1}]*\n`, delta: `\n*[retrying in ${Math.round(delayMs / 1000)}s — attempt ${attempt + 1}/${MAX_RETRIES + 1}]*\n` };
          await sleep(delayMs);
        }

        try {
          streamResult = undefined;
          for await (const event of this.streamRawApi(
            session,
            apiKey,
            history,
            tools,
          )) {
            if (event.kind === "delta") {
              yield { type: "text", text: event.text, delta: event.text };
            } else {
              streamResult = event;
            }
          }
          break; // success
        } catch (err) {
          lastError = err;
          if (!isTransient(err) || attempt === MAX_RETRIES) throw err;
        }
      }

      if (!streamResult) throw lastError ?? new Error("No response from API");

      const { text, toolCalls, serverToolCalls, usage } = streamResult;

      // Emit server-handled tool calls (web search) for UI display
      for (const stc of serverToolCalls) {
        yield { type: "tool_call", id: stc.id, name: stc.name, args: stc.args };
        yield { type: "tool_result", callId: stc.id, result: "(server-executed)" };
      }

      if (toolCalls.length > 0) {
        const assistantContent: AnthropicContent[] = [];
        if (text) assistantContent.push({ type: "text", text });
        for (const tc of toolCalls) {
          assistantContent.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.args,
          });
        }
        history.push({ role: "assistant", content: assistantContent });

        const toolResults: AnthropicContent[] = [];
        for (const tc of toolCalls) {
          yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };

          const tool = tools.find((t) => t.name === tc.name);
          let result: string;
          let isError = false;

          if (!tool) {
            result = `Unknown tool: ${tc.name}`;
            isError = true;
          } else {
            try {
              result = await tool.execute(tc.args);
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
          }

          yield { type: "tool_result", callId: tc.id, result, isError };
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: result,
            is_error: isError,
          });
        }

        history.push({ role: "user", content: toolResults });
        continueLoop = true;
      } else {
        if (text) {
          history.push({ role: "assistant", content: text });
        }
        yield {
          type: "done",
          usage: usage
            ? { inputTokens: usage.input, outputTokens: usage.output }
            : undefined,
        };
      }
    }

    // Strip base64 data from attachment blocks so they aren't re-sent on every turn
    this.stripAttachmentData(history);
    this.conversationHistory.set(session.id, history);
  }

  /** Remove attachment content blocks from history so they aren't re-sent to the API. */
  private stripAttachmentData(history: AnthropicMessage[]): void {
    for (const msg of history) {
      if (!Array.isArray(msg.content)) continue;
      msg.content = msg.content.map((block) => {
        if (
          (block.type === "image" || block.type === "document") &&
          "source" in block &&
          block.source.data.length > 100
        ) {
          return { type: "text" as const, text: `[${block.type} attachment stripped]` } as unknown as typeof block;
        }
        return block;
      });
    }
  }

  // ─── SSE Streaming for Raw API ──────────────────────

  private async *streamRawApi(
    session: Session,
    apiKey: string,
    messages: AnthropicMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamResult> {
    this.abortController = new AbortController();

    const functionTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        properties: t.parameters.properties,
        required: t.parameters.required,
      },
    }));

    // Include Anthropic's built-in web search as a server tool
    const toolDefs: unknown[] = [
      ...functionTools,
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ];

    const budgetTokens = THINKING_BUDGETS[this.reasoningEffort] ?? THINKING_BUDGETS.medium;
    const maxTokens = Math.max(16384, budgetTokens + 8192);

    const body: Record<string, unknown> = {
      model: this.currentModel,
      max_tokens: maxTokens,
      messages,
      stream: true,
    };

    if (budgetTokens > 0) {
      body.thinking = {
        type: "enabled",
        budget_tokens: budgetTokens,
      };
    }

    const systemPrompt = this.systemPrompts.get(session.id);
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    body.tools = toolDefs;

    const resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const status = resp.status;
      if (status === 429 || status >= 500) {
        throw new TransientError(`Anthropic API error: ${status} ${errText}`);
      }
      throw new Error(`Anthropic API error: ${status} ${errText}`);
    }

    let fullText = "";
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const serverToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    let usage: { input: number; output: number } | undefined;

    // Track content blocks by index
    const blocks = new Map<number, {
      type: string;
      id?: string;
      name?: string;
      jsonParts: string[];
    }>();

    for await (const evt of parseSSELines(resp) as AsyncGenerator<Record<string, unknown>>) {
      switch (evt.type) {
        case "message_start": {
          const u = (evt.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
          if (u) {
            usage = {
              input: u.input_tokens ?? 0,
              output: 0,
            };
          }
          break;
        }

        case "content_block_start": {
          const idx = evt.index as number;
          const block = evt.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use") {
            blocks.set(idx, {
              type: "tool_use",
              id: block.id as string,
              name: block.name as string,
              jsonParts: [],
            });
          } else if (block?.type === "server_tool_use") {
            blocks.set(idx, {
              type: "server_tool_use",
              id: block.id as string,
              name: block.name as string,
              jsonParts: [],
            });
          } else if (block?.type === "web_search_tool_result") {
            blocks.set(idx, { type: "web_search_result", jsonParts: [] });
          } else if (block?.type === "thinking") {
            blocks.set(idx, { type: "thinking", jsonParts: [] });
          } else {
            blocks.set(idx, { type: "text", jsonParts: [] });
          }
          break;
        }

        case "content_block_delta": {
          const idx = evt.index as number;
          const delta = evt.delta as Record<string, unknown> | undefined;
          const block = blocks.get(idx);

          if (delta?.type === "text_delta" && delta.text) {
            fullText += delta.text as string;
            yield { kind: "delta", text: delta.text as string };
          }

          if (delta?.type === "input_json_delta" && delta.partial_json && block) {
            block.jsonParts.push(delta.partial_json as string);
          }
          break;
        }

        case "content_block_stop": {
          const idx = evt.index as number;
          const block = blocks.get(idx);
          if (block?.type === "tool_use" && block.id && block.name) {
            const jsonStr = block.jsonParts.join("");
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(jsonStr || "{}");
            } catch {
              // malformed JSON
            }
            toolCalls.push({ id: block.id, name: block.name, args });
          }
          if (block?.type === "server_tool_use" && block.id && block.name) {
            const jsonStr = block.jsonParts.join("");
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(jsonStr || "{}");
            } catch { /* empty */ }
            serverToolCalls.push({ id: block.id, name: block.name, args });
          }
          blocks.delete(idx);
          break;
        }

        case "message_delta": {
          const u = evt.usage as Record<string, number> | undefined;
          if (u && usage) {
            usage.output = u.output_tokens ?? 0;
          }
          break;
        }

        case "message_stop":
          break;

        case "error": {
          const err = evt.error as Record<string, unknown> | undefined;
          const msg = (err?.message as string) ?? "Anthropic streaming error";
          const type = (err?.type as string) ?? "";
          if (type === "overloaded_error" || type === "api_error" || /overloaded|try again|server/i.test(msg)) {
            throw new TransientError(msg);
          }
          throw new Error(msg);
        }
      }
    }

    yield { kind: "complete", text: fullText, toolCalls, serverToolCalls, usage };
  }

  // ========== Utilities ==========

  /** Strip the MCP server prefix (e.g. "mcp__helios__remote_exec" → "remote_exec") */
  private stripMcpPrefix(name: string): string {
    const prefix = "mcp__helios__";
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
  }

  private _cliAvailable: boolean | null = null;
  private isClaudeCliAvailable(): boolean {
    if (this._cliAvailable !== null) return this._cliAvailable;
    try {
      execSync("which claude", { stdio: "ignore" });
      this._cliAvailable = true;
    } catch {
      this._cliAvailable = false;
    }
    return this._cliAvailable;
  }

  private buildMcpServer(tools: ToolDefinition[]) {
    const mcpTools = tools.map((t) =>
      sdkTool(
        t.name,
        t.description,
        this.buildZodSchema(t),
        async (args: Record<string, unknown>) => {
          // Pop the matching tool_call ID from this tool's queue
          const callId = this.cliPendingByName.get(t.name)?.shift();

          try {
            const result = await t.execute(args);
            if (callId) {
              this.cliToolResults.push({ callId, result });
            }
            return { content: [{ type: "text" as const, text: result }] };
          } catch (err) {
            const errText = `Error: ${err instanceof Error ? err.message : String(err)}`;
            if (callId) {
              this.cliToolResults.push({ callId, result: errText, isError: true });
            }
            return {
              content: [{ type: "text" as const, text: errText }],
              isError: true,
            };
          }
        },
      ),
    );

    return createSdkMcpServer({ name: "helios-tools", tools: mcpTools });
  }

  private buildZodSchema(
    tool: ToolDefinition,
  ): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    const props = tool.parameters.properties as Record<
      string,
      { type?: string; description?: string; enum?: string[] }
    >;
    const required = new Set(tool.parameters.required ?? []);

    for (const [key, prop] of Object.entries(props)) {
      let field: z.ZodTypeAny;

      if (prop.enum) {
        field = z.enum(prop.enum as [string, ...string[]]);
      } else {
        switch (prop.type) {
          case "number":
            field = z.number();
            break;
          case "boolean":
            field = z.boolean();
            break;
          case "array":
            field = z.array(z.any());
            break;
          case "object":
            field = z.record(z.string(), z.any());
            break;
          default:
            field = z.string();
        }
      }

      if (prop.description) field = field.describe(prop.description);
      if (!required.has(key)) field = field.optional();
      shape[key] = field;
    }

    return shape;
  }

  private *mapSdkMessage(msg: SDKMessage): Generator<AgentEvent> {
    switch (msg.type) {
      case "assistant": {
        // Text is already streamed via stream_event deltas — only extract tool_use blocks here
        const toolUseBlocks = msg.message.content.filter(
          (b: { type: string }) => b.type === "tool_use",
        );
        for (const block of toolUseBlocks) {
          const tu = block as {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          };
          // Queue the ID under the original tool name so the MCP handler can correlate
          const originalName = this.stripMcpPrefix(tu.name);
          const queue = this.cliPendingByName.get(originalName) ?? [];
          queue.push(tu.id);
          this.cliPendingByName.set(originalName, queue);
          yield { type: "tool_call", id: tu.id, name: originalName, args: tu.input };
        }
        break;
      }

      case "stream_event": {
        const event = msg.event;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "text", text: event.delta.text, delta: event.delta.text };
        }
        break;
      }

      case "result": {
        if (msg.subtype === "success") {
          yield {
            type: "done",
            usage: {
              inputTokens: msg.usage.input_tokens,
              outputTokens: msg.usage.output_tokens,
              costUsd: msg.total_cost_usd,
            },
          };
        } else {
          const errMsg = msg as { errors?: string[] };
          yield {
            type: "error",
            error: new Error(errMsg.errors?.join("; ") ?? "Unknown SDK error"),
            recoverable: false,
          };
          yield { type: "done" };
        }
        break;
      }

      default:
        break;
    }
  }
}

/** Error subclass for transient failures that should be retried. */
