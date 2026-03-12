import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { ProseRun, ProseRunConfig } from "./types.js";
import { parseStateMd } from "./parser.js";

export class ProseWatcher extends EventEmitter {
  private config: ProseRunConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runs: Map<string, ProseRun> = new Map();
  private lastSnapshots: Map<string, string> = new Map();

  constructor(config: ProseRunConfig) {
    super();
    this.config = config;
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getRuns(): ProseRun[] {
    return Array.from(this.runs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getRun(id: string): ProseRun | null {
    return this.runs.get(id) ?? null;
  }

  getActiveRuns(): ProseRun[] {
    return this.getRuns().filter((r) => r.status === "running");
  }

  private poll(): void {
    const { runsDir, stalledThresholdMs } = this.config;
    if (!existsSync(runsDir)) return;

    let entries: string[];
    try {
      entries = readdirSync(runsDir);
    } catch {
      return;
    }

    const now = Date.now();

    for (const entry of entries) {
      const runDir = join(runsDir, entry);
      try {
        const stat = statSync(runDir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      const stateMdPath = join(runDir, "state.md");
      const programPath = join(runDir, "program.prose");

      let stateContent = "";
      try {
        stateContent = readFileSync(stateMdPath, "utf-8");
      } catch {
        // No state.md yet — still initializing
        continue;
      }

      // Check if content changed
      const prevSnapshot = this.lastSnapshots.get(entry);
      if (prevSnapshot === stateContent) {
        // Check for stalled
        const existing = this.runs.get(entry);
        if (existing && existing.status === "running") {
          const timeSinceUpdate = now - existing.updatedAt;
          if (timeSinceUpdate > stalledThresholdMs) {
            existing.status = "stalled";
            this.emit("update", existing);
          }
        }
        continue;
      }
      this.lastSnapshots.set(entry, stateContent);

      const parsed = parseStateMd(stateContent);

      const statMtime = safeStatMtime(stateMdPath) ?? now;
      const startedAt = safeStatMtime(runDir) ?? now;

      const programName = existsSync(programPath)
        ? basename(programPath, ".prose")
        : entry;

      const candidateCount = readJsonField<number>(
        join(runDir, "bindings.json"),
        (b) => Object.keys(b.candidates ?? b).length,
      ) ?? 0;

      const pid = readJsonField<number>(
        join(runDir, ".helios-run.json"),
        (s) => s.pid,
      );

      const run: ProseRun = {
        id: entry,
        programPath: existsSync(programPath) ? programPath : "",
        programName,
        status: parsed.status === "running" && (now - statMtime) > stalledThresholdMs ? "stalled" : parsed.status,
        steps: parsed.steps,
        lastLine: parsed.lastLine,
        startedAt,
        updatedAt: statMtime,
        candidateCount,
        pid,
      };

      const prevRun = this.runs.get(entry);
      this.runs.set(entry, run);

      if (!prevRun) {
        this.emit("update", run);
      } else if (prevRun.status !== run.status || prevRun.steps.length !== run.steps.length) {
        this.emit("update", run);
        if (run.status === "done") this.emit("done", run);
        if (run.status === "error") this.emit("error", run);
      }
    }
  }
}

// ─── Module-level helpers ──────────────────────────────

function safeStatMtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function readJsonField<T>(path: string, extract: (data: any) => T): T | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return extract(data);
  } catch {
    return undefined;
  }
}
