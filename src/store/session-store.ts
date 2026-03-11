import { nanoid } from "nanoid";
import { getDb } from "./database.js";
import type { Session } from "../providers/types.js";
import { truncate } from "../ui/format.js";

export interface StoredMessage {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: string;
  tokenCount?: number;
  timestamp: number;
}

export interface SessionSummary {
  id: string;
  provider: string;
  model: string | null;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  firstUserMessage: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export class SessionStore {
  private agentId: string;

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
    const db = getDb();

    db.prepare(
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
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
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

  updateLastActive(sessionId: string): void {
    const db = getDb();
    db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
      Date.now(),
      sessionId,
    );
  }

  addCost(sessionId: string, costUsd: number, inputTokens: number, outputTokens: number): void {
    const db = getDb();
    db.prepare(
      `UPDATE sessions SET cost_usd = cost_usd + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?`,
    ).run(costUsd, inputTokens, outputTokens, sessionId);
  }

  addMessage(
    sessionId: string,
    role: StoredMessage["role"],
    content: string,
    toolCalls?: string,
    tokenCount?: number,
  ): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO messages (session_id, role, content, tool_calls, token_count, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      role,
      content,
      toolCalls ?? null,
      tokenCount ?? null,
      Date.now(),
    );
  }

  getMessages(sessionId: string, limit = 100): StoredMessage[] {
    const db = getDb();
    const rows = db
      .prepare(
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
      timestamp: row.timestamp as number,
    }));
  }

  listSessions(limit = 20): Session[] {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM sessions WHERE agent_id = ? ORDER BY last_active_at DESC LIMIT ?",
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
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT
           s.id,
           s.provider,
           s.model,
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
         ORDER BY s.last_active_at DESC
         LIMIT ?`,
      )
      .all(this.agentId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      provider: row.provider as string,
      model: (row.model as string | null) ?? null,
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
