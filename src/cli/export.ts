/**
 * `helios export` — export metrics and session data to CSV or JSON.
 */

import { Effect, Option } from "effect";
import { Command, Args, Options } from "@effect/cli";

const sessionId = Args.text({ name: "session-id" }).pipe(
  Args.withDescription("Session to export (default: all)"),
  Args.optional,
);

const format = Options.choice("format", ["csv", "json"]).pipe(
  Options.withAlias("f"),
  Options.withDescription("Output format"),
  Options.withDefault("csv" as const),
);

const what = Options.choice("what", ["metrics", "messages", "sessions"]).pipe(
  Options.withAlias("w"),
  Options.withDescription("What to export"),
  Options.withDefault("metrics" as const),
);

/** Escape a value for safe CSV output. */
function csvField(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const exportCmd = Command.make(
  "export",
  { sessionId, format, what },
  ({ sessionId: sessionIdOpt, format, what }) =>
    Effect.promise(async () => {
      const { getDb } = await import("../store/database.js");
      const db = getDb();
      const agentId = process.env.AGENTHUB_AGENT ?? "";
      const targetSession = Option.getOrUndefined(sessionIdOpt);

      switch (what) {
        case "metrics":
          exportMetrics(db, agentId, targetSession, format);
          break;
        case "messages":
          exportMessages(db, agentId, targetSession, format);
          break;
        case "sessions":
          exportSessions(db, agentId, format);
          break;
      }
    }),
);

function exportMetrics(
  db: import("better-sqlite3").Database,
  agentId: string,
  sessionId: string | undefined,
  format: string,
): void {
  const query = `SELECT task_id, metric_name, value, step, timestamp FROM metrics WHERE agent_id = ? ORDER BY timestamp ASC`;
  const params: unknown[] = [agentId];

  if (sessionId) {
    process.stderr.write("Note: session filter is not supported for metrics export (metrics are keyed by task, not session). Exporting all metrics.\n");
  }

  const rows = db.prepare(query).all(...params) as {
    task_id: string;
    metric_name: string;
    value: number;
    step: number | null;
    timestamp: number;
  }[];

  if (rows.length === 0) {
    process.stderr.write("No metrics found.\n");
    return;
  }

  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log("task_id,metric_name,value,step,timestamp");
    for (const r of rows) {
      console.log(`${csvField(r.task_id)},${csvField(r.metric_name)},${r.value},${csvField(r.step)},${r.timestamp}`);
    }
  }
}

function exportMessages(
  db: import("better-sqlite3").Database,
  agentId: string,
  sessionId: string | undefined,
  format: string,
): void {
  let query: string;
  let params: unknown[];

  if (sessionId) {
    query = `SELECT session_id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC`;
    params = [sessionId];
  } else {
    query = `SELECT m.session_id, m.role, m.content, m.timestamp
             FROM messages m JOIN sessions s ON s.id = m.session_id
             WHERE s.agent_id = ? ORDER BY m.timestamp ASC`;
    params = [agentId];
  }

  const rows = db.prepare(query).all(...params) as {
    session_id: string;
    role: string;
    content: string;
    timestamp: number;
  }[];

  if (rows.length === 0) {
    process.stderr.write("No messages found.\n");
    return;
  }

  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log("session_id,role,timestamp,content");
    for (const r of rows) {
      // Escape CSV: wrap in quotes, double internal quotes
      console.log(`${csvField(r.session_id)},${csvField(r.role)},${r.timestamp},${csvField(r.content)}`);
    }
  }
}

function exportSessions(
  db: import("better-sqlite3").Database,
  agentId: string,
  format: string,
): void {
  const rows = db.prepare(
    `SELECT id, provider, model, status, created_at, last_active_at, cost_usd, input_tokens, output_tokens
     FROM sessions WHERE agent_id = ? ORDER BY last_active_at DESC`,
  ).all(agentId) as {
    id: string;
    provider: string;
    model: string | null;
    status: string;
    created_at: number;
    last_active_at: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  }[];

  if (rows.length === 0) {
    process.stderr.write("No sessions found.\n");
    return;
  }

  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log("id,provider,model,status,created_at,last_active_at,cost_usd,input_tokens,output_tokens");
    for (const r of rows) {
      console.log(`${csvField(r.id)},${csvField(r.provider)},${csvField(r.model)},${csvField(r.status)},${r.created_at},${r.last_active_at},${r.cost_usd},${r.input_tokens},${r.output_tokens}`);
    }
  }
}
