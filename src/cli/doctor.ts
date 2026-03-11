/**
 * `helios doctor` — diagnose the full Helios setup.
 *
 * Checks auth, machines, storage, project config, and dependencies,
 * printing a clear report with pass/fail/warn indicators.
 */

import { Effect } from "effect";
import { Command } from "@effect/cli";
import { exec as cpExec } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatBytes, formatError } from "../ui/format.js";

// ── Formatting helpers ──────────────────────────────────

const PASS = "\x1b[32m\u2713\x1b[0m";
const FAIL = "\x1b[31m\u2717\x1b[0m";
const WARN = "\x1b[33m\u26A0\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function heading(label: string): void {
  console.log(`\n  ${BOLD}${label}${RESET}`);
}

function pass(msg: string): void {
  console.log(`    ${PASS} ${msg}`);
}

function fail(msg: string): void {
  console.log(`    ${FAIL} ${msg}`);
}

function warn(msg: string): void {
  console.log(`    ${WARN} ${msg}`);
}

function detail(msg: string): void {
  console.log(`      ${DIM}${msg}${RESET}`);
}

/** Run a shell command and return stdout/stderr/exitCode. Never throws. */
function sh(command: string, timeoutMs = 10_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    cpExec(command, { timeout: timeoutMs, shell: "/bin/bash" }, (err, stdout, stderr) => {
      let exitCode = 0;
      if (err) {
        exitCode = typeof err.code === "number" ? err.code : 1;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
    });
  });
}

// ── Section: Auth ───────────────────────────────────────

async function checkAuth(): Promise<void> {
  heading("Auth");

  try {
    const { AuthManager } = await import("../providers/auth/auth-manager.js");
    const authManager = new AuthManager();

    // Claude
    try {
      const claudeAuth = authManager.isAuthenticated("claude");
      if (claudeAuth) {
        const creds = authManager.tokenStore.get("claude");
        const method = creds?.method === "oauth" ? "OAuth" : "API key";
        pass(`Claude: authenticated (${method})`);
      } else {
        fail("Claude: not authenticated");
      }
    } catch (e) {
      fail(`Claude: error checking auth (${formatError(e)})`);
    }

    // OpenAI
    try {
      const openaiAuth = authManager.isAuthenticated("openai");
      if (openaiAuth) {
        const creds = authManager.tokenStore.get("openai");
        const method = creds?.method === "oauth" ? "OAuth" : "API key";
        const expired = authManager.tokenStore.isExpired("openai");
        if (expired) {
          warn(`OpenAI: authenticated (${method}, token expired — will attempt refresh)`);
        } else {
          pass(`OpenAI: authenticated (${method})`);
        }
      } else {
        fail("OpenAI: not authenticated");
      }
    } catch (e) {
      fail(`OpenAI: error checking auth (${formatError(e)})`);
    }
  } catch (e) {
    fail(`Could not load auth system (${formatError(e)})`);
  }
}

// ── Section: Machines ───────────────────────────────────

async function checkMachines(): Promise<void> {
  heading("Machines");

  try {
    const { ConnectionPool } = await import("../remote/connection-pool.js");
    const { loadMachines } = await import("../remote/config.js");

    const pool = new ConnectionPool();
    const machines = loadMachines();

    // Add configured machines
    for (const machine of machines) {
      pool.addMachine(machine);
    }

    // Always check local first
    const ids = ["local", ...machines.map((m) => m.id)];

    for (const id of ids) {
      if (id === "local") {
        // Local is always connected
        pass("local: connected");
        await checkMachineDetails(pool, id);
      } else {
        // Try to connect to remote machines
        try {
          await pool.connect(id);
          const status = pool.getStatus(id);
          if (status.connected) {
            pass(`${id}: connected`);
            await checkMachineDetails(pool, id);
          } else {
            fail(`${id}: not connected${status.error ? ` (${status.error})` : ""}`);
          }
        } catch (e) {
          fail(`${id}: connection failed (${formatError(e)})`);
        }
      }
    }

    // Cleanup remote connections
    pool.disconnectAll();
  } catch (e) {
    fail(`Could not load machine config (${formatError(e)})`);
  }
}

async function checkMachineDetails(pool: { exec(id: string, cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> }, id: string): Promise<void> {
  // Detect if the machine is macOS
  const isMac = id === "local"
    ? process.platform === "darwin"
    : await pool.exec(id, "uname -s 2>/dev/null").then(
        (r) => r.exitCode === 0 && r.stdout.trim().toLowerCase() === "darwin",
        () => false,
      );

  // Run GPU, Python, CUDA checks in parallel
  const gpuCmd = isMac
    ? "system_profiler SPDisplaysDataType 2>/dev/null"
    : "nvidia-smi --query-gpu=name,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null";

  const [gpuResult, pyResult, cudaResult] = await Promise.all([
    pool.exec(id, gpuCmd).catch(() => null),
    pool.exec(id, "python3 --version 2>/dev/null || python --version 2>/dev/null").catch(() => null),
    isMac ? null : pool.exec(id, "nvcc --version 2>/dev/null | grep -i release").catch(() => null),
  ]);

  // GPU info
  let gpuFound = false;
  if (gpuResult && gpuResult.exitCode === 0 && gpuResult.stdout.trim()) {
    if (isMac) {
      gpuFound = parseMacGpu(gpuResult.stdout);
    } else {
      gpuFound = parseNvidiaGpu(gpuResult.stdout);
    }
  }
  if (!gpuFound) {
    detail("GPU: none detected");
  }

  // Python version
  if (pyResult && pyResult.exitCode === 0 && pyResult.stdout.trim()) {
    const ver = pyResult.stdout.trim().replace(/^Python\s+/i, "");
    detail(`Python: ${ver}`);
  } else {
    detail("Python: not found");
  }

  // CUDA version (only relevant for NVIDIA machines)
  if (cudaResult && cudaResult.exitCode === 0 && cudaResult.stdout.trim()) {
    const match = cudaResult.stdout.match(/release\s+([\d.]+)/i);
    if (match) {
      detail(`CUDA: ${match[1]}`);
    }
  }
}

/** Parse nvidia-smi CSV output and print GPU details. Returns true if any GPUs found. */
function parseNvidiaGpu(stdout: string): boolean {
  let found = false;
  for (const line of stdout.trim().split("\n")) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length >= 4) {
      const [name, memMb, utilPct, tempC] = parts;
      const memGb = (parseInt(memMb, 10) / 1024).toFixed(0);
      detail(`GPU: ${name} (${memGb}GB), util ${utilPct}%, temp ${tempC}\u00B0C`);
      found = true;
    } else if (parts.length >= 2) {
      const [name, memMb] = parts;
      const memGb = (parseInt(memMb, 10) / 1024).toFixed(0);
      detail(`GPU: ${name} (${memGb}GB)`);
      found = true;
    }
  }
  return found;
}

/** Parse macOS system_profiler SPDisplaysDataType output. Returns true if any GPUs found. */
function parseMacGpu(stdout: string): boolean {
  let found = false;
  const blocks = stdout.split(/(?=Chipset Model:)/);
  for (const block of blocks) {
    const nameMatch = block.match(/Chipset Model:\s*(.+)/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const parts: string[] = [name];

    // VRAM (discrete GPUs, Intel Macs with AMD)
    const vramMatch = block.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
    if (vramMatch) {
      const vram = vramMatch[2].toUpperCase() === "GB"
        ? `${vramMatch[1]}GB`
        : `${(parseInt(vramMatch[1], 10) / 1024).toFixed(0)}GB`;
      parts.push(vram);
    }

    // Metal support
    const metalMatch = block.match(/Metal.*?:\s*(.+)/i);
    if (metalMatch) {
      parts.push(`Metal: ${metalMatch[1].trim()}`);
    }

    detail(`GPU: ${parts.join(", ")}`);
    found = true;
  }
  return found;
}

// ── Section: Storage ────────────────────────────────────

async function checkStorage(): Promise<void> {
  heading("Storage");

  try {
    const { HELIOS_DIR } = await import("../paths.js");
    const dbPath = join(HELIOS_DIR, "helios.db");

    // Database check
    if (existsSync(dbPath)) {
      try {
        const stats = statSync(dbPath);
        const sizeStr = formatBytes(stats.size);

        // Count sessions with a lightweight query
        let sessionCount: number | null = null;
        try {
          const { getDb } = await import("../store/database.js");
          const db = getDb();
          const agentId = process.env.AGENTHUB_AGENT ?? "";
          const row = db.prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE agent_id = ?").get(agentId) as { cnt: number } | undefined;
          sessionCount = row?.cnt ?? null;
        } catch {
          // Database may be locked or corrupted
        }

        const sessionInfo = sessionCount !== null ? `, ${sessionCount} session${sessionCount !== 1 ? "s" : ""}` : "";
        pass(`Database: ${dbPath} (${sizeStr}${sessionInfo})`);
      } catch (e) {
        warn(`Database: exists at ${dbPath} but could not stat (${formatError(e)})`);
      }
    } else {
      warn(`Database: not found at ${dbPath} (will be created on first run)`);
    }

    // Disk space
    try {
      const dfResult = await sh(`df -h "${HELIOS_DIR}" 2>/dev/null | tail -1`);
      if (dfResult.exitCode === 0 && dfResult.stdout.trim()) {
        const parts = dfResult.stdout.trim().split(/\s+/);
        if (parts.length >= 5) {
          const size = parts[1];
          const used = parts[2];
          const avail = parts[3];
          const pct = parts[4];
          pass(`Disk: ${used} used / ${size} total (${pct}), ${avail} available`);
        } else {
          warn("Disk: could not parse df output");
        }
      } else {
        warn("Disk: could not check disk space");
      }
    } catch {
      warn("Disk: could not check disk space");
    }
  } catch (e) {
    fail(`Could not load paths (${formatError(e)})`);
  }
}

// ── Section: Project ────────────────────────────────────

async function checkProject(): Promise<void> {
  heading("Project");

  try {
    const { findProjectConfigPath, findProjectConfig } = await import("../config/project.js");
    const configPath = findProjectConfigPath();

    if (configPath) {
      const config = findProjectConfig();

      if (config) {
        pass(`helios.json found at ${configPath}`);

        const parts: string[] = [];
        if (config.provider) parts.push(`Provider: ${config.provider}`);
        if (config.model) parts.push(`Model: ${config.model}`);
        if (config.metricNames?.length) parts.push(`Metrics: ${config.metricNames.join(", ")}`);
        if (config.defaultMachine) parts.push(`Machine: ${config.defaultMachine}`);
        if (parts.length > 0) {
          detail(parts.join(", "));
        }
        if (config.instructions) {
          detail(`Custom instructions: ${config.instructions.length} chars`);
        }
        if (config.notifications) {
          detail(`Notifications: ${config.notifications.channels.length} channel(s) configured`);
        }
      } else {
        warn(`helios.json found at ${configPath} but could not parse`);
      }
    } else {
      fail("helios.json not found (searched up from cwd)");
    }
  } catch (e) {
    fail(`Error checking project config (${formatError(e)})`);
  }
}

// ── Section: Dependencies ───────────────────────────────

async function checkDependencies(): Promise<void> {
  heading("Dependencies");

  const deps = ["ssh", "rsync", "git"];

  // Check all dependencies in parallel
  const results = await Promise.all(
    deps.map(async (dep) => {
      try {
        const result = await sh(`which ${dep} 2>/dev/null`);
        return { dep, found: result.exitCode === 0 && !!result.stdout.trim() };
      } catch {
        return { dep, found: false, error: true };
      }
    }),
  );

  for (const { dep, found, error } of results as { dep: string; found: boolean; error?: boolean }[]) {
    if (error) {
      fail(`${dep}: could not check`);
    } else if (found) {
      pass(`${dep}: available`);
    } else {
      fail(`${dep}: not found`);
    }
  }
}

// ── Command ─────────────────────────────────────────────

export const doctor = Command.make(
  "doctor",
  {},
  () =>
    Effect.promise(async () => {
      console.log("\nhelios doctor\n");

      await checkAuth();
      await checkMachines();
      await checkStorage();
      await checkProject();
      await checkDependencies();

      console.log(""); // trailing newline
    }),
);
