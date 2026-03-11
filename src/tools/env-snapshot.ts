import type { ToolDefinition } from "../providers/types.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { formatError, shellQuote } from "../ui/format.js";

interface Snapshot {
  name: string;
  machineId: string;
  capturedAt: string;
  python: string | null;
  pipPackages: string[] | null;
  gpu: string | null;
  cudaVersion: string | null;
  os: string | null;
  cpu: string | null;
  memory: string | null;
  gitHash: string | null;
  gitDiff: string | null;
  disk: string | null;
}

export function createEnvSnapshotTool(
  executor: RemoteExecutor,
  memoryStore: MemoryStore,
): ToolDefinition {
  return {
    name: "env_snapshot",
    description:
      "Capture a full environment snapshot on a machine for reproducibility. Records Python version, pip packages, GPU info, CUDA version, OS, git hash, and system specs. Stores the snapshot in memory at /snapshots/<name>.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: "Machine to snapshot",
        },
        name: {
          type: "string",
          description:
            'Name for this snapshot (e.g. "baseline", "exp-03-start")',
        },
        repo_path: {
          type: "string",
          description: "Git repo path to capture commit hash from",
        },
        venv_path: {
          type: "string",
          description:
            "Path to venv/conda env for pip freeze (uses system Python if omitted)",
        },
      },
      required: ["machine_id", "name"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const name = args.name as string;
      const repoPath = args.repo_path as string | undefined;
      const venvPath = args.venv_path as string | undefined;

      try {
        const safeExec = async (cmd: string): Promise<string | null> => {
          try {
            const result = await executor.exec(machineId, cmd);
            const output = result.stdout.trim();
            return result.exitCode === 0 && output ? output : null;
          } catch {
            return null;
          }
        };

        // Build pip freeze command
        const pipCmd = venvPath
          ? `${shellQuote(venvPath)}/bin/pip freeze 2>/dev/null`
          : `pip3 freeze 2>/dev/null || pip freeze 2>/dev/null`;

        // Build CPU info command — try macOS sysctl first, fall back to Linux lscpu
        const cpuCmd = `sysctl -n machdep.cpu.brand_string 2>/dev/null || lscpu 2>/dev/null | head -20`;

        // Build git command
        const gitCmd = repoPath
          ? `cd ${shellQuote(repoPath)} && git rev-parse HEAD 2>/dev/null && git diff --stat 2>/dev/null`
          : null;

        // Run all commands in parallel
        const [
          pythonOut,
          pipOut,
          gpuOut,
          cudaOut,
          osOut,
          cpuOut,
          memOut,
          gitOut,
          diskOut,
        ] = await Promise.all([
          safeExec(`python3 --version 2>/dev/null || python --version 2>/dev/null`),
          safeExec(pipCmd),
          safeExec(`nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null`),
          safeExec(`nvcc --version 2>/dev/null`),
          safeExec(`uname -a`),
          safeExec(cpuCmd),
          safeExec(`free -h 2>/dev/null || vm_stat 2>/dev/null`),
          gitCmd ? safeExec(gitCmd) : Promise.resolve(null),
          safeExec(`df -h / 2>/dev/null`),
        ]);

        // Parse pip packages
        const pipPackages = pipOut
          ? pipOut.split("\n").filter((l) => l.includes("==") || l.includes("@"))
          : null;

        // Parse CUDA version from nvcc output
        let cudaVersion: string | null = null;
        if (cudaOut) {
          const match = cudaOut.match(/release\s+([\d.]+)/);
          cudaVersion = match ? match[1] : cudaOut.split("\n").pop()?.trim() ?? null;
        }

        // Parse git hash and diff stat
        let gitHash: string | null = null;
        let gitDiff: string | null = null;
        if (gitOut) {
          const lines = gitOut.split("\n");
          gitHash = lines[0]?.trim() ?? null;
          if (lines.length > 1) {
            gitDiff = lines.slice(1).join("\n").trim() || null;
          }
        }

        // Build structured snapshot
        const snapshot: Snapshot = {
          name,
          machineId,
          capturedAt: new Date().toISOString(),
          python: pythonOut,
          pipPackages,
          gpu: gpuOut ?? "no GPU",
          cudaVersion,
          os: osOut,
          cpu: cpuOut,
          memory: memOut,
          gitHash,
          gitDiff,
          disk: diskOut,
        };

        // Format as readable text block
        const content = formatSnapshot(snapshot);

        // Build one-line gist summary
        const pythonVer = snapshot.python?.replace("Python ", "") ?? "unknown";
        const cudaStr = snapshot.cudaVersion ? `CUDA ${snapshot.cudaVersion}` : "no CUDA";
        const gpuStr =
          snapshot.gpu && snapshot.gpu !== "no GPU"
            ? snapshot.gpu.split(",")[0]?.trim()
            : "no GPU";
        const pipCount = snapshot.pipPackages
          ? `${snapshot.pipPackages.length} pip pkgs`
          : "pip unavailable";
        const gist = `${machineId}: Python ${pythonVer}, ${cudaStr}, ${gpuStr}, ${pipCount}`;

        // Store in memory
        const memoryPath = `/snapshots/${name}`;
        memoryStore.write(memoryPath, gist, content);

        return JSON.stringify({
          summary: gist,
          memory_path: memoryPath,
          snapshot,
        });
      } catch (err) {
        return JSON.stringify({
          error: formatError(err),
          machine_id: machineId,
          name,
        });
      }
    },
  };
}

function formatSnapshot(s: Snapshot): string {
  const lines: string[] = [
    `# Environment Snapshot: ${s.name}`,
    `Machine: ${s.machineId}`,
    `Captured: ${s.capturedAt}`,
    "",
    `## Python`,
    s.python ?? "unavailable",
    "",
    `## GPU`,
    s.gpu ?? "no GPU",
    "",
    `## CUDA`,
    s.cudaVersion ?? "unavailable",
    "",
    `## OS`,
    s.os ?? "unavailable",
    "",
    `## CPU`,
    s.cpu ?? "unavailable",
    "",
    `## Memory`,
    s.memory ?? "unavailable",
    "",
    `## Disk`,
    s.disk ?? "unavailable",
  ];

  if (s.gitHash) {
    lines.push("", `## Git`, `Commit: ${s.gitHash}`);
    if (s.gitDiff) {
      lines.push(`Uncommitted changes:`, s.gitDiff);
    }
  }

  if (s.pipPackages && s.pipPackages.length > 0) {
    lines.push("", `## Pip Packages (${s.pipPackages.length})`, ...s.pipPackages);
  } else {
    lines.push("", `## Pip Packages`, "unavailable");
  }

  return lines.join("\n");
}
