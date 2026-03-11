/**
 * `helios search "query"` — full-text search across all session histories.
 */

import { Effect } from "effect";
import { Command, Args, Options } from "@effect/cli";

const query = Args.text({ name: "query" }).pipe(
  Args.withDescription("Text to search for across all sessions"),
);

const limit = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDescription("Max results to show"),
  Options.withDefault(20),
);

export const search = Command.make(
  "search",
  { query, limit },
  ({ query, limit }) =>
    Effect.promise(async () => {
      const { getDb } = await import("../store/database.js");
      const { truncate } = await import("../ui/format.js");

      const db = getDb();
      const agentId = process.env.AGENTHUB_AGENT ?? "";

      // Search messages with LIKE (SQLite doesn't have full-text by default)
      const rows = db.prepare(
        `SELECT m.session_id, m.role, m.content, m.timestamp, s.provider
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.agent_id = ? AND m.content LIKE ? ESCAPE '\'
         ORDER BY m.timestamp DESC
         LIMIT ?`,
      ).all(agentId, `%${query.replace(/[%_]/g, "\\$&")}%`, limit) as {
        session_id: string;
        role: string;
        content: string;
        timestamp: number;
        provider: string;
      }[];

      if (rows.length === 0) {
        console.log(`No results for "${query}".`);
        return;
      }

      console.log(`Found ${rows.length} result${rows.length > 1 ? "s" : ""} for "${query}":\n`);

      for (const row of rows) {
        const time = new Date(row.timestamp).toLocaleString();
        const roleColor = row.role === "user" ? "\x1b[33m" : row.role === "assistant" ? "\x1b[36m" : "\x1b[2m";

        // Find the query match in context
        const idx = row.content.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, idx - 60);
        const end = Math.min(row.content.length, idx + query.length + 60);
        let snippet = row.content.slice(start, end).replace(/\n/g, " ");
        if (start > 0) snippet = "..." + snippet;
        if (end < row.content.length) snippet = snippet + "...";

        // Highlight the match
        const matchIdx = snippet.toLowerCase().indexOf(query.toLowerCase());
        if (matchIdx >= 0) {
          snippet =
            snippet.slice(0, matchIdx) +
            "\x1b[43m\x1b[30m" +
            snippet.slice(matchIdx, matchIdx + query.length) +
            "\x1b[0m" +
            snippet.slice(matchIdx + query.length);
        }

        console.log(`${roleColor}${row.role}\x1b[0m  \x1b[2m${time}  session:${row.session_id.slice(0, 8)}\x1b[0m`);
        console.log(`  ${snippet}`);
        console.log();
      }
    }),
);
