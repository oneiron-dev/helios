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

function webSearchSSEResponse(searchId: string, text = "Search result"): Response {
  return mockSSEResponse([
    {
      type: "response.output_item.done",
      item: { type: "web_search_call", id: searchId },
    },
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
      response: { usage: { input_tokens: 15, output_tokens: 10 } },
    },
  ]);
}

/** Text-only delta with no output_item.done for assistant message. */
function textOnlyDeltaSSEResponse(text: string): Response {
  return mockSSEResponse([
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 10, output_tokens: 5 } },
    },
  ]);
}

function emptySSEResponse(): Response {
  return mockSSEResponse([
    {
      type: "response.completed",
      response: { usage: { input_tokens: 5, output_tokens: 0 } },
    },
  ]);
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

// ─── Tests ───────────────────────────────────────────

describe("OpenAIProvider — History Deep Edge Cases", () => {
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

  // ========== Basic History Lifecycle ==========

  describe("Basic History Lifecycle", () => {
    it("history starts empty on createSession", async () => {
      const session = await provider.createSession({});
      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toEqual([]);
    });

    it("first send adds user message with input_text content", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hello world", []));
      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history.find(
        (m: any) => m.type === "message" && m.role === "user",
      );
      expect(userMsg).toBeDefined();
      expect(userMsg.content.some((c: any) => c.type === "input_text" && c.text === "Hello world")).toBe(true);
    });

    it("text response adds assistant message with output_text", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));
      const history = (provider as any).conversationHistory.get(session.id);
      const assistantMsg = history.find(
        (m: any) => m.type === "message" && m.role === "assistant",
      );
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.content.some((c: any) => c.type === "output_text")).toBe(true);
    });

    it("multiple sends accumulate history", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("R1"));
      await collect(provider.send(session, "Q1", []));
      mockFetch.mockResolvedValueOnce(textSSEResponse("R2"));
      await collect(provider.send(session, "Q2", []));

      const history = (provider as any).conversationHistory.get(session.id);
      // 2 user + 2 assistant = 4 message items
      const messageItems = history.filter((m: any) => m.type === "message");
      expect(messageItems).toHaveLength(4);
    });

    it("history grows correctly across 10+ sends", async () => {
      const session = await provider.createSession({});
      for (let i = 0; i < 12; i++) {
        mockFetch.mockResolvedValueOnce(textSSEResponse(`R${i}`));
        await collect(provider.send(session, `Q${i}`, []));
      }
      const history = (provider as any).conversationHistory.get(session.id);
      const messageItems = history.filter((m: any) => m.type === "message");
      expect(messageItems).toHaveLength(24); // 12 user + 12 assistant
    });
  });

  // ========== Tool Call History ==========

  describe("Tool Call History", () => {
    it("tool call adds function_call item to history", async () => {
      const tool = makeTool("run_cmd");
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ call_id: "fc-1", name: "run_cmd", args: { input: "ls" } }]))
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Run ls", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      const funcCall = history.find((m: any) => m.type === "function_call");
      expect(funcCall).toBeDefined();
      expect(funcCall.name).toBe("run_cmd");
      expect(funcCall.call_id).toBe("fc-1");
    });

    it("tool result adds function_call_output item", async () => {
      const tool = makeTool("run_cmd");
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ call_id: "fc-1", name: "run_cmd", args: { input: "ls" } }]))
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Run ls", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      const funcOutput = history.find((m: any) => m.type === "function_call_output");
      expect(funcOutput).toBeDefined();
      expect(funcOutput.call_id).toBe("fc-1");
    });

    it("multiple tool calls create multiple function_call items", async () => {
      const tool1 = makeTool("tool_a");
      const tool2 = makeTool("tool_b");
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([
            { call_id: "fc-1", name: "tool_a", args: { input: "x" } },
            { call_id: "fc-2", name: "tool_b", args: { input: "y" } },
          ]),
        )
        .mockResolvedValueOnce(textSSEResponse("Both done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Run both", [tool1, tool2]));

      const history = (provider as any).conversationHistory.get(session.id);
      const funcCalls = history.filter((m: any) => m.type === "function_call");
      expect(funcCalls).toHaveLength(2);
    });

    it("history after tool loop has correct item ordering", async () => {
      const tool = makeTool("run_cmd");
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ call_id: "fc-1", name: "run_cmd", args: { input: "ls" } }]))
        .mockResolvedValueOnce(toolCallSSEResponse([{ call_id: "fc-2", name: "run_cmd", args: { input: "cat" } }]))
        .mockResolvedValueOnce(textSSEResponse("All done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Read files", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      // Expected: user msg, function_call, function_call_output, function_call, function_call_output, assistant msg
      const types = history.map((m: any) => m.type);
      expect(types[0]).toBe("message"); // user
      expect(types).toContain("function_call");
      expect(types).toContain("function_call_output");
      // Final item should be assistant message
      const lastMsg = history[history.length - 1];
      expect(lastMsg.type).toBe("message");
      expect(lastMsg.role).toBe("assistant");
    });

    it("multimodal tool results inject extra user message with images", async () => {
      const multimodalResult = JSON.stringify({
        __multimodal: true,
        text: "Chart data",
        attachments: [{ mediaType: "image/png", data: "base64data" }],
      });
      const tool = makeTool("plot_tool", vi.fn().mockResolvedValue(multimodalResult));
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ call_id: "fc-m", name: "plot_tool", args: { input: "plot" } }]))
        .mockResolvedValueOnce(textSSEResponse("Here's the chart"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Make a chart", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      // Should have an extra user message with input_image content
      const multimodalUser = history.find(
        (m: any) =>
          m.type === "message" &&
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) => c.type === "input_image"),
      );
      expect(multimodalUser).toBeDefined();
    });

    it("web search calls tracked separately via serverToolIds", async () => {
      mockFetch.mockResolvedValueOnce(webSearchSSEResponse("ws-1", "Search results"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "Search ML papers", []));

      // Should emit tool_call and tool_result events for the web search
      const toolCallEvent = events.find((e: any) => e.type === "tool_call" && e.name === "web_search");
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent.id).toBe("ws-1");
    });
  });

  // ========== Resume ==========

  describe("Resume", () => {
    it("resume loads messages from DB as input_text/output_text", async () => {
      const session = await provider.createSession({});
      store.addMessage(session.id, "user", "Stored Q");
      store.addMessage(session.id, "assistant", "Stored A");

      (provider as any).conversationHistory.delete(session.id);
      await provider.resumeSession(session.id);

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Stored Q" }],
      });
      expect(history[1]).toEqual({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Stored A" }],
      });
    });

    it("resume reconstructs tool messages and skips system", async () => {
      const session = await provider.createSession({});
      store.addMessage(session.id, "system", "Sys");
      store.addMessage(session.id, "user", "User msg");
      store.addMessage(session.id, "tool", "Tool msg", { toolCalls: JSON.stringify({ callId: "tc1", isError: false }) });
      store.addMessage(session.id, "assistant", "Asst msg");

      (provider as any).conversationHistory.delete(session.id);
      await provider.resumeSession(session.id);

      const history = (provider as any).conversationHistory.get(session.id);
      // system skipped, tool becomes function_call_output
      expect(history).toHaveLength(3);
      expect(history[0].type).toBe("message"); // user
      expect(history[1].type).toBe("function_call_output"); // tool
      expect(history[2].type).toBe("message"); // assistant
    });

    it("resume then send includes full history in API request body", async () => {
      const session = await provider.createSession({});
      store.addMessage(session.id, "user", "Prev Q");
      store.addMessage(session.id, "assistant", "Prev A");

      (provider as any).conversationHistory.delete(session.id);
      await provider.resumeSession(session.id);

      mockFetch.mockResolvedValueOnce(textSSEResponse("New answer"));
      await collect(provider.send(session, "New Q", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.input).toHaveLength(3);
      expect(requestBody.input[0].content[0].text).toBe("Prev Q");
      expect(requestBody.input[1].content[0].text).toBe("Prev A");
      expect(requestBody.input[2].content[0].text).toBe("New Q");
    });

    it("resume does not overwrite existing in-memory history", async () => {
      const session = await provider.createSession({});
      const existing = [{ type: "message", role: "user", content: [{ type: "input_text", text: "cached" }] }];
      (provider as any).conversationHistory.set(session.id, existing);

      store.addMessage(session.id, "user", "from DB");
      await provider.resumeSession(session.id);

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(1);
      expect(history[0].content[0].text).toBe("cached");
    });
  });

  // ========== resetHistory / Checkpoint ==========

  describe("resetHistory / Checkpoint", () => {
    it("resetHistory creates briefing exchange with input_text/output_text", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("R1"));
      await collect(provider.send(session, "Q1", []));

      provider.resetHistory(session, "=== CHECKPOINT ===");

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "=== CHECKPOINT ===" }],
      });
      expect(history[1]).toEqual({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: CHECKPOINT_ACK }],
      });
    });

    it("after resetHistory, only briefing + new messages remain", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("R1"));
      await collect(provider.send(session, "Q1", []));
      mockFetch.mockResolvedValueOnce(textSSEResponse("R2"));
      await collect(provider.send(session, "Q2", []));

      provider.resetHistory(session, "Briefing");

      mockFetch.mockResolvedValueOnce(textSSEResponse("R3"));
      await collect(provider.send(session, "Q3", []));

      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      const requestBody = JSON.parse(lastCall[1].body);
      // briefing (user), ack (assistant), new message (user)
      expect(requestBody.input).toHaveLength(3);
      expect(requestBody.input[0].content[0].text).toBe("Briefing");
      expect(requestBody.input[1].content[0].text).toBe(CHECKPOINT_ACK);
      expect(requestBody.input[2].content[0].text).toBe("Q3");
    });
  });

  // ========== Attachments ==========

  describe("Attachments", () => {
    it("image attachment creates input_image content with data URL", async () => {
      const session = await provider.createSession({});
      const attachments = [{ filename: "photo.png", mediaType: "image/png", data: "iVBOR" }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Nice"));
      await collect(provider.send(session, "Describe", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history.find((m: any) => m.type === "message" && m.role === "user");
      const imageItem = userMsg.content.find((c: any) => c.type === "input_image");
      expect(imageItem).toBeDefined();
      expect(imageItem.image_url).toBe("data:image/png;base64,iVBOR");
    });

    it("non-image attachment creates input_file content", async () => {
      const session = await provider.createSession({});
      const attachments = [{ filename: "data.csv", mediaType: "text/csv", data: "YSxi" }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Got it"));
      await collect(provider.send(session, "Parse", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history.find((m: any) => m.type === "message" && m.role === "user");
      const fileItem = userMsg.content.find((c: any) => c.type === "input_file");
      expect(fileItem).toBeDefined();
      expect(fileItem.filename).toBe("data.csv");
      expect(fileItem.file_data).toBe("data:text/csv;base64,YSxi");
    });

    it("attachment data URL format is correct (data:type;base64,...)", async () => {
      const session = await provider.createSession({});
      const attachments = [{ filename: "img.jpeg", mediaType: "image/jpeg", data: "abc123" }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("OK"));
      await collect(provider.send(session, "Look", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history[0];
      const imageItem = userMsg.content.find((c: any) => c.type === "input_image");
      expect(imageItem.image_url).toMatch(/^data:image\/jpeg;base64,.+$/);
    });
  });

  // ========== stripAttachmentData ==========

  describe("stripAttachmentData", () => {
    it("replaces large input_image (>200 chars)", async () => {
      const session = await provider.createSession({});
      const bigData = "x".repeat(250);
      const attachments = [{ filename: "big.png", mediaType: "image/png", data: bigData }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Got it"));
      await collect(provider.send(session, "Analyze", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history.find((m: any) => m.type === "message" && m.role === "user");
      const stripped = userMsg.content.find((c: any) => c.type === "input_text" && c.text.includes("stripped"));
      expect(stripped).toBeDefined();
      expect(stripped.text).toBe("[image stripped]");
    });

    it("replaces large input_file", async () => {
      const session = await provider.createSession({});
      const bigData = "x".repeat(250);
      const attachments = [{ filename: "big.csv", mediaType: "text/csv", data: bigData }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("OK"));
      await collect(provider.send(session, "Parse", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history.find((m: any) => m.type === "message" && m.role === "user");
      const stripped = userMsg.content.find((c: any) => c.type === "input_text" && c.text.includes("stripped"));
      expect(stripped).toBeDefined();
      expect(stripped.text).toBe("[file stripped]");
    });

    it("preserves small content", async () => {
      const session = await provider.createSession({});
      const smallData = "abc"; // very small
      const attachments = [{ filename: "tiny.png", mediaType: "image/png", data: smallData }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Tiny"));
      await collect(provider.send(session, "Show", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history[0];
      // data URL is "data:image/png;base64,abc" which is < 200 chars
      const imageItem = userMsg.content.find((c: any) => c.type === "input_image");
      expect(imageItem).toBeDefined();
      expect(imageItem.image_url).toContain("abc");
    });
  });

  // ========== Instructions ==========

  describe("Instructions", () => {
    it("instructions stored per session", async () => {
      const s1 = await provider.createSession({ systemPrompt: "Prompt A" });
      const s2 = await provider.createSession({ systemPrompt: "Prompt B" });

      expect((provider as any).instructions.get(s1.id)).toBe("Prompt A");
      expect((provider as any).instructions.get(s2.id)).toBe("Prompt B");
    });

    it("default instructions when none set", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.instructions).toBe("You are a helpful assistant.");
    });

    it("instructions from session config sent in API request", async () => {
      const session = await provider.createSession({ systemPrompt: "You are a scientist" });
      await collect(provider.send(session, "Hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.instructions).toBe("You are a scientist");
    });
  });

  // ========== Session Isolation ==========

  describe("Session Isolation", () => {
    it("closeSession clears history", async () => {
      const session = await provider.createSession({ systemPrompt: "test" });
      mockFetch.mockResolvedValueOnce(textSSEResponse("Hi"));
      await collect(provider.send(session, "Hello", []));

      await provider.closeSession(session);
      expect((provider as any).conversationHistory.has(session.id)).toBe(false);
      expect((provider as any).instructions.has(session.id)).toBe(false);
    });

    it("closeSession does not affect other sessions", async () => {
      const s1 = await provider.createSession({});
      const s2 = await provider.createSession({});

      mockFetch.mockResolvedValueOnce(textSSEResponse("R1"));
      await collect(provider.send(s1, "M1", []));
      mockFetch.mockResolvedValueOnce(textSSEResponse("R2"));
      await collect(provider.send(s2, "M2", []));

      await provider.closeSession(s1);

      expect((provider as any).conversationHistory.has(s1.id)).toBe(false);
      expect((provider as any).conversationHistory.has(s2.id)).toBe(true);
    });
  });

  // ========== Synthesized Assistant Message ==========

  describe("Synthesized Assistant Message", () => {
    it("if text but no assistant message item emitted, one is synthesized", async () => {
      mockFetch.mockResolvedValueOnce(textOnlyDeltaSSEResponse("Synthesized text"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));

      const history = (provider as any).conversationHistory.get(session.id);
      const assistantMsg = history.find(
        (m: any) => m.type === "message" && m.role === "assistant",
      );
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.content[0]).toEqual({ type: "output_text", text: "Synthesized text" });
    });

    it("empty response with no text does not add assistant message", async () => {
      mockFetch.mockResolvedValueOnce(emptySSEResponse());

      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));

      const history = (provider as any).conversationHistory.get(session.id);
      const assistantMsgs = history.filter(
        (m: any) => m.type === "message" && m.role === "assistant",
      );
      // No text was emitted, so the synthesized assistant message should not be created
      expect(assistantMsgs).toHaveLength(0);
    });
  });

  // ========== API Request Structure ==========

  describe("API Request Structure", () => {
    it("reasoning effort is sent in request body", async () => {
      const session = await provider.createSession({});
      provider.reasoningEffort = "high";
      await collect(provider.send(session, "Think hard", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.reasoning).toEqual({ effort: "high" });
    });

    it("model is sent in request body", async () => {
      const session = await provider.createSession({});
      provider.currentModel = "gpt-5.3-codex";
      await collect(provider.send(session, "Code", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.model).toBe("gpt-5.3-codex");
    });

    it("tools are formatted as function type", async () => {
      const tool = makeTool("run_cmd");
      const session = await provider.createSession({});
      await collect(provider.send(session, "Run", [tool]));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const funcTools = requestBody.tools.filter((t: any) => t.type === "function");
      expect(funcTools).toHaveLength(1);
      expect(funcTools[0].name).toBe("run_cmd");
    });

    it("web_search tool is formatted as web_search type", async () => {
      const wsTool = makeTool("web_search");
      const session = await provider.createSession({});
      await collect(provider.send(session, "Search", [wsTool]));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const wsTools = requestBody.tools.filter((t: any) => t.type === "web_search");
      expect(wsTools).toHaveLength(1);
    });

    it("parallel_tool_calls is enabled", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.parallel_tool_calls).toBe(true);
    });

    it("stream is enabled", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.stream).toBe(true);
    });

    it("resume then send: restored messages included in API input", async () => {
      const session = await provider.createSession({});
      store.addMessage(session.id, "user", "Msg A");
      store.addMessage(session.id, "assistant", "Reply A");
      store.addMessage(session.id, "user", "Msg B");
      store.addMessage(session.id, "assistant", "Reply B");

      (provider as any).conversationHistory.delete(session.id);
      await provider.resumeSession(session.id);

      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply C"));
      await collect(provider.send(session, "Msg C", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.input).toHaveLength(5); // 4 restored + 1 new
      expect(requestBody.input[0].content[0].text).toBe("Msg A");
      expect(requestBody.input[4].content[0].text).toBe("Msg C");
    });

    it("tool error adds error result but continues", async () => {
      const tool = makeTool("failing", vi.fn().mockRejectedValue(new Error("Boom")));
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ call_id: "fc-err", name: "failing", args: { input: "x" } }]))
        .mockResolvedValueOnce(textSSEResponse("Handled"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "Try it", [tool]));

      const toolResult = events.find((e: any) => e.type === "tool_result" && e.isError === true);
      expect(toolResult).toBeDefined();
      expect((toolResult as any).result).toContain("Error:");

      // Should still get a final done
      expect(events.some((e: any) => e.type === "done")).toBe(true);
    });

    it("unknown tool returns error result", async () => {
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ call_id: "fc-unk", name: "nonexistent", args: {} }]))
        .mockResolvedValueOnce(textSSEResponse("OK"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "Use tool", []));

      const toolResult = events.find((e: any) => e.type === "tool_result" && e.isError);
      expect(toolResult).toBeDefined();
      expect((toolResult as any).result).toContain("Unknown tool");
    });
  });
});
