import { randomUUID } from "node:crypto";
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
import { TransientError, isTransient, sleep } from "../retry.js";
import { formatError, withTimeout } from "../../ui/format.js";
import { WEB_SEARCH_TOOL, debugLog } from "../../paths.js";
import { parseSSELines } from "../sse.js";
import { SessionStore, createEphemeralSession } from "../../store/session-store.js";
import { OpenAIOAuth } from "./oauth.js";

const CODEX_API_URL =
  "https://chatgpt.com/backend-api/codex/responses";
const MODELS_API_URL =
  "https://chatgpt.com/backend-api/models";
const DEFAULT_MODEL = "gpt-5.4";

// ─── Responses API types ─────────────────────────────

type ContentItem =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
  | { type: "input_file"; filename: string; file_data: string };

type ResponseItem =
  | { type: "message"; role: "user" | "assistant"; content: ContentItem[] }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string };

// Internal streaming event from SSE parser
type StreamEvent =
  | { kind: "delta"; text: string }
  | {
      kind: "complete";
      text: string;
      toolCalls: Array<{ call_id: string; name: string; args: Record<string, unknown> }>;
      serverToolIds: string[];
      responseItems: ResponseItem[];
      usage?: { input_tokens: number; output_tokens: number };
    };

// ─── Provider ────────────────────────────────────────

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai" as const;
  readonly displayName = "OpenAI";
  currentModel: string = DEFAULT_MODEL;
  reasoningEffort: ReasoningEffort = "medium";

  private authManager: AuthManager;
  private sessionStore: SessionStore;
  private oauth: OpenAIOAuth;
  private abortController: AbortController | null = null;
  private instructions = new Map<string, string>();
  private conversationHistory = new Map<string, ResponseItem[]>();
  private lastStrippedIndex = new Map<string, number>();

  constructor(authManager: AuthManager, sessionStore?: SessionStore) {
    this.authManager = authManager;
    this.sessionStore = sessionStore ?? new SessionStore();
    this.oauth = new OpenAIOAuth(authManager);
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authManager.isAuthenticated("openai");
  }

  async authenticate(): Promise<void> {
    const creds = await this.authManager.getCredentials("openai");
    if (creds && !this.authManager.tokenStore.isExpired("openai"))
      return;

    if (creds?.refreshToken) {
      try {
        const tokens = await this.oauth.refresh(creds.refreshToken);
        await this.authManager.setOAuthTokens(
          "openai",
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresAt,
        );
        return;
      } catch {
        // Refresh failed, do full login
      }
    }

    await this.oauth.login();
  }

  async fetchModels(): Promise<ModelInfo[]> {
    const creds = await this.authManager.getCredentials("openai");
    if (!creds?.accessToken) throw new Error("Not authenticated");

    try {
      const resp = await fetch(MODELS_API_URL, {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
        },
      });

      if (!resp.ok) return this.getDefaultModels();

      const data = (await resp.json()) as {
        models?: Array<{
          slug: string;
          title?: string;
          description?: string;
        }>;
      };

      if (data.models && data.models.length > 0) {
        return data.models.map((m) => ({
          id: m.slug,
          name: m.title ?? m.slug,
          description: m.description,
        }));
      }
    } catch {
      // Ignore
    }

    return this.getDefaultModels();
  }

  private getDefaultModels(): ModelInfo[] {
    return [
      { id: "gpt-5.4", name: "GPT-5.4", description: "Latest flagship, recommended (~400k)" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", description: "Codex (~400k)" },
      { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", description: "Research preview, text-only (~400k)" },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", description: "Codex (~400k)" },
      { id: "gpt-5.2", name: "GPT-5.2", description: "(~400k)" },
      { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max", description: "Max compute (~400k)" },
      { id: "gpt-5.1", name: "GPT-5.1", description: "(~400k)" },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex", description: "Codex (~400k)" },
    ];
  }

  async createSession(config: SessionConfig): Promise<Session> {
    const session = config.ephemeral
      ? createEphemeralSession("openai")
      : this.sessionStore.createSession("openai", config.model ?? this.currentModel);
    this.conversationHistory.set(session.id, []);

    if (config.systemPrompt) {
      this.instructions.set(session.id, config.systemPrompt);
    }

    return session;
  }

  async resumeSession(id: string, systemPrompt?: string): Promise<Session> {
    const session = this.sessionStore.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);

    if (systemPrompt) {
      this.instructions.set(id, systemPrompt);
    }

    if (!this.conversationHistory.has(id)) {
      const stored = this.sessionStore.getMessages(id, 500);
      const history: ResponseItem[] = [];

      for (const m of stored) {
        if (m.role === "user") {
          history.push({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: m.content }],
          });
        } else if (m.role === "assistant") {
          if (m.toolCalls) {
            const tcs = JSON.parse(m.toolCalls) as Array<{ id: string; name: string; args: Record<string, unknown> }>;
            if (m.content) {
              history.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: m.content }],
              });
            }
            for (const tc of tcs) {
              history.push({
                type: "function_call",
                name: tc.name,
                arguments: JSON.stringify(tc.args),
                call_id: tc.id,
              });
            }
          } else {
            history.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: m.content }],
            });
          }
        } else if (m.role === "tool") {
          const meta = m.toolCalls ? JSON.parse(m.toolCalls) as { callId?: string; isError?: boolean } : {};
          history.push({
            type: "function_call_output",
            call_id: meta.callId ?? "",
            output: m.content,
          });
        }
      }

      this.conversationHistory.set(id, history);
    }
    return session;
  }

  async *send(
    session: Session,
    message: string,
    tools: ToolDefinition[],
    attachments?: Attachment[],
  ): AsyncGenerator<AgentEvent> {
    const creds = await this.authManager.getCredentials("openai");
    if (!creds?.accessToken) throw new Error("Not authenticated");

    const history = this.conversationHistory.get(session.id) ?? [];

    // Build user message — plain text or multimodal with attachments
    const content: ContentItem[] = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (att.mediaType.startsWith("image/")) {
          content.push({ type: "input_image", image_url: `data:${att.mediaType};base64,${att.data}`, detail: "high" });
        } else {
          content.push({ type: "input_file", filename: att.filename, file_data: `data:${att.mediaType};base64,${att.data}` });
        }
      }
    }
    content.push({ type: "input_text", text: message });
    history.push({ type: "message", role: "user", content });

    // Agent loop: send → stream response → tool calls → repeat
    const MAX_RETRIES = 3;
    let continueLoop = true;
    while (continueLoop) {
      continueLoop = false;

      let result: StreamEvent & { kind: "complete" } | undefined;
      let lastError: unknown;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const delayMs = Math.min(1000 * 2 ** (attempt - 1), 15000);
          yield { type: "text", text: `\n*[retrying in ${Math.round(delayMs / 1000)}s — attempt ${attempt + 1}/${MAX_RETRIES + 1}]*\n`, delta: `\n*[retrying in ${Math.round(delayMs / 1000)}s — attempt ${attempt + 1}/${MAX_RETRIES + 1}]*\n` };
          await sleep(delayMs);
        }

        try {
          result = undefined;
          for await (const event of this.streamApi(
            session,
            creds.accessToken,
            history,
            tools,
          )) {
            if (event.kind === "delta") {
              yield { type: "text", text: event.text, delta: event.text };
            } else {
              result = event;
            }
          }
          break; // success
        } catch (err) {
          lastError = err;
          if (!isTransient(err) || attempt === MAX_RETRIES) throw err;
          // Transient error — retry
        }
      }

      if (!result) throw lastError ?? new Error("No response from API");

      // Append response items to history
      history.push(...result.responseItems);

      // Emit server-handled tool calls (web search) for UI display
      for (const stId of result.serverToolIds) {
        yield { type: "tool_call", id: stId, name: "web_search", args: {} };
        yield { type: "tool_result", callId: stId, result: "(server-executed)" };
      }

      if (result.toolCalls.length > 0) {
        const multimodalContent: ContentItem[] = [];

        for (const tc of result.toolCalls) {
          debugLog("openai", "tool_call", { name: tc.name, args: tc.args });
          yield {
            type: "tool_call",
            id: tc.call_id,
            name: tc.name,
            args: tc.args,
          };

          const tool = tools.find((t) => t.name === tc.name);
          let toolResult: string;
          let isError = false;

          if (!tool) {
            toolResult = `Unknown tool: ${tc.name}`;
            isError = true;
          } else {
            try {
              toolResult = await withTimeout(tool.execute(tc.args), 300_000, tc.name);
            } catch (err) {
              toolResult = `Error: ${formatError(err)}`;
              isError = true;
            }
          }

          // Extract multimodal attachments — inject as user message after tool outputs
          let outputForHistory = toolResult;
          try {
            const parsed = JSON.parse(toolResult);
            if (parsed?.__multimodal && Array.isArray(parsed.attachments)) {
              outputForHistory = parsed.text ?? "[visual content]";
              for (const att of parsed.attachments as Array<{ mediaType: string; data: string }>) {
                if (att.mediaType.startsWith("image/")) {
                  multimodalContent.push({ type: "input_image", image_url: `data:${att.mediaType};base64,${att.data}`, detail: "high" });
                } else {
                  multimodalContent.push({ type: "input_file", filename: outputForHistory, file_data: `data:${att.mediaType};base64,${att.data}` });
                }
              }
            }
          } catch { /* not JSON */ }

          debugLog("openai", "tool_result", { name: tc.name, isError, resultLen: outputForHistory.length });
          yield { type: "tool_result", callId: tc.call_id, result: toolResult, isError };

          history.push({
            type: "function_call_output",
            call_id: tc.call_id,
            output: outputForHistory,
          });
        }

        // Inject visual content as a follow-up user message so the model can see it
        if (multimodalContent.length > 0) {
          multimodalContent.push({ type: "input_text", text: "Above: visual content from the tool result(s)." });
          history.push({ type: "message", role: "user", content: multimodalContent });
        }

        continueLoop = true;
      }

      if (!continueLoop) {
        yield {
          type: "done",
          usage: result.usage
            ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }
            : undefined,
        };
      }
    }

    // Strip base64 data from attachment blocks so they aren't re-sent on every turn
    this.stripAttachmentData(session.id, history);
    this.conversationHistory.set(session.id, history);
  }

  /** Remove attachment content blocks from history so they aren't re-sent to the API. Only processes new entries. */
  private stripAttachmentData(sessionId: string, history: ResponseItem[]): void {
    const start = this.lastStrippedIndex.get(sessionId) ?? 0;
    for (let i = start; i < history.length; i++) {
      const item = history[i];
      if (item.type !== "message" || !Array.isArray(item.content)) continue;
      item.content = item.content.map((block) => {
        if (block.type === "input_image" && block.image_url.length > 200) {
          return { type: "input_text" as const, text: "[image stripped]" } as unknown as typeof block;
        }
        if (block.type === "input_file" && block.file_data.length > 200) {
          return { type: "input_text" as const, text: "[file stripped]" } as unknown as typeof block;
        }
        return block;
      });
    }
    this.lastStrippedIndex.set(sessionId, history.length);
  }

  resetHistory(session: Session, briefingMessage: string): void {
    // Replace conversation history with a single exchange containing the briefing
    this.conversationHistory.set(session.id, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: briefingMessage }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: CHECKPOINT_ACK }],
      },
    ]);
  }

  interrupt(_session: Session): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async closeSession(session: Session): Promise<void> {
    this.conversationHistory.delete(session.id);
    this.lastStrippedIndex.delete(session.id);
    this.instructions.delete(session.id);
  }

  // ─── Streaming API call ─────────────────────────────

  private async *streamApi(
    session: Session,
    accessToken: string,
    input: ResponseItem[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    this.abortController = new AbortController();

    const hasWebSearch = tools.some((t) => t.name === WEB_SEARCH_TOOL);
    const functionTools = tools
      .filter((t) => t.name !== WEB_SEARCH_TOOL)
      .map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }));

    const toolDefs: unknown[] = [...functionTools];
    if (hasWebSearch) {
      toolDefs.push({ type: "web_search", search_context_size: "medium" });
    }

    const body: Record<string, unknown> = {
      model: this.currentModel,
      instructions: this.instructions.get(session.id) || "You are a helpful assistant.",
      input,
      tools: toolDefs,
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: {
        effort: this.reasoningEffort,
      },
      stream: true,
      store: false,
      include: [],
    };

    debugLog("openai-api", "request", { model: body.model, input: input.length, tools: toolDefs.length });

    const resp = await fetch(CODEX_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        originator: "codex_cli_rs",
      },
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const status = resp.status;
      debugLog("openai-api", "error response", { status, body: errText });
      if (status === 429 || status >= 500) {
        throw new TransientError(`OpenAI API error: ${status} ${errText}`);
      }
      throw new Error(`OpenAI API error: ${status} ${errText}`);
    }

    yield* this.parseSSEStream(resp);
  }

  // ─── SSE stream parser ──────────────────────────────

  private async *parseSSEStream(resp: Response): AsyncGenerator<StreamEvent> {
    const textParts: string[] = [];
    const toolCalls: Array<{ call_id: string; name: string; args: Record<string, unknown> }> = [];
    const serverToolIds: string[] = [];
    const responseItems: ResponseItem[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;

    for await (const evt of parseSSELines(resp) as AsyncGenerator<Record<string, unknown>>) {
      switch (evt.type) {
        case "response.output_text.delta": {
          if (evt.delta) {
            textParts.push(evt.delta as string);
            yield { kind: "delta", text: evt.delta as string };
          }
          break;
        }

        case "response.output_item.done": {
          const item = evt.item as Record<string, unknown> | undefined;
          if (!item) break;

          if (item.type === "message" && item.role === "assistant") {
            responseItems.push({
              type: "message",
              role: "assistant",
              content: (item.content as ContentItem[]) ?? [],
            });
          }

          if (item.type === "function_call") {
            const callId = (item.call_id as string) ?? randomUUID();
            const args = safeJsonParse((item.arguments as string) ?? "{}");
            toolCalls.push({
              call_id: callId,
              name: item.name as string,
              args,
            });
            responseItems.push({
              type: "function_call",
              name: item.name as string,
              arguments: (item.arguments as string) ?? "{}",
              call_id: callId,
            });
          }

          if (item.type === "web_search_call") {
            serverToolIds.push((item.id as string) ?? randomUUID());
          }
          break;
        }

        case "response.completed": {
          const r = evt.response as Record<string, unknown> | undefined;
          const u = r?.usage as Record<string, number> | undefined;
          if (u) {
            usage = {
              input_tokens: u.input_tokens ?? 0,
              output_tokens: u.output_tokens ?? 0,
            };
          }
          break;
        }

        case "response.failed": {
          const r = evt.response as Record<string, unknown> | undefined;
          const err = r?.error as Record<string, unknown> | undefined;
          const msg = (err?.message as string) ?? "Response failed";
          const code = (err?.code as string) ?? "";
          // Server errors, rate limits, and generic "error occurred" messages are transient
          if (code === "server_error" || code === "rate_limit_exceeded" || /error occurred|try again|server/i.test(msg)) {
            throw new TransientError(msg);
          }
          throw new Error(msg);
        }
      }
    }

    // If we accumulated text but no assistant message item, create one for history
    const text = textParts.join("");
    if (text && !responseItems.some((i) => i.type === "message")) {
      responseItems.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
    }

    yield { kind: "complete", text, toolCalls, serverToolIds, responseItems, usage };
  }
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
