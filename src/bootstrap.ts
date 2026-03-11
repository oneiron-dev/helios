#!/usr/bin/env node

// Bootstrap: set env vars from CLI flags BEFORE any module imports.
// paths.ts, hub/config.ts, etc. read env vars at module load time,
// so these must be set before the main entry point imports them.

const argv = process.argv;
const envFlags: [string, string][] = [
  ["--home", "HELIOS_HOME"],
  ["--hub-url", "AGENTHUB_URL"],
  ["--hub-key", "AGENTHUB_KEY"],
  ["--agent", "AGENTHUB_AGENT"],
];

for (const [flag, envVar] of envFlags) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) {
    process.env[envVar] = argv[i + 1];
  }
}

// ACP mode: JSON-RPC over stdio, no TUI — separate entry point
if (argv.includes("--acp")) {
  await import("./acp/entry.js");
} else {
  await import("./cli/index.js");
}
