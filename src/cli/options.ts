/**
 * Shared CLI options used across commands.
 */

import { Options, Args } from "@effect/cli";

// ── Provider & model ─────────────────────────────────────

export const provider = Options.choice("provider", ["claude", "openai"]).pipe(
  Options.withAlias("P"),
  Options.withDescription("Model provider"),
  Options.optional,
);

export const claudeMode = Options.choice("claude-mode", ["cli", "api"]).pipe(
  Options.withDescription("Force Claude auth mode (cli or api)"),
  Options.optional,
);

export const model = Options.text("model").pipe(
  Options.withAlias("m"),
  Options.withDescription("Model to use"),
  Options.optional,
);

// ── Session ──────────────────────────────────────────────

export const continueSession = Options.boolean("continue").pipe(
  Options.withAlias("c"),
  Options.withDescription("Continue most recent conversation"),
  Options.withDefault(false),
);

export const resumeSession = Options.text("resume").pipe(
  Options.withAlias("r"),
  Options.withDescription("Resume a conversation by session ID"),
  Options.optional,
);

// ── Modes ────────────────────────────────────────────────

export const print = Options.boolean("print").pipe(
  Options.withAlias("p"),
  Options.withDescription("Print response and exit (non-interactive)"),
  Options.withDefault(false),
);

export const headless = Options.boolean("headless").pipe(
  Options.withDescription("Compact UI — no input field"),
  Options.withDefault(false),
);

// ── Paths & hub ──────────────────────────────────────────

export const home = Options.directory("home").pipe(
  Options.withDescription("Data directory (default: ~/.helios)"),
  Options.optional,
);

export const hubUrl = Options.text("hub-url").pipe(
  Options.withDescription("AgentHub server URL"),
  Options.optional,
);

export const hubKey = Options.text("hub-key").pipe(
  Options.withDescription("AgentHub API key"),
  Options.optional,
);

export const agent = Options.text("agent").pipe(
  Options.withDescription("Agent identity on AgentHub"),
  Options.optional,
);

// ── Attachments ─────────────────────────────────────────

export const files = Options.text("file").pipe(
  Options.withAlias("f"),
  Options.withDescription("Attach a file (PDF, image). Can be repeated."),
  Options.repeated,
);

// ── Positional ───────────────────────────────────────────

export const prompt = Args.text({ name: "prompt" }).pipe(
  Args.withDescription("Initial prompt to send"),
  Args.optional,
);
