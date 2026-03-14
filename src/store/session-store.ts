import { nanoid } from "nanoid";
import { StmtCache } from "./database.js";
import type { Session } from "../providers/types.js";
import { truncate } from "../ui/format.js";

export interface StoredToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface StoredToolResultMeta {
  callId: string;
  isError?: boolean;
}

export interface StoredMessage {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: string;
  tokenCount?: number;
  model?: string;
  timestamp: number;
}

/** Parse the tool_calls column for an assistant message (array of tool calls). */
export function parseToolCalls(msg: StoredMessage): StoredToolCall[] {
  if (!msg.toolCalls) return [];
  return JSON.parse(msg.toolCalls);
}

/** Parse the tool_calls column for a tool result message (call metadata). */
export function parseToolResultMeta(msg: StoredMessage): StoredToolResultMeta {
  if (!msg.toolCalls) return { callId: "" };
  return JSON.parse(msg.toolCalls);
}

export interface SessionSummary {
  id: string;
  provider: string;
  model: string | null;
  title: string | null;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  firstUserMessage: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const EPHEMERAL_PREFIX = "eph-";

/** Create an in-memory session that is NOT persisted to the database. */
export function createEphemeralSession(providerId: string): Session {
  const now = Date.now();
  return { id: `${EPHEMERAL_PREFIX}${nanoid()}`, providerId, createdAt: now, lastActiveAt: now };
}

/** Check if a session is ephemeral (not persisted). */
export function isEphemeralSession(session: Session): boolean {
  return session.id.startsWith(EPHEMERAL_PREFIX);
}

export class SessionStore {
  private agentId: string;
  private stmts = new StmtCache();
  private stmt(sql: string) { return this.stmts.stmt(sql); }

  constructor(agentId = "") {
    this.agentId = agentId;
  }

  createSession(
    provider: string,
    model?: string,
    providerSessionId?: string,
  ): Session {
    const id = nanoid();
    const now = Date.now();

    this.stmt(
      `INSERT INTO sessions (id, provider, provider_session_id, model, status, created_at, last_active_at, agent_id)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(id, provider, providerSessionId ?? null, model ?? null, now, now, this.agentId);

    return {
      id,
      providerId: provider,
      providerSessionId,
      createdAt: now,
      lastActiveAt: now,
    };
  }

  getSession(id: string): Session | null {
    const row = this.stmt("SELECT * FROM sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      providerId: row.provider as string,
      providerSessionId: row.provider_session_id as string | undefined,
      createdAt: row.created_at as number,
      lastActiveAt: row.last_active_at as number,
    };
  }

  updateProviderSessionId(sessionId: string, providerSessionId: string): void {
    this.stmt("UPDATE sessions SET provider_session_id = ? WHERE id = ?").run(
      providerSessionId,
      sessionId,
    );
  }

  updateProvider(sessionId: string, provider: string): void {
    this.stmt("UPDATE sessions SET provider = ?, provider_session_id = NULL WHERE id = ?").run(
      provider,
      sessionId,
    );
  }

  updateLastActive(sessionId: string): void {
    this.stmt("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
      Date.now(),
      sessionId,
    );
  }

  addCost(sessionId: string, costUsd: number, inputTokens: number, outputTokens: number): void {
    this.stmt(
      `UPDATE sessions SET cost_usd = cost_usd + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?`,
    ).run(costUsd, inputTokens, outputTokens, sessionId);
  }

  addMessage(
    sessionId: string,
    role: StoredMessage["role"],
    content: string,
    opts?: { toolCalls?: string; tokenCount?: number; model?: string },
  ): void {
    this.stmt(
      `INSERT INTO messages (session_id, role, content, tool_calls, token_count, model, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      role,
      content,
      opts?.toolCalls ?? null,
      opts?.tokenCount ?? null,
      opts?.model ?? null,
      Date.now(),
    );
  }

  hasMessages(sessionId: string): boolean {
    const row = this.stmt("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1").get(sessionId);
    return row !== undefined;
  }

  getMessages(sessionId: string, limit = 100): StoredMessage[] {
    const rows = this.stmt(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as number,
      sessionId: row.session_id as string,
      role: row.role as StoredMessage["role"],
      content: row.content as string,
      toolCalls: row.tool_calls as string | undefined,
      tokenCount: row.token_count as number | undefined,
      model: row.model as string | undefined,
      timestamp: row.timestamp as number,
    }));
  }

  getSessionTitle(sessionId: string): string | null {
    const row = this.stmt("SELECT title FROM sessions WHERE id = ?").get(sessionId) as { title: string | null } | undefined;
    return row?.title ?? null;
  }

  updateSessionTitle(sessionId: string, title: string): void {
    this.stmt("UPDATE sessions SET title = ? WHERE id = ?").run(title, sessionId);
  }

  listSessions(limit = 20): Session[] {
    const rows = this.stmt(
        `SELECT * FROM sessions s
         WHERE s.agent_id = ?
           AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
         ORDER BY s.last_active_at DESC LIMIT ?`,
      )
      .all(this.agentId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      providerId: row.provider as string,
      providerSessionId: row.provider_session_id as string | undefined,
      createdAt: row.created_at as number,
      lastActiveAt: row.last_active_at as number,
    }));
  }

  listSessionSummaries(limit = 20): SessionSummary[] {
    const rows = this.stmt(
        `SELECT
           s.id,
           s.provider,
           s.model,
           s.title,
           s.created_at,
           s.last_active_at,
           s.cost_usd,
           s.input_tokens,
           s.output_tokens,
           COUNT(m.id) AS message_count,
           (SELECT m2.content FROM messages m2
            WHERE m2.session_id = s.id AND m2.role = 'user'
            ORDER BY m2.timestamp ASC LIMIT 1) AS first_user_message
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE s.agent_id = ?
         GROUP BY s.id
         HAVING COUNT(m.id) > 0
         ORDER BY s.last_active_at DESC
         LIMIT ?`,
      )
      .all(this.agentId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      provider: row.provider as string,
      model: (row.model as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      createdAt: row.created_at as number,
      lastActiveAt: row.last_active_at as number,
      messageCount: row.message_count as number,
      costUsd: (row.cost_usd as number) ?? 0,
      inputTokens: (row.input_tokens as number) ?? 0,
      outputTokens: (row.output_tokens as number) ?? 0,
      firstUserMessage: row.first_user_message
        ? truncate(row.first_user_message as string, 80, true)
        : null,
    }));
  }
}
