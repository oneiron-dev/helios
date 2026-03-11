/**
 * `helios replay <session-id>` — read-only playback of a session's conversation.
 */

import { Effect } from "effect";
import { Command, Args, Options } from "@effect/cli";

const sessionId = Args.text({ name: "session-id" }).pipe(
  Args.withDescription("Session ID to replay (use 'helios sessions' to find IDs)"),
);

const raw = Options.boolean("raw").pipe(
  Options.withDescription("Output raw text without formatting"),
  Options.withDefault(false),
);

export const replay = Command.make(
  "replay",
  { sessionId, raw },
  ({ sessionId, raw }) =>
    Effect.promise(async () => {
      const { SessionStore } = await import("../store/session-store.js");
      const store = new SessionStore(process.env.AGENTHUB_AGENT ?? "");

      const session = store.getSession(sessionId);
      if (!session) {
        console.error(`Session "${sessionId}" not found. Use 'helios sessions' to list sessions.`);
        process.exit(1);
      }

      const messages = store.getMessages(sessionId, 10000);
      if (messages.length === 0) {
        console.log("Session has no messages.");
        return;
      }

      const date = new Date(session.createdAt).toLocaleString();
      const provider = session.providerId;

      if (!raw) {
        console.log(`\x1b[1m── Session ${sessionId} ──\x1b[0m`);
        console.log(`Provider: ${provider}  |  Started: ${date}  |  Messages: ${messages.length}\n`);
      }

      for (const msg of messages) {
        if (raw) {
          console.log(`[${msg.role}] ${msg.content}`);
          continue;
        }

        const time = new Date(msg.timestamp).toLocaleTimeString();
        switch (msg.role) {
          case "user":
            console.log(`\x1b[33m┌─ User \x1b[2m${time}\x1b[0m`);
            console.log(`\x1b[33m│\x1b[0m ${msg.content.split("\n").join("\n\x1b[33m│\x1b[0m ")}`);
            console.log(`\x1b[33m└\x1b[0m`);
            break;
          case "assistant":
            console.log(`\x1b[36m┌─ Helios \x1b[2m${time}\x1b[0m`);
            // Truncate very long assistant messages for readability
            const content = msg.content.length > 2000
              ? msg.content.slice(0, 2000) + `\n... (${msg.content.length - 2000} chars truncated)`
              : msg.content;
            console.log(`\x1b[36m│\x1b[0m ${content.split("\n").join("\n\x1b[36m│\x1b[0m ")}`);
            console.log(`\x1b[36m└\x1b[0m`);
            break;
          case "tool":
            console.log(`\x1b[2m  ⚙ tool ${time}\x1b[0m`);
            const preview = msg.content.length > 200
              ? msg.content.slice(0, 200) + "..."
              : msg.content;
            console.log(`\x1b[2m    ${preview.split("\n").join("\n    ")}\x1b[0m`);
            break;
          case "system":
            console.log(`\x1b[35m  ◈ system: ${msg.content}\x1b[0m`);
            break;
          default:
            console.log(`\x1b[31m  ✗ ${msg.role}: ${msg.content}\x1b[0m`);
            break;
        }
        console.log();
      }
    }),
);
