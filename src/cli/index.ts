/**
 * Helios CLI — built with @effect/cli.
 *
 * Usage:
 *   helios                          Interactive TUI
 *   helios "prompt"                 TUI with initial prompt
 *   helios -p "prompt"              Print response and exit
 *   helios -c                       Continue most recent session
 *   helios -r <session-id>          Resume specific session
 *   helios auth login|logout|status Auth management
 *   helios sessions                 List recent sessions
 *   helios watch <machine:pid>      Stream task output + metrics
 *   helios replay <session-id>      Replay a past session
 *   helios report [session-id]      Generate experiment writeup
 *   helios init                     Initialize project config
 *   helios doctor                    Diagnose setup
 *   helios search "query"            Search session histories
 *   helios export [session-id]       Export data to CSV/JSON
 *   helios kill <machine:pid>        Kill a running task
 */

import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { VERSION } from "../version.js";
import {
  provider, claudeMode, model,
  continueSession, resumeSession,
  print, headless,
  home, hubUrl, hubKey, agent,
  files, prompt,
} from "./options.js";
import { applyEnv } from "./env.js";
import { run } from "./run.js";
import { auth } from "./auth.js";
import { sessions } from "./sessions.js";
import { watch } from "./watch.js";
import { replay } from "./replay.js";
import { report } from "./report.js";
import { initCmd } from "./init-cmd.js";
import { doctor } from "./doctor.js";
import { search } from "./search.js";
import { exportCmd } from "./export.js";
import { kill } from "./kill.js";

// ── Root command ─────────────────────────────────────────

const helios = Command.make(
  "helios",
  {
    provider, claudeMode, model,
    continueSession, resumeSession,
    print, headless,
    home, hubUrl, hubKey, agent,
    files, prompt,
  },
  (opts) =>
    Effect.gen(function* () {
      // Set env vars before any runtime imports
      applyEnv({
        home: opts.home,
        hubUrl: opts.hubUrl,
        hubKey: opts.hubKey,
        agent: opts.agent,
      });

      yield* run({
        provider: opts.provider,
        claudeMode: opts.claudeMode,
        model: opts.model,
        continueSession: opts.continueSession,
        resumeSession: opts.resumeSession,
        print: opts.print,
        headless: opts.headless,
        files: opts.files,
        prompt: opts.prompt,
      });
    }),
).pipe(
  Command.withSubcommands([auth, sessions, watch, replay, report, initCmd, doctor, search, exportCmd, kill]),
);

// ── Launch ───────────────────────────────────────────────

const cli = Command.run(helios, {
  name: "helios",
  version: `v${VERSION}`,
});

cli(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
);
