/**
 * `helios report [session-id]` — generate an experiment writeup from session data.
 * Outputs markdown to stdout (pipeable: `helios report > results.md`)
 */

import { Effect, Option } from "effect";
import { Command, Args, Options } from "@effect/cli";

const sessionId = Args.text({ name: "session-id" }).pipe(
  Args.withDescription("Session ID to report on (default: most recent)"),
  Args.optional,
);

const provider = Options.choice("provider", ["claude", "openai"]).pipe(
  Options.withAlias("P"),
  Options.withDescription("Provider to use for generating the writeup"),
  Options.optional,
);

export const report = Command.make(
  "report",
  { sessionId, provider },
  ({ sessionId: sessionIdOpt, provider: providerOpt }) =>
    Effect.promise(async () => {
      const { SessionStore } = await import("../store/session-store.js");
      const { createRuntime } = await import("../init.js");
      const { buildWriteupSystemPrompt } = await import("../tools/writeup.js");

      const agentId = process.env.AGENTHUB_AGENT ?? "";
      const store = new SessionStore(agentId);

      // Resolve session
      const targetId = Option.getOrUndefined(sessionIdOpt);
      let resolvedId: string;

      if (targetId) {
        const session = store.getSession(targetId);
        if (!session) {
          process.stderr.write(`Session "${targetId}" not found.\n`);
          process.exit(1);
        }
        resolvedId = targetId;
      } else {
        const sessions = store.listSessions(1);
        if (sessions.length === 0) {
          process.stderr.write("No sessions found.\n");
          process.exit(1);
        }
        resolvedId = sessions[0].id;
        process.stderr.write(`Using most recent session: ${resolvedId}\n`);
      }

      // Gather session transcript
      const messages = store.getMessages(resolvedId, 10000);
      if (messages.length === 0) {
        process.stderr.write("Session has no messages.\n");
        process.exit(1);
      }

      const transcript = messages
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n\n");

      // Create a runtime to get a provider for the writeup
      const providerName = Option.getOrUndefined(providerOpt) as "claude" | "openai" | undefined;
      const runtime = await createRuntime({ provider: providerName });

      const activeProvider = runtime.orchestrator.currentProvider;
      if (!activeProvider) {
        process.stderr.write("No active provider. Authenticate first with 'helios auth login'.\n");
        runtime.cleanup();
        process.exit(1);
      }

      process.stderr.write("Generating report...\n");

      const session = await activeProvider.createSession({
        systemPrompt: buildWriteupSystemPrompt({ transcript: true }),
      });

      try {
        for await (const event of activeProvider.send(session, transcript, [])) {
          if (event.type === "text" && event.delta) {
            process.stdout.write(event.delta);
          }
        }
        process.stdout.write("\n");
      } finally {
        await activeProvider.closeSession(session).catch(() => {});
        runtime.cleanup();
      }
    }),
);
