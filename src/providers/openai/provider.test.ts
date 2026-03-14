import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestDb } from "../../__tests__/db-helper.js";

// ─── Mocks ───────────────────────────────────────────

const mockDb = { current: createTestDb() };
vi.mock("../../store/database.js", () => {
  const getDb = () => mockDb.current;
  class StmtCache {
    private cache = new Map();
    stmt(sql: string) {
      let s = this.cache.get(sql);
      if (!s) { s = getDb().prepare(sql); this.cache.set(sql, s); }
      return s;
    }
  }
  return { getDb, StmtCache, getHeliosDir: () => "/tmp/helios-test" };
});

vi.mock("../../paths.js", () => ({
  WEB_SEARCH_TOOL: "web_search",
  debugLog: vi.fn(),
}));

const mockOAuthInstance = {
  login: vi.fn(),
  refresh: vi.fn(),
};
vi.mock("./oauth.js", () => {
  return {
    OpenAIOAuth: class MockOpenAIOAuth {
      login = mockOAuthInstance.login;
      refresh = mockOAuthInstance.refresh;
      onAuthUrl: any = null;
    },
  };
});

// ─── Imports (dynamic because of mocks) ──────────────

const { SessionStore } = await import("../../store/session-store.js");
const { OpenAIProvider } = await import("./provider.js");
const { TransientError } = await import("../retry.js");
const { CHECKPOINT_ACK } = await import("../types.js");

// ─── Helpers ─────────────────────────────────────────

function mockAuthManager(
  creds: any = {
    method: "oauth",
    provider: "openai",
    accessToken: "at-test",
    refreshToken: "rt-test",
  },
) {
  return {
    getCredentials: vi.fn().mockResolvedValue(creds),
    setApiKey: vi.fn(),
    setOAuthTokens: vi.fn(),
    isAuthenticated: vi.fn().mockReturnValue(true),
    tokenStore: {
      isExpired: vi.fn().mockReturnValue(false),
      needsRefresh: vi.fn().mockReturnValue(false),
    },
    registerRefreshHandler: vi.fn(),
  } as any;
}

function mockSSEResponse(events: Record<string, unknown>[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Build a minimal SSE response that produces a text reply via OpenAI's Responses API format. */
function textSSEResponse(
  text: string,
  usage = { input_tokens: 10, output_tokens: 5 },
): Response {
  return mockSSEResponse([
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: { usage },
    },
  ]);
}

/** Build a SSE response that includes function_call items. */
function toolCallSSEResponse(
  toolCalls: Array<{ call_id: string; name: string; args: Record<string, unknown> }>,
  text = "",
): Response {
  const events: Record<string, unknown>[] = [];
  if (text) {
    events.push({ type: "response.output_text.delta", delta: text });
    events.push({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    });
  }
  for (const tc of toolCalls) {
    events.push({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: tc.call_id,
        name: tc.name,
        arguments: JSON.stringify(tc.args),
      },
    });
  }
  events.push({
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 20 } },
  });
  return mockSSEResponse(events);
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeTool(name: string, exec?: (args: any) => Promise<string>): any {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    execute: exec ?? vi.fn().mockResolvedValue("tool-result"),
  };
}

function makeSession(id = "sess-1"): any {
  return {
    id,
    providerId: "openai",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
}

// ─── Tests ───────────────────────────────────────────

describe("OpenAIProvider", () => {
  let store: InstanceType<typeof SessionStore>;
  let auth: ReturnType<typeof mockAuthManager>;
  let provider: InstanceType<typeof OpenAIProvider>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDb.current = createTestDb();
    store = new SessionStore();
    auth = mockAuthManager();
    provider = new OpenAIProvider(auth, store);

    mockFetch = vi.fn().mockResolvedValue(textSSEResponse("Hello"));
    vi.stubGlobal("fetch", mockFetch);
    mockOAuthInstance.login.mockReset();
    mockOAuthInstance.refresh.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ========== Session Management ==========

  describe("Session Management", () => {
    it("createSession initializes empty history", async () => {
      const session = await provider.createSession({});
      expect(session.id).toBeTruthy();
      expect((provider as any).conversationHistory.get(session.id)).toEqual([]);
    });

    it("createSession stores instructions from system prompt", async () => {
      const session = await provider.createSession({
        systemPrompt: "You are a researcher",
      });
      expect((provider as any).instructions.get(session.id)).toBe("You are a researcher");
    });

    it("createSession with ephemeral flag creates eph- prefixed session", async () => {
      const session = await provider.createSession({ ephemeral: true });
      expect(session.id).toMatch(/^eph-/);
    });

    it("createSession without ephemeral persists to DB", async () => {
      const session = await provider.createSession({});
      const retrieved = store.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.providerId).toBe("openai");
    });

    it("resumeSession loads session from DB", async () => {
      const created = await provider.createSession({});
      (provider as any).conversationHistory.delete(created.id);
      const resumed = await provider.resumeSession(created.id);
      expect(resumed.id).toBe(created.id);
    });

    it("resumeSession restores conversation history with correct content types", async () => {
      const created = await provider.createSession({});
      store.addMessage(created.id, "user", "Hello");
      store.addMessage(created.id, "assistant", "Hi there");

      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);

      const history = (provider as any).conversationHistory.get(created.id);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      });
      expect(history[1]).toEqual({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hi there" }],
      });
    });

    it("resumeSession with empty history initializes empty array", async () => {
      const created = await provider.createSession({});
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);
      const history = (provider as any).conversationHistory.get(created.id);
      expect(history).toEqual([]);
    });

    it("resumeSession throws for unknown session", async () => {
      await expect(provider.resumeSession("nonexistent")).rejects.toThrow(
        "Session nonexistent not found",
      );
    });

    it("resumeSession restores system prompt", async () => {
      const created = await provider.createSession({});
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id, "System instructions");
      expect((provider as any).instructions.get(created.id)).toBe("System instructions");
    });

    it("resumeSession does not overwrite existing in-memory history", async () => {
      const created = await provider.createSession({});
      const existing = [{ type: "message", role: "user", content: [{ type: "input_text", text: "cached" }] }];
      (provider as any).conversationHistory.set(created.id, existing);

      store.addMessage(created.id, "user", "from DB");
      await provider.resumeSession(created.id);

      const history = (provider as any).conversationHistory.get(created.id);
      expect(history).toHaveLength(1);
      expect(history[0].content[0].text).toBe("cached");
    });

    it("closeSession clears state", async () => {
      const session = await provider.createSession({ systemPrompt: "test" });
      await provider.closeSession(session);

      expect((provider as any).conversationHistory.has(session.id)).toBe(false);
      expect((provider as any).instructions.has(session.id)).toBe(false);
    });

    it("fetchModels with valid token returns API models", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              { slug: "gpt-5.4", title: "GPT-5.4", description: "flagship" },
              { slug: "gpt-5.3", title: "GPT-5.3" },
            ],
          }),
          { status: 200 },
        ),
      );

      const models = await provider.fetchModels();
      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("gpt-5.4");
      expect(models[0].name).toBe("GPT-5.4");
    });

    it("fetchModels falls back to defaults on error", async () => {
      mockFetch.mockResolvedValueOnce(new Response("error", { status: 500 }));

      const models = await provider.fetchModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models[0].id).toBe("gpt-5.4");
    });

    it("fetchModels falls back on empty models array", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [] }), { status: 200 }),
      );
      const models = await provider.fetchModels();
      expect(models[0].id).toBe("gpt-5.4");
    });

    it("getDefaultModels returns expected list", () => {
      const defaults = (provider as any).getDefaultModels();
      expect(defaults.length).toBeGreaterThanOrEqual(5);
      expect(defaults[0].id).toBe("gpt-5.4");
    });
  });

  // ========== History Management (CRITICAL BUG AREA) ==========

  describe("History Management", () => {
    it("send() appends user message to history as input_text content", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "What is ML?", []));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history.find(
        (m: any) =>
          m.type === "message" &&
          m.role === "user" &&
          m.content.some((c: any) => c.type === "input_text" && c.text === "What is ML?"),
      );
      expect(userMsg).toBeDefined();
    });

    it("send() with response appends assistant message", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));

      const history = (provider as any).conversationHistory.get(session.id);
      const assistantMsg = history.find(
        (m: any) =>
          m.type === "message" &&
          m.role === "assistant",
      );
      expect(assistantMsg).toBeDefined();
    });

    it("send() with tool calls appends function_call + function_call_output items", async () => {
      const tool = makeTool("run_cmd");
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ call_id: "fc-1", name: "run_cmd", args: { input: "ls" } }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Run ls", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);

      const funcCall = history.find((m: any) => m.type === "function_call");
      expect(funcCall).toBeDefined();
      expect(funcCall.name).toBe("run_cmd");

      const funcOutput = history.find((m: any) => m.type === "function_call_output");
      expect(funcOutput).toBeDefined();
      expect(funcOutput.call_id).toBe("fc-1");
    });

    it("resume then send: API request includes previous messages (THE BUG TEST)", async () => {
      const created = await provider.createSession({});
      store.addMessage(created.id, "user", "First question");
      store.addMessage(created.id, "assistant", "First answer");

      // Fresh process resume
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);

      await collect(provider.send(created, "Second question", []));

      expect(mockFetch).toHaveBeenCalled();
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);

      // input should contain: restored user, restored assistant, new user = 3 items
      expect(requestBody.input).toHaveLength(3);
      expect(requestBody.input[0]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "First question" }],
      });
      expect(requestBody.input[1]).toEqual({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "First answer" }],
      });
      expect(requestBody.input[2]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Second question" }],
      });
    });

    it("resume then send: fetch body includes ALL restored messages in order", async () => {
      const created = await provider.createSession({});
      for (let i = 1; i <= 5; i++) {
        store.addMessage(created.id, "user", `msg-${i}`);
        store.addMessage(created.id, "assistant", `reply-${i}`);
      }

      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);

      await collect(provider.send(created, "msg-6", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.input).toHaveLength(11); // 10 restored + 1 new
      expect(requestBody.input[0].content[0].text).toBe("msg-1");
      expect(requestBody.input[9].content[0].text).toBe("reply-5");
      expect(requestBody.input[10].content[0].text).toBe("msg-6");
    });

    it("multiple resume/send cycles maintain correct history", async () => {
      const created = await provider.createSession({});
      store.addMessage(created.id, "user", "Turn 1");
      store.addMessage(created.id, "assistant", "Reply 1");

      // First resume + send
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);
      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 2"));
      await collect(provider.send(created, "Turn 2", []));

      let requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.input).toHaveLength(3);

      // Second send (without resume — history accumulated in-memory)
      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 3"));
      await collect(provider.send(created, "Turn 3", []));

      requestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      // Should contain: Turn1, Reply1, Turn2, Reply2(assistant), Turn3
      expect(requestBody.input.length).toBeGreaterThanOrEqual(5);

      const lastItem = requestBody.input[requestBody.input.length - 1];
      expect(lastItem.content[0].text).toBe("Turn 3");
    });

    it("resume reconstructs tool messages and skips system", async () => {
      const created = await provider.createSession({});
      store.addMessage(created.id, "user", "Run command");
      store.addMessage(created.id, "assistant", "Running...", { toolCalls: JSON.stringify([{ id: "tc1", name: "remote_exec", args: { command: "ls" } }]) });
      store.addMessage(created.id, "tool", "file.txt", { toolCalls: JSON.stringify({ callId: "tc1", isError: false }) });
      store.addMessage(created.id, "system", "system msg");

      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);

      const history = (provider as any).conversationHistory.get(created.id);
      // user + assistant(text) + function_call + function_call_output = 4, system skipped
      expect(history).toHaveLength(4);
      expect(history[0].type).toBe("message");
      expect((history[0] as any).role).toBe("user");
      expect(history[1].type).toBe("message"); // assistant text
      expect(history[2].type).toBe("function_call");
      expect(history[3].type).toBe("function_call_output");
    });

    it("multiple sends accumulate history correctly", async () => {
      const session = await provider.createSession({});

      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 1"));
      await collect(provider.send(session, "msg 1", []));

      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 2"));
      await collect(provider.send(session, "msg 2", []));

      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 3"));
      await collect(provider.send(session, "msg 3", []));

      const history = (provider as any).conversationHistory.get(session.id);
      // 3 user + 3 assistant = 6 message items
      const messages = history.filter((h: any) => h.type === "message");
      expect(messages).toHaveLength(6);
    });

    it("resetHistory replaces history with briefing exchange", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("reply"));
      await collect(provider.send(session, "old message", []));

      provider.resetHistory(session, "Here is your memory checkpoint");

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Here is your memory checkpoint" }],
      });
      expect(history[1]).toEqual({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: CHECKPOINT_ACK }],
      });
    });

    it("after resetHistory + send, only briefing + new message in request", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("old"));
      await collect(provider.send(session, "old msg", []));

      provider.resetHistory(session, "Briefing");

      mockFetch.mockResolvedValueOnce(textSSEResponse("new reply"));
      await collect(provider.send(session, "new msg", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(requestBody.input).toHaveLength(3); // briefing, ACK, new msg
      expect(requestBody.input[0].content[0].text).toBe("Briefing");
      expect(requestBody.input[1].content[0].text).toBe(CHECKPOINT_ACK);
      expect(requestBody.input[2].content[0].text).toBe("new msg");
    });

    it("attachment data stripped from history after send (input_image)", async () => {
      const session = await provider.createSession({});
      const longData = "A".repeat(300);
      const attachments = [
        { filename: "img.png", mediaType: "image/png", data: longData },
      ];
      await collect(provider.send(session, "Look at this", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const firstUser = history[0];
      // Image should be stripped (replaced with text placeholder)
      const imageBlock = firstUser.content.find((b: any) => b.type === "input_image");
      expect(imageBlock).toBeUndefined();
      const textPlaceholder = firstUser.content.find(
        (b: any) => typeof b.text === "string" && b.text.includes("stripped"),
      );
      expect(textPlaceholder).toBeDefined();
    });

    it("attachment data stripped from history after send (input_file)", async () => {
      const session = await provider.createSession({});
      const longData = "B".repeat(300);
      const attachments = [
        { filename: "doc.pdf", mediaType: "application/pdf", data: longData },
      ];
      await collect(provider.send(session, "Read this", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const firstUser = history[0];
      const fileBlock = firstUser.content.find((b: any) => b.type === "input_file");
      expect(fileBlock).toBeUndefined();
    });

    it("multimodal content extracted from tool results injects user message", async () => {
      const multimodalResult = JSON.stringify({
        __multimodal: true,
        text: "chart",
        attachments: [{ mediaType: "image/png", data: "chartdata" }],
      });
      const tool = makeTool("plot", vi.fn().mockResolvedValue(multimodalResult));

      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ call_id: "fc-1", name: "plot", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Plot data", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      // Should contain a user message with input_image + input_text for multimodal content
      const multimodalMsg = history.find(
        (m: any) =>
          m.type === "message" &&
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) => c.type === "input_image"),
      );
      expect(multimodalMsg).toBeDefined();
    });

    it("resumed session history is correctly sent on first API call after resume", async () => {
      // Regression test: verifying the fix for the bug where resumed sessions
      // did not include past messages in the API request
      const created = await provider.createSession({});

      for (let i = 1; i <= 4; i++) {
        store.addMessage(created.id, "user", `User turn ${i}`);
        store.addMessage(created.id, "assistant", `Assistant turn ${i}`);
      }

      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id, "System prompt");

      await collect(provider.send(created, "New question", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // 8 restored + 1 new = 9 items
      expect(requestBody.input).toHaveLength(9);
      expect(requestBody.input[0].content[0].text).toBe("User turn 1");
      expect(requestBody.input[7].content[0].text).toBe("Assistant turn 4");
      expect(requestBody.input[8].content[0].text).toBe("New question");
      expect(requestBody.instructions).toBe("System prompt");
    });
  });

  // ========== Send / Streaming ==========

  describe("Send / Streaming", () => {
    it("send() yields text deltas", async () => {
      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "hi", []));
      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBeGreaterThanOrEqual(1);
      expect(textEvents[0].delta).toBe("Hello");
    });

    it("send() yields done with usage", async () => {
      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "hi", []));
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("send() yields tool_call events", async () => {
      const tool = makeTool("my_tool");
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([
            { call_id: "fc-1", name: "my_tool", args: { input: "x" } },
          ]),
        )
        .mockResolvedValueOnce(textSSEResponse("Final"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "use tool", [tool]));

      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
      const tc = toolCallEvents.find((e) => e.name === "my_tool");
      expect(tc).toBeDefined();
      expect(tc.args).toEqual({ input: "x" });
    });

    it("tool execution with results", async () => {
      const tool = makeTool("my_tool", vi.fn().mockResolvedValue("executed!"));
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ call_id: "fc-1", name: "my_tool", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Ok"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "run", [tool]));

      const resultEvents = events.filter(
        (e) => e.type === "tool_result" && e.callId === "fc-1",
      );
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].result).toBe("executed!");
    });

    it("unknown tool error", async () => {
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ call_id: "fc-1", name: "nonexistent", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Ok"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "run", []));

      const resultEvents = events.filter(
        (e) => e.type === "tool_result" && e.callId === "fc-1",
      );
      expect(resultEvents[0].result).toBe("Unknown tool: nonexistent");
      expect(resultEvents[0].isError).toBe(true);
    });

    it("tool timeout", async () => {
      vi.useFakeTimers();
      const neverResolve = new Promise<string>(() => {});
      const tool = makeTool("slow", vi.fn().mockReturnValue(neverResolve));
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ call_id: "fc-1", name: "slow", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Ok"));

      const session = await provider.createSession({});
      const genPromise = collect(provider.send(session, "run", [tool]));

      await vi.advanceTimersByTimeAsync(300_001);
      const events = await genPromise;
      vi.useRealTimers();

      const resultEvents = events.filter((e) => e.type === "tool_result");
      expect(resultEvents[0].result).toContain("timed out");
      expect(resultEvents[0].isError).toBe(true);
    });

    it("server web_search calls yield events", async () => {
      const events = [
        { type: "response.output_text.delta", delta: "Search result" },
        {
          type: "response.output_item.done",
          item: { type: "web_search_call", id: "ws-1" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Search result" }],
          },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ];
      mockFetch.mockResolvedValueOnce(mockSSEResponse(events));

      const webTool = {
        name: "web_search",
        description: "search",
        parameters: { type: "object" as const, properties: {}, required: [] },
        execute: vi.fn(),
      };
      const session = await provider.createSession({});
      const result = await collect(provider.send(session, "search X", [webTool]));

      const toolCalls = result.filter(
        (e) => e.type === "tool_call" && e.name === "web_search",
      );
      expect(toolCalls).toHaveLength(1);

      const toolResults = result.filter(
        (e) => e.type === "tool_result" && e.callId === "ws-1",
      );
      expect(toolResults[0].result).toBe("(server-executed)");
    });

    it("retry on transient error (429)", async () => {
      mockFetch
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(textSSEResponse("OK after retry"));

      vi.useFakeTimers();
      const session = await provider.createSession({});
      const genPromise = collect(provider.send(session, "hi", []));
      await vi.advanceTimersByTimeAsync(2000);
      const events = await genPromise;
      vi.useRealTimers();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    it("retry on transient error (500)", async () => {
      mockFetch
        .mockResolvedValueOnce(new Response("server error", { status: 500 }))
        .mockResolvedValueOnce(textSSEResponse("OK"));

      vi.useFakeTimers();
      const session = await provider.createSession({});
      const genPromise = collect(provider.send(session, "hi", []));
      await vi.advanceTimersByTimeAsync(2000);
      const events = await genPromise;
      vi.useRealTimers();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("response.failed with server_error is transient", async () => {
      const failedResp = mockSSEResponse([
        {
          type: "response.failed",
          response: { error: { code: "server_error", message: "Server error" } },
        },
      ]);
      mockFetch
        .mockResolvedValueOnce(failedResp)
        .mockResolvedValueOnce(textSSEResponse("OK"));

      vi.useFakeTimers();
      const session = await provider.createSession({});
      const genPromise = collect(provider.send(session, "hi", []));
      await vi.advanceTimersByTimeAsync(2000);
      const events = await genPromise;
      vi.useRealTimers();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    it("response.failed with rate_limit_exceeded is transient", async () => {
      const failedResp = mockSSEResponse([
        {
          type: "response.failed",
          response: {
            error: { code: "rate_limit_exceeded", message: "Too many requests" },
          },
        },
      ]);
      mockFetch
        .mockResolvedValueOnce(failedResp)
        .mockResolvedValueOnce(textSSEResponse("OK"));

      vi.useFakeTimers();
      const session = await provider.createSession({});
      const genPromise = collect(provider.send(session, "hi", []));
      await vi.advanceTimersByTimeAsync(2000);
      const events = await genPromise;
      vi.useRealTimers();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("response.failed with other code throws", async () => {
      const failedResp = mockSSEResponse([
        {
          type: "response.failed",
          response: {
            error: { code: "invalid_request", message: "Bad request" },
          },
        },
      ]);
      mockFetch.mockResolvedValueOnce(failedResp);

      const session = await provider.createSession({});
      await expect(collect(provider.send(session, "hi", []))).rejects.toThrow("Bad request");
    });

    it("non-transient HTTP error (400) throws immediately", async () => {
      mockFetch.mockResolvedValueOnce(new Response("bad request", { status: 400 }));

      const session = await provider.createSession({});
      await expect(collect(provider.send(session, "hi", []))).rejects.toThrow("400");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("empty response yields done with no usage", async () => {
      // An empty SSE stream produces a complete event but with no usage
      const emptyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(
        new Response(emptyStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "hi", []));
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent.usage).toBeUndefined();
    });

    it("null body response throws error", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const session = await provider.createSession({});
      await expect(collect(provider.send(session, "hi", []))).rejects.toThrow("No response body");
    });

    it("tool loop works correctly", async () => {
      const tool = makeTool("read_file", vi.fn().mockResolvedValue("file content"));

      mockFetch.mockResolvedValueOnce(
        toolCallSSEResponse([
          { call_id: "fc-1", name: "read_file", args: { input: "main.py" } },
        ]),
      );
      mockFetch.mockResolvedValueOnce(textSSEResponse("Here is what I found"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "read main.py", [tool]));

      const types = events.map((e) => e.type);
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
      expect(types).toContain("text");
      expect(types).toContain("done");
      expect(types[types.length - 1]).toBe("done");
    });

    it("tool execution error is caught", async () => {
      const tool = makeTool(
        "broken",
        vi.fn().mockRejectedValue(new Error("tool broke")),
      );
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ call_id: "fc-1", name: "broken", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Ok"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "run", [tool]));

      const resultEvents = events.filter((e) => e.type === "tool_result");
      expect(resultEvents[0].result).toContain("Error:");
      expect(resultEvents[0].isError).toBe(true);
    });

    it("send includes instructions in request body", async () => {
      const session = await provider.createSession({ systemPrompt: "Be helpful" });
      await collect(provider.send(session, "hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.instructions).toBe("Be helpful");
    });

    it("send uses default instructions when none set", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.instructions).toBe("You are a helpful assistant.");
    });

    it("send sets correct headers", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer at-test");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.originator).toBe("codex_cli_rs");
    });

    it("multiple tool calls in single response", async () => {
      const tool1 = makeTool("tool_a", vi.fn().mockResolvedValue("result-a"));
      const tool2 = makeTool("tool_b", vi.fn().mockResolvedValue("result-b"));

      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([
            { call_id: "fc-1", name: "tool_a", args: { input: "1" } },
            { call_id: "fc-2", name: "tool_b", args: { input: "2" } },
          ]),
        )
        .mockResolvedValueOnce(textSSEResponse("Both done"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "run both", [tool1, tool2]));

      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ========== Auth ==========

  describe("Auth", () => {
    it("isAuthenticated delegates to authManager", async () => {
      const result = await provider.isAuthenticated();
      expect(result).toBe(true);
      expect(auth.isAuthenticated).toHaveBeenCalledWith("openai");
    });

    it("isAuthenticated returns false when no credentials", async () => {
      auth.isAuthenticated.mockReturnValue(false);
      const result = await provider.isAuthenticated();
      expect(result).toBe(false);
    });

    it("authenticate with valid non-expired token returns immediately", async () => {
      auth.getCredentials.mockResolvedValue({
        method: "oauth",
        provider: "openai",
        accessToken: "at-valid",
      });
      auth.tokenStore.isExpired.mockReturnValue(false);

      await provider.authenticate();
      expect(mockOAuthInstance.login).not.toHaveBeenCalled();
      expect(mockOAuthInstance.refresh).not.toHaveBeenCalled();
    });

    it("authenticate with expired token tries refresh", async () => {
      auth.getCredentials.mockResolvedValue({
        method: "oauth",
        provider: "openai",
        accessToken: "at-old",
        refreshToken: "rt-old",
      });
      auth.tokenStore.isExpired.mockReturnValue(true);

      mockOAuthInstance.refresh.mockResolvedValue({
        accessToken: "at-new",
        refreshToken: "rt-new",
        expiresAt: Date.now() + 3600_000,
      });

      await provider.authenticate();
      expect(mockOAuthInstance.refresh).toHaveBeenCalledWith("rt-old");
      expect(auth.setOAuthTokens).toHaveBeenCalled();
    });

    it("authenticate with failed refresh does full login", async () => {
      auth.getCredentials.mockResolvedValue({
        method: "oauth",
        provider: "openai",
        accessToken: "at-old",
        refreshToken: "rt-old",
      });
      auth.tokenStore.isExpired.mockReturnValue(true);

      mockOAuthInstance.refresh.mockRejectedValue(new Error("refresh failed"));

      await provider.authenticate();
      expect(mockOAuthInstance.login).toHaveBeenCalled();
    });

    it("authenticate with no credentials does full login", async () => {
      auth.getCredentials.mockResolvedValue(null);
      await provider.authenticate();
      expect(mockOAuthInstance.login).toHaveBeenCalled();
    });

    it("authenticate with non-expired creds and no refresh token returns immediately", async () => {
      auth.getCredentials.mockResolvedValue({
        method: "oauth",
        provider: "openai",
        accessToken: "at-valid",
      });
      auth.tokenStore.isExpired.mockReturnValue(false);

      await provider.authenticate();
      expect(mockOAuthInstance.login).not.toHaveBeenCalled();
    });

    it("send throws without access token", async () => {
      const noTokenAuth = mockAuthManager({
        method: "oauth",
        provider: "openai",
        accessToken: null,
      });
      const p = new OpenAIProvider(noTokenAuth, store);

      const session = await p.createSession({});
      await expect(collect(p.send(session, "hi", []))).rejects.toThrow(
        "Not authenticated",
      );
    });
  });

  // ========== Configuration ==========

  describe("Configuration", () => {
    it("currentModel defaults to gpt-5.4", () => {
      expect(provider.currentModel).toBe("gpt-5.4");
    });

    it("reasoningEffort defaults to medium", () => {
      expect(provider.reasoningEffort).toBe("medium");
    });

    it("tool definitions use function type format", async () => {
      const tool = makeTool("my_tool");
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", [tool]));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const funcTool = requestBody.tools.find((t: any) => t.name === "my_tool");
      expect(funcTool).toBeDefined();
      expect(funcTool.type).toBe("function");
      expect(funcTool.parameters).toBeDefined();
    });

    it("reasoning effort is sent in request body", async () => {
      provider.reasoningEffort = "high";
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.reasoning).toEqual({ effort: "high" });
    });

    it("currentModel can be changed and is sent in request", async () => {
      provider.currentModel = "gpt-5.3-codex";
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.model).toBe("gpt-5.3-codex");
    });
  });

  // ========== SSE Parsing ==========

  describe("SSE Parsing (parseSSEStream)", () => {
    it("handles response.output_text.delta", async () => {
      const resp = mockSSEResponse([
        { type: "response.output_text.delta", delta: "Hello" },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 3 } },
        },
      ]);
      const events: any[] = [];
      for await (const e of (provider as any).parseSSEStream(resp)) {
        events.push(e);
      }
      expect(events.some((e) => e.kind === "delta" && e.text === "Hello")).toBe(true);
    });

    it("handles response.output_item.done for messages", async () => {
      const resp = mockSSEResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hi" }],
          },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 3 } },
        },
      ]);
      const events: any[] = [];
      for await (const e of (provider as any).parseSSEStream(resp)) {
        events.push(e);
      }
      const complete = events.find((e) => e.kind === "complete");
      expect(complete).toBeDefined();
      expect(complete.responseItems.some((i: any) => i.type === "message")).toBe(true);
    });

    it("handles response.output_item.done for function_call", async () => {
      const resp = mockSSEResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "fc-1",
            name: "test_tool",
            arguments: '{"input":"x"}',
          },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 3 } },
        },
      ]);
      const events: any[] = [];
      for await (const e of (provider as any).parseSSEStream(resp)) {
        events.push(e);
      }
      const complete = events.find((e) => e.kind === "complete");
      expect(complete.toolCalls).toHaveLength(1);
      expect(complete.toolCalls[0].name).toBe("test_tool");
      expect(complete.toolCalls[0].args).toEqual({ input: "x" });
    });

    it("handles response.output_item.done for web_search_call", async () => {
      const resp = mockSSEResponse([
        {
          type: "response.output_item.done",
          item: { type: "web_search_call", id: "ws-1" },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 3 } },
        },
      ]);
      const events: any[] = [];
      for await (const e of (provider as any).parseSSEStream(resp)) {
        events.push(e);
      }
      const complete = events.find((e) => e.kind === "complete");
      expect(complete.serverToolIds).toContain("ws-1");
    });

    it("handles response.completed with usage", async () => {
      const resp = mockSSEResponse([
        {
          type: "response.completed",
          response: { usage: { input_tokens: 100, output_tokens: 50 } },
        },
      ]);
      const events: any[] = [];
      for await (const e of (provider as any).parseSSEStream(resp)) {
        events.push(e);
      }
      const complete = events.find((e) => e.kind === "complete");
      expect(complete.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    it("handles response.failed", async () => {
      const resp = mockSSEResponse([
        {
          type: "response.failed",
          response: {
            error: { code: "invalid_request", message: "Invalid" },
          },
        },
      ]);
      const gen = (provider as any).parseSSEStream(resp);
      await expect(collect(gen)).rejects.toThrow("Invalid");
    });

    it("creates assistant message if none emitted from items", async () => {
      // Only deltas, no output_item.done with assistant message
      const resp = mockSSEResponse([
        { type: "response.output_text.delta", delta: "Synthesized" },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 3 } },
        },
      ]);
      const events: any[] = [];
      for await (const e of (provider as any).parseSSEStream(resp)) {
        events.push(e);
      }
      const complete = events.find((e) => e.kind === "complete");
      expect(complete.responseItems.some((i: any) => i.type === "message" && i.role === "assistant")).toBe(true);
    });

    it("function_call with malformed JSON arguments uses empty object", async () => {
      const resp = mockSSEResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "fc-1",
            name: "test_tool",
            arguments: "not-valid-json",
          },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 3 } },
        },
      ]);
      const events: any[] = [];
      for await (const e of (provider as any).parseSSEStream(resp)) {
        events.push(e);
      }
      const complete = events.find((e) => e.kind === "complete");
      expect(complete.toolCalls[0].args).toEqual({});
    });
  });

  // ========== Interrupt ==========

  describe("Interrupt", () => {
    it("interrupt aborts active request", () => {
      const ac = new AbortController();
      (provider as any).abortController = ac;
      const session = makeSession();

      provider.interrupt(session);

      expect(ac.signal.aborted).toBe(true);
      expect((provider as any).abortController).toBeNull();
    });

    it("interrupt is safe when no active request", () => {
      const session = makeSession();
      provider.interrupt(session);
      expect((provider as any).abortController).toBeNull();
    });
  });

  // ========== Provider Metadata ==========

  describe("Provider Metadata", () => {
    it("name is openai", () => {
      expect(provider.name).toBe("openai");
    });

    it("displayName is OpenAI", () => {
      expect(provider.displayName).toBe("OpenAI");
    });
  });

  // ========== Web Search Tool Filtering ==========

  describe("Web Search Tool Filtering", () => {
    it("web_search tool is sent as special type, not function", async () => {
      const webTool = {
        name: "web_search",
        description: "Search",
        parameters: { type: "object", properties: {}, required: [] },
        execute: vi.fn(),
      };
      const regularTool = makeTool("regular");

      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", [webTool, regularTool]));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const funcTools = requestBody.tools.filter((t: any) => t.type === "function");
      expect(funcTools.map((t: any) => t.name)).toContain("regular");
      expect(funcTools.map((t: any) => t.name)).not.toContain("web_search");
      expect(requestBody.tools.some((t: any) => t.type === "web_search")).toBe(true);
    });
  });

  // ========== Request Body ==========

  describe("Request Body Format", () => {
    it("includes all expected fields", async () => {
      const session = await provider.createSession({ systemPrompt: "test" });
      await collect(provider.send(session, "hi", []));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("gpt-5.4");
      expect(body.instructions).toBe("test");
      expect(body.stream).toBe(true);
      expect(body.store).toBe(false);
      expect(body.tool_choice).toBe("auto");
      expect(body.parallel_tool_calls).toBe(true);
      expect(body.reasoning).toEqual({ effort: "medium" });
    });
  });
});
