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

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not found");
  }),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(),
  tool: vi.fn(),
}));

vi.mock("../../paths.js", () => ({
  WEB_SEARCH_TOOL: "web_search",
  debugLog: vi.fn(),
}));

// ─── Imports (dynamic because of mocks) ──────────────

const { SessionStore } = await import("../../store/session-store.js");
const { ClaudeProvider } = await import("./provider.js");
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
      { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: tc.id, name: tc.name } },
      { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.args) } },
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

function serverToolSSEResponse(
  serverId: string,
  serverName: string,
  text = "Result",
): Response {
  return mockSSEResponse([
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: serverId, name: serverName } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", usage: { output_tokens: 15 } },
    { type: "message_stop" },
  ]);
}

function emptyTextSSEResponse(): Response {
  return mockSSEResponse([
    { type: "message_start", message: { usage: { input_tokens: 5 } } },
    { type: "message_delta", usage: { output_tokens: 0 } },
    { type: "message_stop" },
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
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
    execute: exec ?? vi.fn().mockResolvedValue("tool-result"),
  };
}

// ─── Tests ───────────────────────────────────────────

describe("ClaudeProvider — History Deep Edge Cases", () => {
  let store: InstanceType<typeof SessionStore>;
  let auth: ReturnType<typeof mockAuthManager>;
  let provider: InstanceType<typeof ClaudeProvider>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDb.current = createTestDb();
    store = new SessionStore();
    auth = mockAuthManager();
    provider = new ClaudeProvider(auth, "api", store);
    (provider as any).authMode = "api_key";
    (provider as any)._cliAvailable = null;

    mockFetch = vi.fn().mockResolvedValue(textSSEResponse("Hello"));
    vi.stubGlobal("fetch", mockFetch);
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

    it("first send adds user message to history", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hello world", []));
      const history = (provider as any).conversationHistory.get(session.id);
      expect(history[0]).toEqual({ role: "user", content: "Hello world" });
    });

    it("text response adds assistant message to history", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));
      const history = (provider as any).conversationHistory.get(session.id);
      const assistant = history.find((m: any) => m.role === "assistant" && m.content === "Hello");
      expect(assistant).toBeDefined();
    });

    it("empty text response does not add assistant message", async () => {
      mockFetch.mockResolvedValue(emptyTextSSEResponse());
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));
      const history = (provider as any).conversationHistory.get(session.id);
      const assistantMsgs = history.filter((m: any) => m.role === "assistant");
      expect(assistantMsgs).toHaveLength(0);
    });

    it("history preserves order across multiple sends", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply1"));
      await collect(provider.send(session, "Msg1", []));
      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply2"));
      await collect(provider.send(session, "Msg2", []));

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(4);
      expect(history[0]).toEqual({ role: "user", content: "Msg1" });
      expect(history[1]).toEqual({ role: "assistant", content: "Reply1" });
      expect(history[2]).toEqual({ role: "user", content: "Msg2" });
      expect(history[3]).toEqual({ role: "assistant", content: "Reply2" });
    });

    it("history grows correctly across 10+ sends", async () => {
      const session = await provider.createSession({});
      for (let i = 0; i < 12; i++) {
        mockFetch.mockResolvedValueOnce(textSSEResponse(`Reply-${i}`));
        await collect(provider.send(session, `Msg-${i}`, []));
      }
      const history = (provider as any).conversationHistory.get(session.id);
      // 12 user + 12 assistant = 24
      expect(history).toHaveLength(24);
    });

    it("large history (50+ messages) works correctly", async () => {
      const session = await provider.createSession({});
      for (let i = 0; i < 26; i++) {
        mockFetch.mockResolvedValueOnce(textSSEResponse(`R${i}`));
        await collect(provider.send(session, `Q${i}`, []));
      }
      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(52);
      // First user message preserved
      expect(history[0].content).toBe("Q0");
      // Last assistant preserved
      expect(history[51].content).toBe("R25");
    });
  });

  // ========== Tool Call History ==========

  describe("Tool Call History", () => {
    it("tool call adds assistant content array with tool_use blocks", async () => {
      const tool = makeTool("remote_exec");
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ id: "tc-1", name: "remote_exec", args: { input: "ls" } }]))
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Run ls", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      const assistantToolUse = history.find(
        (m: any) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_use"),
      );
      expect(assistantToolUse).toBeDefined();
      expect(assistantToolUse.content.find((b: any) => b.type === "tool_use").id).toBe("tc-1");
    });

    it("tool result adds user content array with tool_result blocks", async () => {
      const tool = makeTool("remote_exec");
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ id: "tc-1", name: "remote_exec", args: { input: "ls" } }]))
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Run ls", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      const userToolResult = history.find(
        (m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"),
      );
      expect(userToolResult).toBeDefined();
      expect(userToolResult.content[0].tool_use_id).toBe("tc-1");
    });

    it("multiple tool calls in one turn create multiple tool_use entries", async () => {
      const tool1 = makeTool("tool_a");
      const tool2 = makeTool("tool_b");
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([
            { id: "tc-1", name: "tool_a", args: { input: "x" } },
            { id: "tc-2", name: "tool_b", args: { input: "y" } },
          ]),
        )
        .mockResolvedValueOnce(textSSEResponse("Both done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Run both", [tool1, tool2]));

      const history = (provider as any).conversationHistory.get(session.id);
      const assistantToolUse = history.find(
        (m: any) => m.role === "assistant" && Array.isArray(m.content) && m.content.filter((b: any) => b.type === "tool_use").length === 2,
      );
      expect(assistantToolUse).toBeDefined();
    });

    it("tool_use IDs in history match between assistant and user messages", async () => {
      const tool = makeTool("remote_exec");
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ id: "tc-42", name: "remote_exec", args: { input: "pwd" } }]))
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Where am I?", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      const assistantBlock = history
        .filter((m: any) => m.role === "assistant" && Array.isArray(m.content))
        .flatMap((m: any) => m.content)
        .find((b: any) => b.type === "tool_use");
      const userResultBlock = history
        .filter((m: any) => m.role === "user" && Array.isArray(m.content))
        .flatMap((m: any) => m.content)
        .find((b: any) => b.type === "tool_result");

      expect(assistantBlock.id).toBe("tc-42");
      expect(userResultBlock.tool_use_id).toBe("tc-42");
    });

    it("tool loop: tool_call -> result -> continue -> tool_call -> result -> text -> done", async () => {
      const tool = makeTool("remote_exec");
      // First API call: tool call
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ id: "tc-1", name: "remote_exec", args: { input: "ls" } }]))
        // Second API call: another tool call (continue loop)
        .mockResolvedValueOnce(toolCallSSEResponse([{ id: "tc-2", name: "remote_exec", args: { input: "cat file.txt" } }]))
        // Third API call: text response (end loop)
        .mockResolvedValueOnce(textSSEResponse("Here's the content"));

      const session = await provider.createSession({});
      const events = await collect(provider.send(session, "Read the file", [tool]));

      // Should have tool_call, tool_result, tool_call, tool_result, text, done
      const toolCallEvents = events.filter((e: any) => e.type === "tool_call");
      expect(toolCallEvents).toHaveLength(2);

      const history = (provider as any).conversationHistory.get(session.id);
      // user, assistant[tool_use], user[tool_result], assistant[tool_use], user[tool_result], assistant text
      expect(history.length).toBeGreaterThanOrEqual(6);
    });

    it("tool error adds error result to history", async () => {
      const tool = makeTool("failing_tool", vi.fn().mockRejectedValue(new Error("Command failed")));
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ id: "tc-err", name: "failing_tool", args: { input: "x" } }]))
        .mockResolvedValueOnce(textSSEResponse("I see the error"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Run it", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      const toolResult = history
        .filter((m: any) => m.role === "user" && Array.isArray(m.content))
        .flatMap((m: any) => m.content)
        .find((b: any) => b.type === "tool_result" && b.is_error === true);
      expect(toolResult).toBeDefined();
      expect(toolResult.content).toContain("Error:");
    });

    it("unknown tool adds error result to history", async () => {
      // No tools registered, but model calls one
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ id: "tc-unk", name: "unknown_tool", args: {} }]))
        .mockResolvedValueOnce(textSSEResponse("Oh well"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Do something", []));

      const history = (provider as any).conversationHistory.get(session.id);
      const toolResult = history
        .filter((m: any) => m.role === "user" && Array.isArray(m.content))
        .flatMap((m: any) => m.content)
        .find((b: any) => b.type === "tool_result" && b.is_error === true);
      expect(toolResult).toBeDefined();
      expect(toolResult.content).toContain("Unknown tool");
    });

    it("server tool calls do not add tool_use to conversation history (handled by API)", async () => {
      mockFetch.mockResolvedValueOnce(
        serverToolSSEResponse("stc-1", "web_search", "Search results here"),
      );

      const session = await provider.createSession({});
      await collect(provider.send(session, "Search for ML papers", []));

      const history = (provider as any).conversationHistory.get(session.id);
      // Server tool calls are NOT added as tool_use blocks to history
      // Only text response goes into history
      const toolUseBlocks = history
        .filter((m: any) => Array.isArray(m.content))
        .flatMap((m: any) => m.content)
        .filter((b: any) => b.type === "tool_use");
      expect(toolUseBlocks).toHaveLength(0);
    });

    it("tool call with text prefix adds both text and tool_use to assistant content", async () => {
      const tool = makeTool("remote_exec");
      mockFetch
        .mockResolvedValueOnce(
          toolCallSSEResponse([{ id: "tc-1", name: "remote_exec", args: { input: "ls" } }], "Let me check..."),
        )
        .mockResolvedValueOnce(textSSEResponse("Done"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "List files", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      const assistantMsg = history.find(
        (m: any) => m.role === "assistant" && Array.isArray(m.content),
      );
      expect(assistantMsg).toBeDefined();
      const textBlock = assistantMsg.content.find((b: any) => b.type === "text");
      const toolBlock = assistantMsg.content.find((b: any) => b.type === "tool_use");
      expect(textBlock).toBeDefined();
      expect(textBlock.text).toBe("Let me check...");
      expect(toolBlock).toBeDefined();
    });

    it("empty tools list works (no tool definitions in API call)", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Just chat", []));

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(2); // user + assistant
    });
  });

  // ========== Session Isolation ==========

  describe("Session Isolation", () => {
    it("history for different sessions is isolated", async () => {
      const session1 = await provider.createSession({});
      const session2 = await provider.createSession({});

      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply to S1"));
      await collect(provider.send(session1, "S1 message", []));
      mockFetch.mockResolvedValueOnce(textSSEResponse("Reply to S2"));
      await collect(provider.send(session2, "S2 message", []));

      const h1 = (provider as any).conversationHistory.get(session1.id);
      const h2 = (provider as any).conversationHistory.get(session2.id);

      expect(h1[0].content).toBe("S1 message");
      expect(h2[0].content).toBe("S2 message");
      expect(h1).toHaveLength(2);
      expect(h2).toHaveLength(2);
    });

    it("concurrent sends to different sessions do not interfere", async () => {
      const session1 = await provider.createSession({});
      const session2 = await provider.createSession({});

      mockFetch
        .mockResolvedValueOnce(textSSEResponse("Reply1"))
        .mockResolvedValueOnce(textSSEResponse("Reply2"));

      const [events1, events2] = await Promise.all([
        collect(provider.send(session1, "Msg1", [])),
        collect(provider.send(session2, "Msg2", [])),
      ]);

      expect(events1.some((e: any) => e.type === "done")).toBe(true);
      expect(events2.some((e: any) => e.type === "done")).toBe(true);

      const h1 = (provider as any).conversationHistory.get(session1.id);
      const h2 = (provider as any).conversationHistory.get(session2.id);
      expect(h1[0].content).toBe("Msg1");
      expect(h2[0].content).toBe("Msg2");
    });

    it("closeSession removes history for that session", async () => {
      const session = await provider.createSession({ systemPrompt: "test" });
      mockFetch.mockResolvedValueOnce(textSSEResponse("Hi"));
      await collect(provider.send(session, "Hello", []));

      await provider.closeSession(session);
      expect((provider as any).conversationHistory.has(session.id)).toBe(false);
    });

    it("closeSession does not affect other sessions", async () => {
      const session1 = await provider.createSession({});
      const session2 = await provider.createSession({});

      mockFetch.mockResolvedValueOnce(textSSEResponse("R1"));
      await collect(provider.send(session1, "M1", []));
      mockFetch.mockResolvedValueOnce(textSSEResponse("R2"));
      await collect(provider.send(session2, "M2", []));

      await provider.closeSession(session1);

      expect((provider as any).conversationHistory.has(session1.id)).toBe(false);
      expect((provider as any).conversationHistory.has(session2.id)).toBe(true);
      expect((provider as any).conversationHistory.get(session2.id)).toHaveLength(2);
    });
  });

  // ========== Resume ==========

  describe("Resume", () => {
    it("resume populates history from DB messages", async () => {
      const session = await provider.createSession({});
      store.addMessage(session.id, "user", "Stored Q");
      store.addMessage(session.id, "assistant", "Stored A");

      (provider as any).conversationHistory.delete(session.id);
      await provider.resumeSession(session.id);

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: "user", content: "Stored Q" });
      expect(history[1]).toEqual({ role: "assistant", content: "Stored A" });
    });

    it("resume with no stored messages initializes empty history", async () => {
      const session = await provider.createSession({});
      (provider as any).conversationHistory.delete(session.id);
      await provider.resumeSession(session.id);

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toEqual([]);
    });

    it("resume reconstructs tool messages and skips system", async () => {
      const session = await provider.createSession({});
      store.addMessage(session.id, "system", "System msg");
      store.addMessage(session.id, "user", "User msg");
      store.addMessage(session.id, "tool", "Tool msg", JSON.stringify({ callId: "tc1", isError: false }));
      store.addMessage(session.id, "assistant", "Assistant msg");

      (provider as any).conversationHistory.delete(session.id);
      await provider.resumeSession(session.id);

      const history = (provider as any).conversationHistory.get(session.id);
      // system skipped, tool becomes user(tool_result)
      expect(history).toHaveLength(3);
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("user"); // tool_result in user message
      expect(history[2].role).toBe("assistant");
    });

    it("resume does not re-load if history already exists in memory", async () => {
      const session = await provider.createSession({});
      const existing = [{ role: "user", content: "cached" }];
      (provider as any).conversationHistory.set(session.id, existing);

      store.addMessage(session.id, "user", "from DB");
      await provider.resumeSession(session.id);

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("cached");
    });

    it("resume then multiple sends accumulates correctly", async () => {
      const session = await provider.createSession({});
      store.addMessage(session.id, "user", "Original");
      store.addMessage(session.id, "assistant", "Original reply");

      (provider as any).conversationHistory.delete(session.id);
      await provider.resumeSession(session.id);

      mockFetch.mockResolvedValueOnce(textSSEResponse("R1"));
      await collect(provider.send(session, "Q1", []));
      mockFetch.mockResolvedValueOnce(textSSEResponse("R2"));
      await collect(provider.send(session, "Q2", []));

      const history = (provider as any).conversationHistory.get(session.id);
      // 2 restored + 2 new pairs = 6
      expect(history).toHaveLength(6);
      expect(history[0].content).toBe("Original");
      expect(history[5].content).toBe("R2");
    });
  });

  // ========== resetHistory / Checkpoint ==========

  describe("resetHistory / Checkpoint", () => {
    it("resetHistory replaces everything with [briefing, ack]", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("R1"));
      await collect(provider.send(session, "Build something", []));

      provider.resetHistory(session, "=== CHECKPOINT ===\nYou are resuming...");

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(2);
      expect(history[0].role).toBe("user");
      expect(history[0].content).toContain("CHECKPOINT");
      expect(history[1].role).toBe("assistant");
    });

    it("resetHistory ack content is CHECKPOINT_ACK constant", async () => {
      const session = await provider.createSession({});
      provider.resetHistory(session, "Briefing");

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history[1].content).toBe(CHECKPOINT_ACK);
    });

    it("after resetHistory, next send only includes briefing + new message", async () => {
      const session = await provider.createSession({});
      // Accumulate some history
      mockFetch.mockResolvedValueOnce(textSSEResponse("R1"));
      await collect(provider.send(session, "Q1", []));
      mockFetch.mockResolvedValueOnce(textSSEResponse("R2"));
      await collect(provider.send(session, "Q2", []));

      provider.resetHistory(session, "Checkpoint briefing");

      mockFetch.mockResolvedValueOnce(textSSEResponse("R3"));
      await collect(provider.send(session, "Q3", []));

      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      const requestBody = JSON.parse(lastCall[1].body);
      // briefing (user), ack (assistant), new message (user)
      expect(requestBody.messages).toHaveLength(3);
      expect(requestBody.messages[0].content).toBe("Checkpoint briefing");
      expect(requestBody.messages[1].content).toBe(CHECKPOINT_ACK);
      expect(requestBody.messages[2].content).toBe("Q3");
    });

    it("history after checkpoint: briefing -> ack -> new user -> new assistant", async () => {
      const session = await provider.createSession({});
      provider.resetHistory(session, "My briefing");

      mockFetch.mockResolvedValueOnce(textSSEResponse("New reply"));
      await collect(provider.send(session, "New question", []));

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(4);
      expect(history[0]).toEqual({ role: "user", content: "My briefing" });
      expect(history[1]).toEqual({ role: "assistant", content: CHECKPOINT_ACK });
      expect(history[2]).toEqual({ role: "user", content: "New question" });
      expect(history[3]).toEqual({ role: "assistant", content: "New reply" });
    });
  });

  // ========== Attachments ==========

  describe("Attachments", () => {
    it("image attachment creates multimodal content block", async () => {
      const session = await provider.createSession({});
      const attachments = [{ filename: "photo.png", mediaType: "image/png", data: "iVBOR..." }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Nice image"));
      await collect(provider.send(session, "Describe this", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history[0];
      expect(Array.isArray(userMsg.content)).toBe(true);
      const imageBlock = userMsg.content.find((b: any) => b.type === "image");
      expect(imageBlock).toBeDefined();
      expect(imageBlock.source.media_type).toBe("image/png");
    });

    it("PDF attachment creates document content block", async () => {
      const session = await provider.createSession({});
      const attachments = [{ filename: "paper.pdf", mediaType: "application/pdf", data: "JVBERi..." }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Read the PDF"));
      await collect(provider.send(session, "Summarize", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history[0];
      expect(Array.isArray(userMsg.content)).toBe(true);
      const docBlock = userMsg.content.find((b: any) => b.type === "document");
      expect(docBlock).toBeDefined();
      expect(docBlock.source.media_type).toBe("application/pdf");
    });

    it("attachment with text: text block comes after attachments", async () => {
      const session = await provider.createSession({});
      const attachments = [{ filename: "img.png", mediaType: "image/png", data: "abc" }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("OK"));
      await collect(provider.send(session, "What is this?", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userContent = history[0].content as any[];
      // Image first, text last
      expect(userContent[0].type).toBe("image");
      expect(userContent[userContent.length - 1].type).toBe("text");
      expect(userContent[userContent.length - 1].text).toBe("What is this?");
    });
  });

  // ========== stripAttachmentData ==========

  describe("stripAttachmentData", () => {
    it("replaces large image blocks with stripped text", async () => {
      const session = await provider.createSession({});
      const bigData = "x".repeat(200);
      const attachments = [{ filename: "big.png", mediaType: "image/png", data: bigData }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Got it"));
      await collect(provider.send(session, "Analyze", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history[0];
      const stripped = userMsg.content.find((b: any) => b.type === "text" && b.text.includes("stripped"));
      expect(stripped).toBeDefined();
      expect(stripped.text).toBe("[image attachment stripped]");
    });

    it("replaces large document blocks", async () => {
      const session = await provider.createSession({});
      const bigData = "x".repeat(200);
      const attachments = [{ filename: "big.pdf", mediaType: "application/pdf", data: bigData }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Got it"));
      await collect(provider.send(session, "Read", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history[0];
      const stripped = userMsg.content.find((b: any) => b.type === "text" && b.text.includes("stripped"));
      expect(stripped).toBeDefined();
      expect(stripped.text).toBe("[document attachment stripped]");
    });

    it("preserves small attachments (<=100 chars)", async () => {
      const session = await provider.createSession({});
      const smallData = "x".repeat(50);
      const attachments = [{ filename: "tiny.png", mediaType: "image/png", data: smallData }];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Tiny"));
      await collect(provider.send(session, "Show", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userMsg = history[0];
      const imageBlock = userMsg.content.find((b: any) => b.type === "image");
      expect(imageBlock).toBeDefined();
      expect(imageBlock.source.data).toBe(smallData);
    });

    it("handles tool_result with multimodal content", async () => {
      const multimodalResult = JSON.stringify({
        __multimodal: true,
        text: "Chart data",
        attachments: [{ mediaType: "image/png", data: "x".repeat(200) }],
      });
      const tool = makeTool("plot_tool", vi.fn().mockResolvedValue(multimodalResult));
      mockFetch
        .mockResolvedValueOnce(toolCallSSEResponse([{ id: "tc-m", name: "plot_tool", args: { input: "plot" } }]))
        .mockResolvedValueOnce(textSSEResponse("Here's the chart"));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Make a chart", [tool]));

      const history = (provider as any).conversationHistory.get(session.id);
      // Find the tool_result block inside a user message
      const toolResultMsg = history.find(
        (m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"),
      );
      expect(toolResultMsg).toBeDefined();
      // The image inside the tool result should be stripped
      const toolResultBlock = toolResultMsg.content.find((b: any) => b.type === "tool_result");
      if (Array.isArray(toolResultBlock.content)) {
        const strippedInner = toolResultBlock.content.find(
          (b: any) => b.type === "text" && b.text.includes("stripped"),
        );
        expect(strippedInner).toBeDefined();
      }
    });

    it("handles plain text content (string, not array)", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("Simple reply"));
      await collect(provider.send(session, "Simple question", []));

      const history = (provider as any).conversationHistory.get(session.id);
      // stripAttachmentData should not crash on string content
      const assistantMsg = history.find((m: any) => m.role === "assistant" && typeof m.content === "string");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.content).toBe("Simple reply");
    });
  });

  // ========== API Request Verification ==========

  describe("API Request Verification", () => {
    it("system prompt is included in API request when set", async () => {
      const session = await provider.createSession({ systemPrompt: "You are a scientist" });
      await collect(provider.send(session, "Question", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.system).toBe("You are a scientist");
    });

    it("system prompt is absent when not set", async () => {
      const session = await provider.createSession({});
      await collect(provider.send(session, "Question", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.system).toBeUndefined();
    });

    it("messages in API request match history at time of call", async () => {
      const session = await provider.createSession({});
      mockFetch.mockResolvedValueOnce(textSSEResponse("R1"));
      await collect(provider.send(session, "Q1", []));

      mockFetch.mockResolvedValueOnce(textSSEResponse("R2"));
      await collect(provider.send(session, "Q2", []));

      const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      // Q1, R1, Q2
      expect(secondCallBody.messages).toHaveLength(3);
      expect(secondCallBody.messages[0].content).toBe("Q1");
      expect(secondCallBody.messages[1].content).toBe("R1");
      expect(secondCallBody.messages[2].content).toBe("Q2");
    });

    it("web_search tool is excluded from function tools but included as server tool", async () => {
      const wsTool = makeTool("web_search");
      const regTool = makeTool("remote_exec");
      const session = await provider.createSession({});
      await collect(provider.send(session, "Search", [wsTool, regTool]));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Function tools (with input_schema) should only have remote_exec
      const functionTools = requestBody.tools.filter((t: any) => t.input_schema);
      expect(functionTools).toHaveLength(1);
      expect(functionTools[0].name).toBe("remote_exec");
      // Server tool type should also be present
      const serverTools = requestBody.tools.filter((t: any) => t.type === "web_search_20250305");
      expect(serverTools).toHaveLength(1);
    });
  });

  // ========== Thinking Blocks ==========

  describe("Thinking Blocks", () => {
    it("thinking blocks are streamed but not stored in history as separate messages", async () => {
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think..." } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Here's my answer" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", usage: { output_tokens: 20 } },
        { type: "message_stop" },
      ];
      mockFetch.mockResolvedValueOnce(mockSSEResponse(events));

      const session = await provider.createSession({});
      await collect(provider.send(session, "Think about this", []));

      const history = (provider as any).conversationHistory.get(session.id);
      expect(history).toHaveLength(2);
      expect(history[1].content).toBe("Here's my answer");
    });
  });

  // ========== Additional Edge Cases ==========

  describe("Additional Edge Cases", () => {
    it("reasoning effort affects thinking budget in request", async () => {
      const session = await provider.createSession({});
      provider.reasoningEffort = "high";
      await collect(provider.send(session, "Question", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.thinking).toEqual({ type: "enabled", budget_tokens: 50000 });
    });

    it("reasoning effort 'max' sets highest budget", async () => {
      const session = await provider.createSession({});
      provider.reasoningEffort = "max";
      await collect(provider.send(session, "Question", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.thinking.budget_tokens).toBe(100000);
    });

    it("model name is sent in API request body", async () => {
      provider.currentModel = "claude-sonnet-4-6";
      const session = await provider.createSession({});
      await collect(provider.send(session, "Hi", []));

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.model).toBe("claude-sonnet-4-6");
    });

    it("interrupt sets abort controller to null", async () => {
      const session = await provider.createSession({});
      // Start a send
      const gen = provider.send(session, "Hello", []);
      const iter = gen[Symbol.asyncIterator]();
      await iter.next(); // begin streaming

      // Interrupt
      provider.interrupt(session);
      expect((provider as any).abortController).toBeNull();
    });

    it("multiple attachments create multiple content blocks", async () => {
      const session = await provider.createSession({});
      const attachments = [
        { filename: "img1.png", mediaType: "image/png", data: "abc" },
        { filename: "doc.pdf", mediaType: "application/pdf", data: "def" },
        { filename: "img2.jpg", mediaType: "image/jpeg", data: "ghi" },
      ];
      mockFetch.mockResolvedValueOnce(textSSEResponse("Got all three"));
      await collect(provider.send(session, "Analyze these", [], attachments));

      const history = (provider as any).conversationHistory.get(session.id);
      const userContent = history[0].content as any[];
      // 2 images + 1 document + 1 text = 4 blocks
      expect(userContent).toHaveLength(4);
      expect(userContent.filter((b: any) => b.type === "image")).toHaveLength(2);
      expect(userContent.filter((b: any) => b.type === "document")).toHaveLength(1);
      expect(userContent.filter((b: any) => b.type === "text")).toHaveLength(1);
    });

    it("fetchModels returns two Claude models", async () => {
      const models = await provider.fetchModels();
      expect(models).toHaveLength(2);
      expect(models.map((m: any) => m.id)).toContain("claude-opus-4-6");
      expect(models.map((m: any) => m.id)).toContain("claude-sonnet-4-6");
    });

    it("default model is claude-opus-4-6", () => {
      expect(provider.currentModel).toBe("claude-opus-4-6");
    });
  });
});
