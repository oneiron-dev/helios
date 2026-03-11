/**
 * `helios sessions` — list recent sessions.
 */

import { Effect } from "effect";
import { Command, Options } from "@effect/cli";

const limit = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDescription("Number of sessions to show"),
  Options.withDefault(20),
);

export const sessions = Command.make(
  "sessions",
  { limit },
  ({ limit }) =>
    Effect.promise(async () => {
      const { SessionStore } = await import("../store/session-store.js");
      const store = new SessionStore(process.env.AGENTHUB_AGENT ?? "");
      const summaries = store.listSessionSummaries(limit);

      if (summaries.length === 0) {
        console.log("No sessions found.");
        return;
      }

      const pad = (s: string, n: number) => s.padEnd(n);
      const formatDate = (ts: number) => new Date(ts).toLocaleString();
      const formatCost = (c: number) => c > 0 ? `$${c.toFixed(4)}` : "—";

      console.log(
        pad("ID", 24) +
        pad("Provider", 10) +
        pad("Msgs", 6) +
        pad("Cost", 10) +
        pad("Last Active", 24) +
        "First Message",
      );
      console.log("─".repeat(110));

      for (const s of summaries) {
        console.log(
          pad(s.id, 24) +
          pad(s.provider, 10) +
          pad(String(s.messageCount), 6) +
          pad(formatCost(s.costUsd), 10) +
          pad(formatDate(s.lastActiveAt), 24) +
          (s.firstUserMessage ?? "(no messages)").split("\n")[0].slice(0, 60),
        );
      }

      const totalCost = summaries.reduce((sum, s) => sum + s.costUsd, 0);
      if (totalCost > 0) {
        console.log(`\nTotal cost across ${summaries.length} sessions: $${totalCost.toFixed(4)}`);
      }
    }),
);
