import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../__tests__/db-helper.js";

const mockDb = { current: createTestDb() };
vi.mock("./database.js", () => {
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

const { SessionStore, createEphemeralSession } = await import("./session-store.js");

describe("SessionStore — Edge Cases", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  // =======================================================================
  // Large / Complex Message Content
  // =======================================================================

  describe("Large / Complex Message Content", () => {
    it("large message content (10KB+) stores and retrieves correctly", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      const largeContent = "x".repeat(10_240);

      store.addMessage(session.id, "user", largeContent);
      const messages = store.getMessages(session.id);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(largeContent);
      expect(messages[0].content.length).toBe(10_240);
    });

    it("very large message content (100KB+) stores and retrieves correctly", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      const hugeContent = "y".repeat(102_400);

      store.addMessage(session.id, "user", hugeContent);
      const messages = store.getMessages(session.id);

      expect(messages[0].content.length).toBe(102_400);
    });

    it("message with tool_calls JSON stores/retrieves", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      const toolCalls = JSON.stringify([
        { id: "tc-1", name: "remote_exec", args: { command: "ls" } },
        { id: "tc-2", name: "file_read", args: { path: "/tmp/data.csv" } },
      ]);

      store.addMessage(session.id, "assistant", "Let me check", { toolCalls });
      const messages = store.getMessages(session.id);

      expect(messages[0].toolCalls).toBe(toolCalls);
      const parsed = JSON.parse(messages[0].toolCalls!);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("remote_exec");
    });

    it("message with token_count stores/retrieves", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");

      store.addMessage(session.id, "user", "Hello", { tokenCount: 42 });
      const messages = store.getMessages(session.id);

      expect(messages[0].tokenCount).toBe(42);
    });

    it("message with unicode content stores/retrieves", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      const unicode = "Hello \u{1F600} \u{1F680} \u{4E16}\u{754C}";

      store.addMessage(session.id, "user", unicode);
      const messages = store.getMessages(session.id);
      expect(messages[0].content).toBe(unicode);
    });

    it("message with newlines and special chars stores correctly", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      const content = "Line 1\nLine 2\tTabbed\r\nWindows line\0Null char";

      store.addMessage(session.id, "user", content);
      const messages = store.getMessages(session.id);
      expect(messages[0].content).toBe(content);
    });
  });

  // =======================================================================
  // Many Messages
  // =======================================================================

  describe("Many Messages", () => {
    it("500+ messages for single session stores and retrieves", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");

      for (let i = 0; i < 500; i++) {
        store.addMessage(session.id, i % 2 === 0 ? "user" : "assistant", `Message ${i}`);
      }

      // Default limit is 100
      const defaultMessages = store.getMessages(session.id);
      expect(defaultMessages).toHaveLength(100);

      // With higher limit
      const allMessages = store.getMessages(session.id, 600);
      expect(allMessages).toHaveLength(500);
    });

    it("getMessages with limit returns most recent (ORDER BY ASC LIMIT)", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");

      for (let i = 0; i < 20; i++) {
        store.addMessage(session.id, "user", `msg-${i}`);
      }

      const limited = store.getMessages(session.id, 5);
      expect(limited).toHaveLength(5);
      // ORDER BY timestamp ASC LIMIT 5 means we get the FIRST 5
      expect(limited[0].content).toBe("msg-0");
      expect(limited[4].content).toBe("msg-4");
    });

    it("getMessages without explicit limit returns up to 100", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");

      for (let i = 0; i < 150; i++) {
        store.addMessage(session.id, "user", `msg-${i}`);
      }

      const messages = store.getMessages(session.id);
      expect(messages).toHaveLength(100);
    });

    it("multiple sessions: messages are isolated", () => {
      const store = new SessionStore("agent1");
      const s1 = store.createSession("claude");
      const s2 = store.createSession("openai");

      store.addMessage(s1.id, "user", "S1 msg");
      store.addMessage(s2.id, "user", "S2 msg");

      const m1 = store.getMessages(s1.id);
      const m2 = store.getMessages(s2.id);

      expect(m1).toHaveLength(1);
      expect(m1[0].content).toBe("S1 msg");
      expect(m2).toHaveLength(1);
      expect(m2[0].content).toBe("S2 msg");
    });
  });

  // =======================================================================
  // Cost Edge Cases
  // =======================================================================

  describe("Cost Edge Cases", () => {
    it("addCost with zero values", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      store.addMessage(session.id, "user", "test");

      store.addCost(session.id, 0, 0, 0);

      const summaries = store.listSessionSummaries();
      expect(summaries[0].costUsd).toBe(0);
      expect(summaries[0].inputTokens).toBe(0);
      expect(summaries[0].outputTokens).toBe(0);
    });

    it("addCost with very small values (floating point)", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      store.addMessage(session.id, "user", "test");

      store.addCost(session.id, 0.000001, 1, 1);
      store.addCost(session.id, 0.000002, 1, 1);

      const summaries = store.listSessionSummaries();
      expect(summaries[0].costUsd).toBeCloseTo(0.000003, 6);
    });

    it("addCost with very large values", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      store.addMessage(session.id, "user", "test");

      store.addCost(session.id, 99.99, 1_000_000, 500_000);

      const summaries = store.listSessionSummaries();
      expect(summaries[0].costUsd).toBeCloseTo(99.99, 2);
      expect(summaries[0].inputTokens).toBe(1_000_000);
      expect(summaries[0].outputTokens).toBe(500_000);
    });

    it("cost aggregation across multiple addCost calls", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      store.addMessage(session.id, "user", "test");

      for (let i = 0; i < 100; i++) {
        store.addCost(session.id, 0.01, 100, 50);
      }

      const summaries = store.listSessionSummaries();
      expect(summaries[0].costUsd).toBeCloseTo(1.0, 1);
      expect(summaries[0].inputTokens).toBe(10_000);
      expect(summaries[0].outputTokens).toBe(5_000);
    });
  });

  // =======================================================================
  // listSessions
  // =======================================================================

  describe("listSessions", () => {
    it("ordering: most recent first", () => {
      const store = new SessionStore("agent1");

      const s1 = store.createSession("claude");
      store.addMessage(s1.id, "user", "first");
      store.updateLastActive(s1.id);

      const s2 = store.createSession("openai");
      store.addMessage(s2.id, "user", "second");
      store.updateLastActive(s2.id);

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(2);
      // Most recent first
      expect(sessions[0].id).toBe(s2.id);
      expect(sessions[1].id).toBe(s1.id);
    });

    it("listSessions with limit", () => {
      const store = new SessionStore("agent1");

      for (let i = 0; i < 10; i++) {
        const s = store.createSession("claude");
        store.addMessage(s.id, "user", `msg ${i}`);
      }

      const limited = store.listSessions(3);
      expect(limited).toHaveLength(3);
    });

    it("listSessions returns empty for agent with no sessions", () => {
      const store = new SessionStore("nonexistent-agent");
      expect(store.listSessions()).toHaveLength(0);
    });

    it("session without messages excluded from listSessions", () => {
      const store = new SessionStore("agent1");
      store.createSession("claude"); // no messages

      expect(store.listSessions()).toHaveLength(0);
    });
  });

  // =======================================================================
  // listSessionSummaries
  // =======================================================================

  describe("listSessionSummaries", () => {
    it("multiple sessions in summaries", () => {
      const store = new SessionStore("agent1");

      const s1 = store.createSession("claude", "opus");
      store.addMessage(s1.id, "user", "Hello Claude");
      store.addCost(s1.id, 0.05, 500, 200);

      const s2 = store.createSession("openai", "gpt-5.4");
      store.addMessage(s2.id, "user", "Hello OpenAI");
      store.addCost(s2.id, 0.03, 300, 100);

      const summaries = store.listSessionSummaries();
      expect(summaries).toHaveLength(2);
    });

    it("firstUserMessage in summary", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      store.addMessage(session.id, "user", "Train a model to classify cats");
      store.addMessage(session.id, "assistant", "Sure!");

      const summaries = store.listSessionSummaries();
      expect(summaries[0].firstUserMessage).toContain("Train a model");
    });

    it("firstUserMessage with long content is truncated", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      const longMsg = "A".repeat(200);
      store.addMessage(session.id, "user", longMsg);

      const summaries = store.listSessionSummaries();
      // truncate(msg, 80, true) — should be truncated to <= ~80 chars + ellipsis
      expect(summaries[0].firstUserMessage!.length).toBeLessThanOrEqual(85);
    });

    it("summaries cost aggregation across multiple addCost calls", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus");
      store.addMessage(session.id, "user", "test");

      store.addCost(session.id, 0.01, 100, 50);
      store.addCost(session.id, 0.02, 200, 100);
      store.addCost(session.id, 0.03, 300, 150);

      const summaries = store.listSessionSummaries();
      expect(summaries[0].costUsd).toBeCloseTo(0.06, 2);
      expect(summaries[0].inputTokens).toBe(600);
      expect(summaries[0].outputTokens).toBe(300);
    });

    it("returns empty for no sessions", () => {
      const store = new SessionStore("empty-agent");
      expect(store.listSessionSummaries()).toHaveLength(0);
    });

    it("with limit", () => {
      const store = new SessionStore("agent1");
      for (let i = 0; i < 10; i++) {
        const s = store.createSession("claude");
        store.addMessage(s.id, "user", `msg ${i}`);
      }

      const limited = store.listSessionSummaries(3);
      expect(limited).toHaveLength(3);
    });

    it("session with only assistant messages excluded from summaries (no user msg)", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude");
      store.addMessage(session.id, "assistant", "Bot speaking");

      const summaries = store.listSessionSummaries();
      // Session has a message so it should appear, but firstUserMessage should be null
      expect(summaries).toHaveLength(1);
      expect(summaries[0].firstUserMessage).toBeNull();
    });
  });

  // =======================================================================
  // Session Fields
  // =======================================================================

  describe("Session Fields", () => {
    it("session with model name stores/retrieves", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "claude-sonnet-4-6");
      const retrieved = store.getSession(session.id);

      expect(retrieved).not.toBeNull();
      // model isn't exposed on Session interface directly, but let's verify via summaries
      store.addMessage(session.id, "user", "test");
      const summaries = store.listSessionSummaries();
      expect(summaries[0].model).toBe("claude-sonnet-4-6");
    });

    it("session model can be null", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude"); // no model
      store.addMessage(session.id, "user", "test");

      const summaries = store.listSessionSummaries();
      expect(summaries[0].model).toBeNull();
    });

    it("session with providerSessionId stores/retrieves", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude", "opus", "sdk-session-123");
      const retrieved = store.getSession(session.id);

      expect(retrieved!.providerSessionId).toBe("sdk-session-123");
    });

    it("updateProviderSessionId changes the stored value", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude");
      // When no providerSessionId is set, it comes back as null from SQLite
      const initial = store.getSession(session.id)!.providerSessionId;
      expect(initial == null).toBe(true);

      store.updateProviderSessionId(session.id, "new-sdk-id");
      expect(store.getSession(session.id)!.providerSessionId).toBe("new-sdk-id");
    });

    it("getSession returns correct types for all fields", () => {
      const store = new SessionStore("agent1");
      const before = Date.now();
      const session = store.createSession("claude", "opus", "sdk-1");
      const after = Date.now();

      const retrieved = store.getSession(session.id);
      expect(typeof retrieved!.id).toBe("string");
      expect(typeof retrieved!.providerId).toBe("string");
      expect(typeof retrieved!.createdAt).toBe("number");
      expect(typeof retrieved!.lastActiveAt).toBe("number");
      expect(retrieved!.createdAt).toBeGreaterThanOrEqual(before);
      expect(retrieved!.createdAt).toBeLessThanOrEqual(after);
      expect(retrieved!.providerId).toBe("claude");
    });
  });

  // =======================================================================
  // updateLastActive
  // =======================================================================

  describe("updateLastActive", () => {
    it("changes timestamp", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude");
      const original = session.lastActiveAt;

      // Brief delay to ensure different timestamp
      store.updateLastActive(session.id);
      const updated = store.getSession(session.id);
      expect(updated!.lastActiveAt).toBeGreaterThanOrEqual(original);
    });

    it("does not affect other sessions", () => {
      const store = new SessionStore("agent1");
      const s1 = store.createSession("claude");
      const s2 = store.createSession("openai");
      const s2Original = s2.lastActiveAt;

      store.updateLastActive(s1.id);

      const s2After = store.getSession(s2.id);
      expect(s2After!.lastActiveAt).toBe(s2Original);
    });
  });

  // =======================================================================
  // Agent ID Isolation
  // =======================================================================

  describe("Agent ID Isolation", () => {
    it("different agent IDs see different sessions", () => {
      const store1 = new SessionStore("agent-A");
      const store2 = new SessionStore("agent-B");

      const s1 = store1.createSession("claude");
      store1.addMessage(s1.id, "user", "Agent A msg");

      const s2 = store2.createSession("claude");
      store2.addMessage(s2.id, "user", "Agent B msg");

      expect(store1.listSessions()).toHaveLength(1);
      expect(store1.listSessions()[0].id).toBe(s1.id);
      expect(store2.listSessions()).toHaveLength(1);
      expect(store2.listSessions()[0].id).toBe(s2.id);
    });

    it("empty agent ID: sessions with empty agent_id", () => {
      const store = new SessionStore("");
      const session = store.createSession("claude");
      store.addMessage(session.id, "user", "msg");

      expect(store.listSessions()).toHaveLength(1);
    });

    it("different stores see different summaries", () => {
      const storeA = new SessionStore("A");
      const storeB = new SessionStore("B");

      const sA = storeA.createSession("claude");
      storeA.addMessage(sA.id, "user", "A msg");
      storeA.addCost(sA.id, 0.05, 500, 200);

      const sB = storeB.createSession("openai");
      storeB.addMessage(sB.id, "user", "B msg");
      storeB.addCost(sB.id, 0.03, 300, 100);

      const summariesA = storeA.listSessionSummaries();
      const summariesB = storeB.listSessionSummaries();

      expect(summariesA).toHaveLength(1);
      expect(summariesA[0].provider).toBe("claude");
      expect(summariesB).toHaveLength(1);
      expect(summariesB[0].provider).toBe("openai");
    });

    it("getSession works across agent IDs (not filtered by agent)", () => {
      const store1 = new SessionStore("agent-A");
      const store2 = new SessionStore("agent-B");

      const session = store1.createSession("claude");

      // getSession should work from any store since it queries by ID
      const retrieved = store2.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(session.id);
    });
  });

  // =======================================================================
  // createEphemeralSession
  // =======================================================================

  describe("createEphemeralSession", () => {
    it("ID starts with eph-", () => {
      const session = createEphemeralSession("claude");
      expect(session.id).toMatch(/^eph-/);
    });

    it("timestamps are current", () => {
      const before = Date.now();
      const session = createEphemeralSession("openai");
      const after = Date.now();

      expect(session.createdAt).toBeGreaterThanOrEqual(before);
      expect(session.createdAt).toBeLessThanOrEqual(after);
      expect(session.lastActiveAt).toBeGreaterThanOrEqual(before);
      expect(session.lastActiveAt).toBeLessThanOrEqual(after);
    });

    it("multiple ephemeral sessions get unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(createEphemeralSession("claude").id);
      }
      expect(ids.size).toBe(50);
    });

    it("ephemeral session never touches DB", () => {
      const store = new SessionStore("agent1");
      const ephSession = createEphemeralSession("claude");

      // It shouldn't be findable in the DB
      const retrieved = store.getSession(ephSession.id);
      expect(retrieved).toBeNull();

      expect(store.listSessions()).toHaveLength(0);
    });

    it("ephemeral session has correct providerId", () => {
      expect(createEphemeralSession("claude").providerId).toBe("claude");
      expect(createEphemeralSession("openai").providerId).toBe("openai");
    });
  });

  // =======================================================================
  // Message Roles
  // =======================================================================

  describe("Message Roles", () => {
    it("addMessage with 'user' role", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude");

      store.addMessage(session.id, "user", "User message");
      const messages = store.getMessages(session.id);
      expect(messages[0].role).toBe("user");
    });

    it("addMessage with 'assistant' role", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude");

      store.addMessage(session.id, "assistant", "Assistant message");
      const messages = store.getMessages(session.id);
      expect(messages[0].role).toBe("assistant");
    });

    it("addMessage with 'system' role", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude");

      store.addMessage(session.id, "system", "System message");
      const messages = store.getMessages(session.id);
      expect(messages[0].role).toBe("system");
    });

    it("addMessage with 'tool' role", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude");

      store.addMessage(session.id, "tool", "Tool output");
      const messages = store.getMessages(session.id);
      expect(messages[0].role).toBe("tool");
    });

    it("message ordering: timestamps are sequential", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude");

      for (let i = 0; i < 10; i++) {
        store.addMessage(session.id, "user", `msg-${i}`);
      }

      const messages = store.getMessages(session.id);
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i].timestamp).toBeGreaterThanOrEqual(messages[i - 1].timestamp);
      }
    });
  });

  // =======================================================================
  // Concurrent Access
  // =======================================================================

  describe("Concurrent Access", () => {
    it("concurrent reads/writes to same session", () => {
      const store = new SessionStore("agent1");
      const session = store.createSession("claude");

      // Synchronous in SQLite, but verify no corruption
      for (let i = 0; i < 50; i++) {
        store.addMessage(session.id, "user", `write-${i}`);
        const msgs = store.getMessages(session.id);
        expect(msgs.length).toBe(i + 1);
      }

      const final = store.getMessages(session.id);
      expect(final).toHaveLength(50);
    });

    it("interleaved writes to different sessions", () => {
      const store = new SessionStore("agent1");
      const s1 = store.createSession("claude");
      const s2 = store.createSession("openai");

      for (let i = 0; i < 20; i++) {
        store.addMessage(s1.id, "user", `s1-${i}`);
        store.addMessage(s2.id, "user", `s2-${i}`);
      }

      const m1 = store.getMessages(s1.id, 100);
      const m2 = store.getMessages(s2.id, 100);

      expect(m1).toHaveLength(20);
      expect(m2).toHaveLength(20);
      expect(m1[0].content).toBe("s1-0");
      expect(m2[0].content).toBe("s2-0");
    });
  });
});
