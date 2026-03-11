/**
 * ACP mode entry point.
 * Initializes the Helios runtime and starts the ACP stdio server.
 * No TUI — pure JSON-RPC over stdin/stdout.
 */

import { createRuntime } from "../init.js";
import { AcpServer } from "./server.js";

const providerArg = (() => {
  const i = process.argv.indexOf("--provider");
  const j = process.argv.indexOf("-p");
  const idx = Math.max(i, j);
  if (idx >= 0) {
    const v = process.argv[idx + 1];
    if (v === "claude" || v === "openai") return v;
  }
  return undefined;
})();

const claudeMode = (() => {
  const i = process.argv.indexOf("--claude-mode");
  if (i >= 0) {
    const v = process.argv[i + 1];
    if (v === "cli" || v === "api") return v;
  }
  return undefined;
})();

// stderr for logs since stdout is the ACP transport
const log = (msg: string) => process.stderr.write(`[helios-acp] ${msg}\n`);

log("Initializing runtime...");

const runtime = await createRuntime({ provider: providerArg, claudeMode });
const server = new AcpServer(runtime);

log("ACP server ready — waiting for initialize request");

// Clean up on exit
process.on("SIGINT", () => {
  server.stop();
  runtime.cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.stop();
  runtime.cleanup();
  process.exit(0);
});

server.start();
