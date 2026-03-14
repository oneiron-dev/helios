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

// Mock child_process so isClaudeCliAvailable() returns false — we test raw API mode only
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not found");
  }),
}));

// Mock the Agent SDK (not used in API-key mode)
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(),
  tool: vi.fn(),
}));

vi.mock("../../paths.js", () => ({
  WEB_SEARCH_TOOL: "web_search",
  debugLog: vi.fn(),
  isDebug: vi.fn(() => false),
}));

// ─── Imports (dynamic because of mocks) ──────────────

const { SessionStore } = await import("../../store/session-store.js");
const { ClaudeProvider } = await import("./provider.js");
const { TransientError } = await import("../retry.js");
const { CHECKPOINT_ACK } = await import("../types.js");

// ─── Helpers ─────────────────────────────────────────

function mockAuthManager(
  creds: any = { method: "api_key", provider: "claude", apiKey: "sk-test" },
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

/** Build a minimal SSE response that produces a text reply. */
function textSSEResponse(text: string, usage = { input_tokens: 10, output_tokens: 5 }): Response {
  return mockSSEResponse([
    { type: "message_start", message: { usage: { input_tokens: usage.input_tokens } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ]);
}

/** Build a SSE response that includes tool_use blocks. */
function toolCallSSEResponse(
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  text = "",
): Response {
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
  ];
  let idx = 0;
  if (text) {
    events.push(
      { type: "content_block_start", index: idx, content_block: { type: "text" } },
      { type: "content_block_delta", index: idx, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: idx },
    );
    idx++;
  }
  for (const tc of toolCalls) {
    events.push(
      {
        type: "content_block_start",
        index: idx,
        content_block: { type: "tool_use", id: tc.id, name: tc.name },
      },
      {
        type: "content_block_delta",
        index: idx,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.args) },
      },
      { type: "content_block_stop", index: idx },
    );
    idx++;
  }
  events.push(
    { type: "message_delta", usage: { output_tokens: 20 } },
    { type: "message_stop" },
  );
  return mockSSEResponse(events);
}

/** Collect all events from an async generator. */
async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** Create a simple tool definition. */
function makeTool(name: string, exec?: (args: any) => Promise<string>): any {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
    execute: exec ?? vi.fn().mockResolvedValue("tool-result"),
  };
}

function makeSession(id = "sess-1"): any {
  return { id, providerId: "claude", createdAt: Date.now(), lastActiveAt: Date.now() };
}

// ─── Tests ───────────────────────────────────────────

describe("ClaudeProvider", () => {
  let store: InstanceType<typeof SessionStore>;
  let auth: ReturnType<typeof mockAuthManager>;
  let provider: InstanceType<typeof ClaudeProvider>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDb.current = createTestDb();
    store = new SessionStore();
    auth = mockAuthManager();
    provider = new ClaudeProvider(auth, "api", store);
    // Force auth mode since authenticate() reads env
    (provider as any).authMode = "api_key";
    // Clear the CLI-available cache so the mock takes effect
    (provider as any)._cliAvailable = null;

    mockFetch = vi.fn().mockResolvedValue(textSSEResponse("Hello"));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ========== Session Management ==========

  describe("Session Management", () => {
    it("createSession stores system prompt and initializes empty history", async () => {
      const session = await provider.createSession({
        systemPrompt: "You are a researcher",
      });
      expect(session.id).toBeTruthy();
      expect((provider as any).systemPrompts.get(session.id)).toBe("You are a researcher");
      expect((provider as any).conversationHistory.get(session.id)).toEqual([]);
    });

    it("createSession with ephemeral flag creates eph- prefixed session", async () => {
      const session = await provider.createSession({ ephemeral: true });
      expect(session.id).toMatch(/^eph-/);
    });

    it("createSession without ephemeral persists to DB", async () => {
      const session = await provider.createSession({});
      const retrieved = store.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.providerId).toBe("claude");
    });

    it("createSession uses custom model", async () => {
      const session = await provider.createSession({ model: "claude-sonnet-4-6" });
      const retrieved = store.getSession(session.id);
      expect(retrieved).not.toBeNull();
    });

    it("resumeSession loads session from DB", async () => {
      const created = await provider.createSession({});
      // Clear in-memory state to simulate fresh process
      (provider as any).conversationHistory.delete(created.id);
      const resumed = await provider.resumeSession(created.id);
      expect(resumed.id).toBe(created.id);
    });

    it("resumeSession restores conversation history from stored messages", async () => {
      const created = await provider.createSession({});
      store.addMessage(created.id, "user", "Hello");
      store.addMessage(created.id, "assistant", "Hi there");

      // Clear in-memory state
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);

      const history = (provider as any).conversationHistory.get(created.id);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: "user", content: "Hello" });
      expect(history[1]).toEqual({ role: "assistant", content: "Hi there" });
    });

    it("resumeSession with empty history initializes empty array", async () => {
      const created = await provider.createSession({});
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);

      const history = (provider as any).conversationHistory.get(created.id);
      expect(history).toEqual([]);
    });

    it("resumeSession throws for unknown session ID", async () => {
      await expect(provider.resumeSession("nonexistent")).rejects.toThrow(
        "Session nonexistent not found",
      );
    });

    it("resumeSession restores system prompt", async () => {
      const created = await provider.createSession({});
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id, "You are a scientist");
      expect((provider as any).systemPrompts.get(created.id)).toBe("You are a scientist");
    });

    it("resumeSession restores SDK session ID mapping", async () => {
      const created = store.createSession("claude");
      store.updateProviderSessionId(created.id, "sdk-abc");
      await provider.resumeSession(created.id);
      expect((provider as any).sdkSessionIds.get(created.id)).toBe("sdk-abc");
    });

    it("resumeSession does not overwrite existing in-memory history", async () => {
      const created = await provider.createSession({});
      const existingHistory = [{ role: "user", content: "already loaded" }];
      (provider as any).conversationHistory.set(created.id, existingHistory);

      store.addMessage(created.id, "user", "from DB");
      await provider.resumeSession(created.id);

      const history = (provider as any).conversationHistory.get(created.id);
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("already loaded");
    });

    it("closeSession clears all internal state", async () => {
      const session = await provider.createSession({ systemPrompt: "test" });
      (provider as any).sdkSessionIds.set(session.id, "sdk-1");

      await provider.closeSession(session);

      expect((provider as any).conversationHistory.has(session.id)).toBe(false);
      expect((provider as any).systemPrompts.has(session.id)).toBe(false);
      expect((provider as any).sdkSessionIds.has(session.id)).toBe(false);
    });

    it("fetchModels returns Claude models", async () => {
      const models = await provider.fetchModels();
      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("claude-opus-4-6");
      expect(models[1].id).toBe("claude-sonnet-4-6");
    });
  });

  // ========== History Management (CRITICAL BUG AREA) ==========

  describe("History Management", () => {
    it("after send(), conversation history includes the user message", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "What is ML?", []));

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history.some((m: any) => m.role === "user" && m.content === "What is ML?")).toBe(true);
    });

    it("after send() with text response, history includes assistant message", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history.some((m: any) => m.role === "assistant" && m.content === "Hello")).toBe(true);
    });

    it("after send() with tool calls, history includes tool_use and tool_result blocks", async () => {
      const tool = makeTool("remote_exec");
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "tc-1", name: "remote_exec", args: { input: "ls" } }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Run ls", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      // Should have: user "Run ls", assistant [tool_use], user [tool_result], assistant "Done"
      expect(history.length).toBeGreaterThanOrEqual(4);

      const assistantWithToolUse = history.find(
        (m: any) =>
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((b: any) => b.type === "tool_use"),
      );
      expect(assistantWithToolUse).toBeDefined();

      const userWithToolResult = history.find(
        (m: any) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some((b: any) => b.type === "tool_result"),
      );
      expect(userWithToolResult).toBeDefined();
    });

    it("resume then send: the API request includes previous messages (THE BUG TEST)", async () => {
      // Simulate a session that was previously used, with stored messages in the DB
      const created = await provider.createSession({});
      store.addMessage(created.id, "user", "First question");
      store.addMessage(created.id, "assistant", "First answer");

      // Simulate a fresh process — clear in-memory state
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);

      // Now send a new message
      await collect(provider.send(created, "Second question", []));

      // Verify the fetch call body contains the restored history
      expect(mockFetch).toHaveBeenCalled();
      const lastCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(lastCall[1].body);

      // The messages array should contain: restored user, restored assistant, new user
      expect(requestBody.messages).toHaveLength(3);
      expect(requestBody.messages[0]).toEqual({ role: "user", content: "First question" });
      expect(requestBody.messages[1]).toEqual({ role: "assistant", content: "First answer" });
      expect(requestBody.messages[2]).toEqual({ role: "user", content: "Second question" });
    });

    it("resume then send: fetch body includes ALL restored messages in order", async () => {
      const created = await provider.createSession({});
      store.addMessage(created.id, "user", "msg-1");
      store.addMessage(created.id, "assistant", "reply-1");
      store.addMessage(created.id, "user", "msg-2");
      store.addMessage(created.id, "assistant", "reply-2");
      store.addMessage(created.id, "user", "msg-3");
      store.addMessage(created.id, "assistant", "reply-3");

      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);

      await collect(provider.send(created, "msg-4", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.messages).toHaveLength(7); // 6 restored + 1 new
      expect(requestBody.messages[0].content).toBe("msg-1");
      expect(requestBody.messages[5].content).toBe("reply-3");
      expect(requestBody.messages[6].content).toBe("msg-4");
    });

    it("multiple resume/send cycles maintain correct history", async () => {
      // First session: create and send
      const created = await provider.createSession({});
      store.addMessage(created.id, "user", "Turn 1");
      store.addMessage(created.id, "assistant", "Reply 1");

      // First resume
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);
      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 2"));
      await collect(provider.send(created, "Turn 2", []));

      // Verify first resume+send
      let requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.messages).toHaveLength(3);

      // After send, in-memory history should have: Turn1, Reply1, Turn2, Reply2 (from Hello response)
      // Actually the text response is "Reply 2" from our mock
      const historyAfterFirst = (provider as any).conversationHistory.get(created.id);
      expect(historyAfterFirst).toHaveLength(4);

      // Simulate persisting and resuming again (without clearing)
      // Send again — should have accumulated history
      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 3"));
      await collect(provider.send(created, "Turn 3", []));

      requestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      // Should include: Turn1, Reply1, Turn2, Reply2, Turn3
      expect(requestBody.messages).toHaveLength(5);
      expect(requestBody.messages[4].content).toBe("Turn 3");
    });

    it("resume reconstructs tool messages into history", async () => {
      const created = await provider.createSession({});
      store.addMessage(created.id, "user", "Run command");
      store.addMessage(created.id, "assistant", "Running...", { toolCalls: JSON.stringify([{ id: "tc1", name: "remote_exec", args: { command: "ls" } }]) });
      store.addMessage(created.id, "tool", "file.txt", { toolCalls: JSON.stringify({ callId: "tc1", isError: false }) });
      store.addMessage(created.id, "system", "system msg"); // system still skipped

      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id);

      const history = (provider as any).conversationHistory.get(created.id);
      expect(history).toHaveLength(3); // user + assistant(with tool_use) + user(tool_result)
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("assistant");
      expect(history[2].role).toBe("user"); // tool_result wrapped in user message
    });

    it("multiple sends accumulate in history", async () => {
      const session = await provider.createSession({});

      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 1"));
      await collect(provider.send(session, "msg 1", []));

      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 2"));
      await collect(provider.send(session, "msg 2", []));

      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply 3"));
      await collect(provider.send(session, "msg 3", []));

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(6); // 3 user + 3 assistant
      expect(history[0].content).toBe("msg 1");
      expect(history[1].content).toBe("Reply 1");
      expect(history[4].content).toBe("msg 3");
      expect(history[5].content).toBe("Reply 3");
    });

    it("resetHistory replaces entire history with briefing + ACK", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("reply"));
      await collect(provider.send(session, "old message", []));

      provider.resetHistory(session, "Here is your memory checkpoint");

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: "user", content: "Here is your memory checkpoint" });
      expect(history[1]).toEqual({ role: "assistant", content: CHECKPOINT_ACK });
    });

    it("after resetHistory + send, only briefing + ACK + new message in history", async () => {
      const session = await provider.createSession({});

      // Send some messages first
      mockFetch.mockResolvedValueOnce(textSSEResponse("old reply"));
      await collect(provider.send(session, "old msg", []));

      provider.resetHistory(session, "Briefing");

      mockFetch.mockResolvedValueOnce(textSSEResponse("new reply"));
      await collect(provider.send(session, "new msg", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(requestBody.messages).toHaveLength(3);
      expect(requestBody.messages[0].content).toBe("Briefing");
      expect(requestBody.messages[1].content).toBe(CHECKPOINT_ACK);
      expect(requestBody.messages[2].content).toBe("new msg");
    });

    it("attachment data is stripped from history after send", async () => {
      const session = await provider.createSession({});
      const longData = "A".repeat(200);
      const attachments = [
        { filename: "img.png", mediaType: "image/png", data: longData },
      ];
      await collect(provider.send(session, "Look at this", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      // The first user message should have had its image block stripped
      const firstUser = history[0];
      expect(Array.isArray(firstUser.content)).toBe(true);
      const imageBlock = firstUser.content.find((b: any) => b.type === "image");
      // Should be replaced with text placeholder
      expect(imageBlock).toBeUndefined();
      const textPlaceholder = firstUser.content.find((b: any) =>
        typeof b.text === "string" && b.text.includes("stripped"),
      );
      expect(textPlaceholder).toBeDefined();
    });

    it("image attachments create multimodal content blocks in user message", async () => {
      const session = await provider.createSession({});
      const attachments = [
        { filename: "img.png", mediaType: "image/png", data: "abc" },
      ];

      await collect(provider.send(session, "describe this", [], attachments));

      // Check the fetch request body
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userMsg = requestBody.messages[0];
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content[0].type).toBe("image");
      expect(userMsg.content[0].source.type).toBe("base64");
      expect(userMsg.content[1].type).toBe("text");
      expect(userMsg.content[1].text).toBe("describe this");
    });

    it("PDF attachments create document content blocks", async () => {
      const session = await provider.createSession({});
      const attachments = [
        { filename: "doc.pdf", mediaType: "application/pdf", data: "pdf-data" },
      ];

      await collect(provider.send(session, "read this", [], attachments));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userMsg = requestBody.messages[0];
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content[0].type).toBe("document");
      expect(userMsg.content[0].source.media_type).toBe("application/pdf");
    });

    it("resumed session history is correctly sent on first API call after resume", async () => {
      // This is a regression test for the critical bug:
      // When resuming, the history was not being sent with the API request.
      const created = await provider.createSession({});

      // Simulate 5 turns of conversation stored in DB
      for (let i = 1; i <= 5; i++) {
        store.addMessage(created.id, "user", `User turn ${i}`);
        store.addMessage(created.id, "assistant", `Assistant turn ${i}`);
      }

      // Fresh process resume
      (provider as any).conversationHistory.delete(created.id);
      await provider.resumeSession(created.id, "System prompt");

      // Send a new message
      await collect(provider.send(created, "New question", []));

      // The API call must include all 10 restored messages + the new one
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.messages).toHaveLength(11);
      expect(requestBody.messages[0]).toEqual({ role: "user", content: "User turn 1" });
      expect(requestBody.messages[9]).toEqual({ role: "assistant", content: "Assistant turn 5" });
      expect(requestBody.messages[10]).toEqual({ role: "user", content: "New question" });
      expect(requestBody.system).toBe("System prompt");
    });

    it("tool result multimodal content is handled correctly", async () => {
      const multimodalResult = JSON.stringify({
        __multimodal: true,
        text: "Here is the chart",
        attachments: [{ mediaType: "image/png", data: "chartdata" }],
      });
      const tool = makeTool("plot", vi.fn().mockResolvedValue(multimodalResult));

      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "tc-1", name: "plot", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Plot data", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      // Find the tool_result with multimodal content
      const toolResultMsg = history.find(
        (m: any) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some((b: any) => b.type === "tool_result"),
      );
      expect(toolResultMsg).toBeDefined();
      const trBlock = toolResultMsg.content.find((b: any) => b.type === "tool_result");
      expect(Array.isArray(trBlock.content)).toBe(true);
      // Image block data should be stripped since it's > 100 chars... well "chartdata" is only 9 chars
      // The content should have image + text blocks
      expect(trBlock.content.some((b: any) => b.type === "image")).toBe(true);
    });
  });

  // ========== Send / Streaming ==========

  describe("Send / Streaming", () => {
    it("send() yields text events for streaming deltas", async () => {
      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "hi", []));
      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBeGreaterThanOrEqual(1);
      expect(textEvents[0].delta).toBe("Hello");
    });

    it("send() yields done event with usage stats", async () => {
      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "hi", []));
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("send() yields tool_call events for tool_use blocks", async () => {
      const tool = makeTool("my_tool");
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "tc-1", name: "my_tool", args: { input: "x" } }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Final"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "use tool", [tool]));

      const toolCallEvents = events.filter((e) => e.type === "tool_call");
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0].name).toBe("my_tool");
      expect(toolCallEvents[0].args).toEqual({ input: "x" });
    });

    it("send() executes tools and yields tool_result events", async () => {
      const tool = makeTool("my_tool", vi.fn().mockResolvedValue("executed!"));
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "tc-1", name: "my_tool", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Ok"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "run", [tool]));

      const resultEvents = events.filter((e) => e.type === "tool_result");
      expect(resultEvents.length).toBeGreaterThanOrEqual(1);
      expect(resultEvents[0].result).toBe("executed!");
      expect(resultEvents[0].callId).toBe("tc-1");
    });

    it("unknown tool returns error result", async () => {
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "tc-1", name: "nonexistent", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Ok"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "run", []));

      const resultEvents = events.filter((e) => e.type === "tool_result");
      expect(resultEvents[0].result).toBe("Unknown tool: nonexistent");
      expect(resultEvents[0].isError).toBe(true);
    });

    it("tool execution error is caught and returned as error result", async () => {
      const tool = makeTool("broken", vi.fn().mockRejectedValue(new Error("tool broke")));
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "tc-1", name: "broken", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Ok"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "run", [tool]));

      const resultEvents = events.filter((e) => e.type === "tool_result");
      expect(resultEvents[0].result).toContain("Error:");
      expect(resultEvents[0].isError).toBe(true);
    });

    it("tool execution timeout after 300s", async () => {
      vi.useFakeTimers();
      const neverResolve = new Promise<string>(() => {});
      const tool = makeTool("slow", vi.fn().mockReturnValue(neverResolve));
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "tc-1", name: "slow", args: {} }]),
        )
        .mockResolvedValueOnce(textSSEResponse("Ok"));

      const session = await provider.createSession({});
      const genPromise = collect(provider.send(session, "run", [tool]));

      // Advance past the 300s timeout
      await vi.advanceTimersByTimeAsync(300_001);

      const events = await genPromise;
      const resultEvents = events.filter((e) => e.type === "tool_result");
      expect(resultEvents[0].result).toContain("timed out");
      expect(resultEvents[0].isError).toBe(true);

      vi.useRealTimers();
    });

    it("server tool calls (web_search) yield events", async () => {
      const events: Record<string, unknown>[] = [
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "st-1", name: "web_search" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"query":"test"}' },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "web_search_tool_result" },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "text" },
        },
        { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Search result" } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      mockFetch.mockResolvedValueOnce(mockSSEResponse(events));

      const session = await provider.createSession({});
      const webTool = { name: "web_search", description: "search", parameters: { type: "object" as const, properties: {}, required: [] }, execute: vi.fn() };
      const result = await collect(provider.send(session, "search for X", [webTool]));

      const toolCalls = result.filter((e) => e.type === "tool_call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("web_search");

      const toolResults = result.filter((e) => e.type === "tool_result");
      expect(toolResults[0].result).toBe("(server-executed)");
    });

    it("retry on transient error (429)", async () => {
      const error429 = new Response("rate limited", { status: 429 });
      mockFetch
        .mockResolvedValueOnce(error429)
        .mockResolvedValueOnce(textSSEResponse("OK after retry"));

      vi.useFakeTimers();
      const session = await provider.createSession({});
      const genPromise = collect(provider.send(session, "hi", []));
      await vi.advanceTimersByTimeAsync(2000);
      const events = await genPromise;
      vi.useRealTimers();

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retry on transient error (500)", async () => {
      const error500 = new Response("server error", { status: 500 });
      mockFetch
        .mockResolvedValueOnce(error500)
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

    it("non-transient error (400) throws immediately", async () => {
      mockFetch.mockResolvedValueOnce(new Response("bad request", { status: 400 }));

      const session = await provider.createSession({});
      await expect(collect(provider.send(session, "hi", []))).rejects.toThrow("400");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("overloaded SSE error is transient and retried", async () => {
      const overloadedResponse = mockSSEResponse([
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]);
      mockFetch
        .mockResolvedValueOnce(overloadedResponse)
        .mockResolvedValueOnce(textSSEResponse("OK"));

      vi.useFakeTimers();
      const session = await provider.createSession({});
      const genPromise = collect(provider.send(session, "hi", []));
      await vi.advanceTimersByTimeAsync(2000);
      const events = await genPromise;
      vi.useRealTimers();

      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    it("empty response yields done with no usage", async () => {
      // An empty SSE stream still produces a complete event from streamRawApi
      // but with empty text and no usage — the provider yields done with undefined usage
      const emptyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(
        new Response(emptyStream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "hi", []));
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent.usage).toBeUndefined();
    });

    it("null body response throws error", async () => {
      // A response with null body causes parseSSELines to throw "No response body"
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );

      const session = await provider.createSession({});
      await expect(collect(provider.send(session, "hi", []))).rejects.toThrow("No response body");
    });

    it("multiple tool calls in single response", async () => {
      const tool1 = makeTool("tool_a", vi.fn().mockResolvedValue("result-a"));
      const tool2 = makeTool("tool_b", vi.fn().mockResolvedValue("result-b"));

      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([
            { id: "tc-1", name: "tool_a", args: { input: "1" } },
            { id: "tc-2", name: "tool_b", args: { input: "2" } },
          ]),
        )
        .mockResolvedValueOnce(textSSEResponse("Both done"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "run both", [tool1, tool2]));

      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].name).toBe("tool_a");
      expect(toolCalls[1].name).toBe("tool_b");

      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(2);
    });

    it("tool loop: tool calls -> results -> continue -> text -> done", async () => {
      const tool = makeTool("read_file", vi.fn().mockResolvedValue("file content"));

      // First response: tool call
      mockFetch.mockResolvedValueOnce(
        toolCallSSEResponse([{ id: "tc-1", name: "read_file", args: { input: "main.py" } }]),
      );
      // Second response: final text
      mockFetch.mockResolvedValueOnce(textSSEResponse("Here is what I found"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "read main.py", [tool]));

      // Verify the sequence of events
      const types = events.map((e) => e.type);
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
      expect(types).toContain("text");
      expect(types).toContain("done");

      // Done should be last
      expect(types[types.length - 1]).toBe("done");
    });

    it("send includes system prompt in request body", async () => {
      const session = await provider.createSession({ systemPrompt: "Be helpful" });
      await collect(provider.send(session, "hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.system).toBe("Be helpful");
    });

    it("send includes thinking budget based on reasoningEffort", async () => {
      provider.reasoningEffort = "high";
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.thinking).toEqual({ type: "enabled", budget_tokens: 50000 });
    });

    it("send includes tool definitions in request body", async () => {
      const tool = makeTool("my_tool");
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", [tool]));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.tools.some((t: any) => t.name === "my_tool")).toBe(true);
    });

    it("send sets correct headers", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-api-key"]).toBe("sk-test");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("send handles thinking content blocks silently", async () => {
      const events: Record<string, unknown>[] = [
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think..." } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Result" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      mockFetch.mockResolvedValueOnce(mockSSEResponse(events));

      const session = await provider.createSession({});
      const result = await collect(provider.send(session, "think", []));

      const textEvents = result.filter((e) => e.type === "text");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0].text).toBe("Result");
    });
  });

  // ========== Auth ==========

  describe("Auth", () => {
    it("isAuthenticated returns true when API key exists", async () => {
      const result = await provider.isAuthenticated();
      // CLI not available, falls through to authManager.isAuthenticated
      expect(result).toBe(true);
      expect(auth.isAuthenticated).toHaveBeenCalledWith("claude");
    });

    it("isAuthenticated returns false when no credentials", async () => {
      auth.isAuthenticated.mockReturnValue(false);
      const result = await provider.isAuthenticated();
      expect(result).toBe(false);
    });

    it("authenticate with preferred mode api sets api_key mode", async () => {
      const p = new ClaudeProvider(auth, "api", store);
      process.env.ANTHROPIC_API_KEY = "test-key";
      try {
        await p.authenticate();
        expect(p.currentAuthMode).toBe("api_key");
        expect(auth.setApiKey).toHaveBeenCalledWith("claude", "test-key");
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it("authenticate with preferred mode api throws if no ANTHROPIC_API_KEY", async () => {
      const p = new ClaudeProvider(auth, "api", store);
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        await expect(p.authenticate()).rejects.toThrow("ANTHROPIC_API_KEY not set");
      } finally {
        if (saved) process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    it("authenticate auto-detects API key from env", async () => {
      const p = new ClaudeProvider(auth, undefined, store);
      // Force CLI unavailable
      (p as any)._cliAvailable = false;
      process.env.ANTHROPIC_API_KEY = "env-key";
      try {
        await p.authenticate();
        expect(p.currentAuthMode).toBe("api_key");
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it("authenticate throws when no method available", async () => {
      const p = new ClaudeProvider(auth, undefined, store);
      (p as any)._cliAvailable = false;
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        await expect(p.authenticate()).rejects.toThrow("Claude auth required");
      } finally {
        if (saved) process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    it("send throws if no API key available", async () => {
      const noKeyAuth = mockAuthManager({ method: "api_key", provider: "claude", apiKey: null });
      const p = new ClaudeProvider(noKeyAuth, "api", store);
      (p as any).authMode = "api_key";

      const session = await p.createSession({});
      await expect(collect(p.send(session, "hi", []))).rejects.toThrow("No API key");
    });

    it("setPreferredAuthMode updates preferred mode", () => {
      provider.setPreferredAuthMode("cli");
      expect((provider as any).preferredAuthMode).toBe("cli");
      provider.setPreferredAuthMode("api");
      expect((provider as any).preferredAuthMode).toBe("api_key");
    });

    it("authenticate with preferred mode cli throws if not available", async () => {
      const p = new ClaudeProvider(auth, "cli", store);
      (p as any)._cliAvailable = false;
      await expect(p.authenticate()).rejects.toThrow("Claude CLI mode requested but `claude` binary not found");
    });
  });

  // ========== Utility Methods ==========

  describe("Utility Methods", () => {
    it("stripMcpPrefix removes mcp__helios__ prefix", () => {
      const result = (provider as any).stripMcpPrefix("mcp__helios__remote_exec");
      expect(result).toBe("remote_exec");
    });

    it("stripMcpPrefix leaves non-prefixed names unchanged", () => {
      const result = (provider as any).stripMcpPrefix("remote_exec");
      expect(result).toBe("remote_exec");
    });

    it("stripMcpPrefix handles empty string", () => {
      const result = (provider as any).stripMcpPrefix("");
      expect(result).toBe("");
    });

    it("stripMcpPrefix handles partial prefix", () => {
      const result = (provider as any).stripMcpPrefix("mcp__other__tool");
      expect(result).toBe("mcp__other__tool");
    });

    it("buildZodSchema handles string type", () => {
      const tool = makeTool("t");
      const schema = (provider as any).buildZodSchema(tool);
      expect(schema.input).toBeDefined();
    });

    it("buildZodSchema handles number type", () => {
      const tool = {
        name: "t",
        description: "d",
        parameters: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      };
      const schema = (provider as any).buildZodSchema(tool);
      expect(schema.count).toBeDefined();
    });

    it("buildZodSchema handles boolean type", () => {
      const tool = {
        name: "t",
        description: "d",
        parameters: {
          type: "object",
          properties: { flag: { type: "boolean" } },
          required: ["flag"],
        },
      };
      const schema = (provider as any).buildZodSchema(tool);
      expect(schema.flag).toBeDefined();
    });

    it("buildZodSchema handles array type", () => {
      const tool = {
        name: "t",
        description: "d",
        parameters: {
          type: "object",
          properties: { items: { type: "array" } },
          required: ["items"],
        },
      };
      const schema = (provider as any).buildZodSchema(tool);
      expect(schema.items).toBeDefined();
    });

    it("buildZodSchema handles object type", () => {
      const tool = {
        name: "t",
        description: "d",
        parameters: {
          type: "object",
          properties: { config: { type: "object" } },
          required: ["config"],
        },
      };
      const schema = (provider as any).buildZodSchema(tool);
      expect(schema.config).toBeDefined();
    });

    it("buildZodSchema handles enum types", () => {
      const tool = {
        name: "t",
        description: "d",
        parameters: {
          type: "object",
          properties: { mode: { type: "string", enum: ["fast", "slow"] } },
          required: ["mode"],
        },
      };
      const schema = (provider as any).buildZodSchema(tool);
      expect(schema.mode).toBeDefined();
    });

    it("buildZodSchema marks non-required fields as optional", () => {
      const tool = {
        name: "t",
        description: "d",
        parameters: {
          type: "object",
          properties: {
            req: { type: "string" },
            opt: { type: "string" },
          },
          required: ["req"],
        },
      };
      const schema = (provider as any).buildZodSchema(tool);
      expect(schema.req.isOptional()).toBe(false);
      expect(schema.opt.isOptional()).toBe(true);
    });

    it("buildZodSchema adds descriptions", () => {
      const tool = {
        name: "t",
        description: "d",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string", description: "The command to run" },
          },
          required: ["cmd"],
        },
      };
      const schema = (provider as any).buildZodSchema(tool);
      expect(schema.cmd.description).toBe("The command to run");
    });

    it("parseMultimodal parses valid multimodal JSON", () => {
      const json = JSON.stringify({
        __multimodal: true,
        text: "chart",
        attachments: [{ mediaType: "image/png", data: "abc" }],
      });
      const result = (provider as any).parseMultimodal(json);
      expect(result).not.toBeNull();
      expect(result.text).toBe("chart");
      expect(result.attachments).toHaveLength(1);
    });

    it("parseMultimodal returns null for non-multimodal JSON", () => {
      const result = (provider as any).parseMultimodal(JSON.stringify({ hello: "world" }));
      expect(result).toBeNull();
    });

    it("parseMultimodal returns null for non-JSON strings", () => {
      const result = (provider as any).parseMultimodal("just plain text");
      expect(result).toBeNull();
    });

    it("parseMultimodal returns null for empty string", () => {
      const result = (provider as any).parseMultimodal("");
      expect(result).toBeNull();
    });
  });

  // ========== mapSdkMessage ==========

  describe("mapSdkMessage", () => {
    it("maps assistant message to tool_call events", () => {
      const msg = {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me run that" },
            { type: "tool_use", id: "tu-1", name: "mcp__helios__remote_exec", input: { cmd: "ls" } },
          ],
        },
      };
      const events = [...(provider as any).mapSdkMessage(msg)];
      const toolCalls = events.filter((e: any) => e.type === "tool_call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("remote_exec"); // prefix stripped
      expect(toolCalls[0].args).toEqual({ cmd: "ls" });
    });

    it("maps stream_event text_delta to text events", () => {
      const msg = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello world" },
        },
      };
      const events = [...(provider as any).mapSdkMessage(msg)];
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("text");
      expect(events[0].delta).toBe("Hello world");
    });

    it("maps result success to done event with usage", () => {
      const msg = {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.01,
      };
      const events = [...(provider as any).mapSdkMessage(msg)];
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("done");
      expect(events[0].usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.01,
      });
    });

    it("maps result error to error + done events", () => {
      const msg = {
        type: "result",
        subtype: "error",
        errors: ["Something went wrong", "Another error"],
      };
      const events = [...(provider as any).mapSdkMessage(msg)];
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("error");
      expect(events[0].error.message).toContain("Something went wrong");
      expect(events[1].type).toBe("done");
    });

    it("maps result error without errors array", () => {
      const msg = { type: "result", subtype: "error" };
      const events = [...(provider as any).mapSdkMessage(msg)];
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("error");
      expect(events[0].error.message).toContain("Unknown SDK error");
    });

    it("ignores unknown message types", () => {
      const msg = { type: "system", something: "else" };
      const events = [...(provider as any).mapSdkMessage(msg)];
      expect(events).toHaveLength(0);
    });

    it("ignores non-text_delta stream events", () => {
      const msg = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
      };
      const events = [...(provider as any).mapSdkMessage(msg)];
      expect(events).toHaveLength(0);
    });
  });

  // ========== Model Configuration ==========

  describe("Model Configuration", () => {
    it("currentModel defaults to claude-opus-4-6", () => {
      expect(provider.currentModel).toBe("claude-opus-4-6");
    });

    it("reasoningEffort defaults to medium", () => {
      expect(provider.reasoningEffort).toBe("medium");
    });

    it("thinking budget maps medium to 16000", async () => {
      provider.reasoningEffort = "medium";
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.thinking.budget_tokens).toBe(16000);
    });

    it("thinking budget maps high to 50000", async () => {
      provider.reasoningEffort = "high";
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.thinking.budget_tokens).toBe(50000);
    });

    it("thinking budget maps max to 100000", async () => {
      provider.reasoningEffort = "max";
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.thinking.budget_tokens).toBe(100000);
    });

    it("thinking disabled when effort is none (budget 0)", async () => {
      provider.reasoningEffort = "none";
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // budget is 0, so thinking should not be included
      expect(body.thinking).toBeUndefined();
    });

    it("max_tokens is at least budgetTokens + 8192", async () => {
      provider.reasoningEffort = "max";
      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", []));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_tokens).toBeGreaterThanOrEqual(100000 + 8192);
    });

    it("currentModel can be changed", () => {
      provider.currentModel = "claude-sonnet-4-6";
      expect(provider.currentModel).toBe("claude-sonnet-4-6");
    });
  });

  // ========== Interrupt ==========

  describe("Interrupt", () => {
    it("interrupt aborts active request via AbortController", () => {
      const ac = new AbortController();
      (provider as any).abortController = ac;
      const session = makeSession();

      provider.interrupt(session);

      expect(ac.signal.aborted).toBe(true);
      expect((provider as any).abortController).toBeNull();
    });

    it("interrupt clears abort controller", () => {
      (provider as any).abortController = new AbortController();
      const session = makeSession();
      provider.interrupt(session);
      expect((provider as any).abortController).toBeNull();
    });

    it("interrupt is safe when no active request", () => {
      const session = makeSession();
      // Should not throw
      provider.interrupt(session);
      expect((provider as any).abortController).toBeNull();
    });

    it("interrupt calls activeQuery.interrupt for CLI mode", () => {
      const mockQuery = { interrupt: vi.fn(), close: vi.fn() };
      (provider as any).activeQuery = mockQuery;
      const session = makeSession();
      provider.interrupt(session);
      expect(mockQuery.interrupt).toHaveBeenCalled();
    });
  });

  // ========== Provider Metadata ==========

  describe("Provider Metadata", () => {
    it("name is claude", () => {
      expect(provider.name).toBe("claude");
    });

    it("displayName is Claude", () => {
      expect(provider.displayName).toBe("Claude");
    });
  });

  // ========== Web Search Tool Filtering ==========

  describe("Web Search Tool Filtering", () => {
    it("web_search tool is excluded from function tools in request", async () => {
      const webTool = {
        name: "web_search",
        description: "Search",
        parameters: { type: "object", properties: {}, required: [] },
        execute: vi.fn(),
      };
      const regularTool = makeTool("regular");

      const session = await provider.createSession({});
      await collect(provider.send(session, "hi", [webTool, regularTool]));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const functionToolNames = body.tools
        .filter((t: any) => t.name && t.name !== "web_search")
        .map((t: any) => t.name);
      expect(functionToolNames).toContain("regular");
      // web_search should be present as a special type
      expect(body.tools.some((t: any) => t.type === "web_search_20250305")).toBe(true);
    });
  });
});
