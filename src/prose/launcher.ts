import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { execSync } from "node:child_process";
import type { RemoteExecutor } from "../remote/executor.js";
import type { BackgroundProcess } from "../remote/types.js";
import type { ProseRunConfig } from "./types.js";
import { shellQuote } from "../ui/format.js";

export interface ProseSidecar {
  programPath: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  startedByHelios: true;
  launchedAt: string;
}

export interface LaunchResult {
  process: BackgroundProcess;
  runId: string;
}

/** Find the prose binary. Throws if not found. */
export function resolveProseBin(): string {
  if (process.env.PROSE_BIN) {
    if (existsSync(process.env.PROSE_BIN)) return process.env.PROSE_BIN;
    throw new Error(`PROSE_BIN="${process.env.PROSE_BIN}" does not exist.`);
  }

  try {
    return execSync("which prose", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("Prose binary not found. Set PROSE_BIN or install prose globally.");
  }
}

/** Launch a Prose program and return the process + detected run ID. */
export async function launchProseRun(
  programPath: string,
  executor: RemoteExecutor,
  config: ProseRunConfig,
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<LaunchResult> {
  const absPath = resolve(programPath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const proseBin = resolveProseBin();
  const cwd = options?.cwd ?? process.cwd();
  const programName = basename(absPath, ".prose");

  // Snapshot existing run dirs to detect new one
  let existingDirs = new Set<string>();
  if (existsSync(config.runsDir)) {
    try {
      existingDirs = new Set(readdirSync(config.runsDir));
    } catch { /* empty */ }
  }

  // Build env prefix
  const envVars: Record<string, string> = { ...options?.env };
  const heliosRunId = `helios-${Date.now().toString(36)}`;
  envVars.HELIOS_RUN_ID = heliosRunId;

  const envPrefix = Object.entries(envVars)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");

  const cmd = envPrefix
    ? `${envPrefix} ${shellQuote(proseBin)} run ${shellQuote(absPath)}`
    : `${shellQuote(proseBin)} run ${shellQuote(absPath)}`;

  const logPath = join(config.runsDir, `${heliosRunId}.log`);

  const proc = await executor.execBackground("local", cmd, logPath, {
    groupId: `prose:${heliosRunId}`,
    groupLabel: `prose: ${programName}`,
  });

  // Poll for new run directory (up to 10s)
  let detectedRunId = "";
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (existsSync(config.runsDir)) {
      try {
        const currentDirs = readdirSync(config.runsDir);
        const newDir = currentDirs.find((d) => !existingDirs.has(d));
        if (newDir) {
          detectedRunId = newDir;
          break;
        }
      } catch { /* retry */ }
    }
  }

  // Write .helios-run.json sidecar if we detected the run dir
  if (detectedRunId) {
    const sidecarPath = join(config.runsDir, detectedRunId, ".helios-run.json");
    const sidecar: ProseSidecar = {
      programPath: absPath,
      cwd,
      argv: [proseBin, "run", absPath],
      env: envVars,
      startedByHelios: true,
      launchedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf-8");
    } catch { /* non-fatal */ }
  }

  return { process: proc, runId: detectedRunId || heliosRunId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
