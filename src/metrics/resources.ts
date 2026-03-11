import type { ConnectionPool } from "../remote/connection-pool.js";

export interface GpuInfo {
  index: number;
  name: string;
  utilization: number | null;  // percent 0-100, null if unavailable
  memoryUsed: number;   // MiB
  memoryTotal: number;  // MiB
  temperature: number;  // Celsius
}

export interface MachineResources {
  machineId: string;
  timestamp: number;
  gpus: GpuInfo[];
  cpuPercent: number | null;    // 0-100, null if unavailable
  memoryUsed: number | null;    // bytes
  memoryTotal: number | null;   // bytes
  diskUsed: number | null;      // bytes
  diskTotal: number | null;     // bytes
}

export class ResourceCollector {
  private pool: ConnectionPool;
  private _systemProfilerCache: GpuInfo[] | null = null;
  private _remoteOsCache = new Map<string, boolean>(); // machineId → isMac

  constructor(pool: ConnectionPool) {
    this.pool = pool;
  }

  async collect(machineId: string): Promise<MachineResources> {
    const isMac = await this.detectIsMac(machineId);

    const [gpus, cpu, memory, disk] = await Promise.all([
      this.collectGpu(machineId, isMac),
      this.collectCpu(machineId, isMac),
      this.collectMemory(machineId, isMac),
      this.collectDisk(machineId, isMac),
    ]);

    return {
      machineId,
      timestamp: Date.now(),
      gpus,
      cpuPercent: cpu,
      memoryUsed: memory.used,
      memoryTotal: memory.total,
      diskUsed: disk.used,
      diskTotal: disk.total,
    };
  }

  private async detectIsMac(machineId: string): Promise<boolean> {
    if (machineId === "local") return process.platform === "darwin";
    const cached = this._remoteOsCache.get(machineId);
    if (cached !== undefined) return cached;
    try {
      const { stdout, exitCode } = await this.pool.exec(machineId, "uname -s");
      const isMac = exitCode === 0 && stdout.trim().toLowerCase() === "darwin";
      this._remoteOsCache.set(machineId, isMac);
      return isMac;
    } catch {
      // Default to Linux if detection fails
      this._remoteOsCache.set(machineId, false);
      return false;
    }
  }

  async collectAll(): Promise<Map<string, MachineResources>> {
    const ids = this.pool.getMachineIds();
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await this.collect(id)] as const;
        } catch {
          // If we can't reach a machine, return a skeleton with nulls
          return [id, {
            machineId: id,
            timestamp: Date.now(),
            gpus: [] as GpuInfo[],
            cpuPercent: null,
            memoryUsed: null,
            memoryTotal: null,
            diskUsed: null,
            diskTotal: null,
          } satisfies MachineResources] as const;
        }
      }),
    );
    return new Map(results);
  }

  // ---------------------------------------------------------------------------
  // GPU
  // ---------------------------------------------------------------------------

  private async collectGpu(machineId: string, isMac: boolean): Promise<GpuInfo[]> {
    if (isMac) {
      return this.collectGpuMac(machineId);
    }

    try {
      const { stdout, exitCode } = await this.pool.exec(
        machineId,
        "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null",
      );
      if (exitCode === 0 && stdout.trim()) {
        return this.parseGpuOutput(stdout);
      }
    } catch {
      // nvidia-smi not available
    }

    return [];
  }

  private async collectGpuMac(machineId: string): Promise<GpuInfo[]> {
    // Prefer macmon (brew install macmon) — gives live GPU utilization, temp, power
    try {
      const { stdout, exitCode } = await this.pool.exec(
        machineId,
        "macmon pipe -s 1 2>/dev/null | head -1",
      );
      if (exitCode === 0 && stdout.trim()) {
        const parsed = this.parseMacmonOutput(stdout);
        if (parsed) return parsed;
      }
    } catch {
      // macmon not installed — fall back
    }

    // Fallback: system_profiler (static info only — no utilization or temp)
    // Cached because hardware info doesn't change at runtime.
    if (this._systemProfilerCache) return this._systemProfilerCache;
    try {
      const { stdout, exitCode } = await this.pool.exec(
        machineId,
        "system_profiler SPDisplaysDataType 2>/dev/null",
      );
      if (exitCode !== 0 || !stdout.trim()) return [];

      const gpus: GpuInfo[] = [];
      const blocks = stdout.split(/(?=Chipset Model:)/);

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const nameMatch = block.match(/Chipset Model:\s*(.+)/);
        if (!nameMatch) continue;

        const name = nameMatch[1].trim();

        let memoryTotal = 0;
        const vramMatch = block.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
        if (vramMatch) {
          memoryTotal = parseInt(vramMatch[1], 10);
          if (vramMatch[2].toUpperCase() === "GB") memoryTotal *= 1024;
        }

        gpus.push({
          index: i,
          name,
          utilization: null,   // unavailable (install macmon for live stats)
          memoryUsed: 0,
          memoryTotal,
          temperature: 0,
        });
      }

      if (gpus.length > 0 && gpus[0].utilization === null) this.warnMacmon();

      this._systemProfilerCache = gpus;
      return gpus;
    } catch {
      return [];
    }
  }

  /** Parse a single JSON line from `macmon pipe -s 1` */
  private parseMacmonOutput(raw: string): GpuInfo[] | null {
    try {
      // macmon pipe outputs one JSON object per sample; take the last complete line
      const lines = raw.trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      const data = JSON.parse(last) as {
        gpu_usage?: [number, number]; // [freq_mhz, usage_ratio 0-1]
        temp?: { gpu_temp_avg?: number };
        memory?: { ram_total?: number; ram_usage?: number };
        gpu_power?: number;
      };

      if (!data.gpu_usage) return null;

      const [freqMhz, usageRatio] = data.gpu_usage;
      const utilization = Math.round(usageRatio * 100);
      const temperature = Math.round(data.temp?.gpu_temp_avg ?? 0);

      // Apple Silicon uses unified memory — report system RAM as GPU memory (in MiB)
      const memoryTotal = data.memory?.ram_total
        ? Math.round(data.memory.ram_total / (1024 * 1024))
        : 0;
      const memoryUsed = data.memory?.ram_usage
        ? Math.round(data.memory.ram_usage / (1024 * 1024))
        : 0;

      return [{
        index: 0,
        name: `Apple GPU (${freqMhz}MHz)`,
        utilization,
        memoryUsed,
        memoryTotal,
        temperature,
      }];
    } catch {
      return null;
    }
  }

  private _macmonWarned = false;
  private warnMacmon(): void {
    if (this._macmonWarned) return;
    this._macmonWarned = true;
    process.stderr.write(
      "[helios] Tip: install macmon for live GPU utilization & temperature on Apple Silicon\n" +
      "[helios]   brew install macmon\n",
    );
  }

  private parseGpuOutput(raw: string): GpuInfo[] {
    const gpus: GpuInfo[] = [];
    for (const line of raw.trim().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(",").map((s) => s.trim());
      if (parts.length < 6) continue;

      const index = parseInt(parts[0], 10);
      const name = parts[1];
      const utilization = parseFloat(parts[2]);
      const memoryUsed = parseFloat(parts[3]);
      const memoryTotal = parseFloat(parts[4]);
      const temperature = parseFloat(parts[5]);

      if (isNaN(index)) continue;

      gpus.push({
        index,
        name,
        utilization: isNaN(utilization) ? 0 : utilization,
        memoryUsed: isNaN(memoryUsed) ? 0 : memoryUsed,
        memoryTotal: isNaN(memoryTotal) ? 0 : memoryTotal,
        temperature: isNaN(temperature) ? 0 : temperature,
      });
    }
    return gpus;
  }

  // ---------------------------------------------------------------------------
  // CPU
  // ---------------------------------------------------------------------------

  private async collectCpu(machineId: string, isMac: boolean): Promise<number | null> {
    try {
      if (isMac) {
        return await this.collectCpuMac(machineId);
      }
      return await this.collectCpuLinux(machineId);
    } catch {
      return null;
    }
  }

  private async collectCpuMac(machineId: string): Promise<number | null> {
    const { stdout, exitCode } = await this.pool.exec(
      machineId,
      'top -l 1 -n 0 | grep "CPU usage"',
    );
    if (exitCode !== 0 || !stdout.trim()) return null;

    // Example: "CPU usage: 5.26% user, 10.52% sys, 84.21% idle"
    const userMatch = stdout.match(/([\d.]+)%\s*user/);
    const sysMatch = stdout.match(/([\d.]+)%\s*sys/);

    const user = userMatch ? parseFloat(userMatch[1]) : 0;
    const sys = sysMatch ? parseFloat(sysMatch[1]) : 0;

    const total = user + sys;
    if (isNaN(total)) return null;
    return Math.min(100, Math.max(0, total));
  }

  private async collectCpuLinux(machineId: string): Promise<number | null> {
    // We need two snapshots to calculate CPU usage, but a single /proc/stat read
    // only gives cumulative counters. Take two readings 500ms apart.
    const read = async (): Promise<number[] | null> => {
      const { stdout, exitCode } = await this.pool.exec(machineId, "grep 'cpu ' /proc/stat");
      if (exitCode !== 0 || !stdout.trim()) return null;
      // "cpu  user nice system idle iowait irq softirq steal ..."
      const parts = stdout.trim().split(/\s+/).slice(1).map(Number);
      if (parts.some(isNaN)) return null;
      return parts;
    };

    const first = await read();
    if (!first) return null;

    // Brief pause for a delta measurement
    await new Promise((r) => setTimeout(r, 500));

    const second = await read();
    if (!second) return null;

    const idle1 = first[3] + (first[4] ?? 0); // idle + iowait
    const idle2 = second[3] + (second[4] ?? 0);
    const total1 = first.reduce((a, b) => a + b, 0);
    const total2 = second.reduce((a, b) => a + b, 0);

    const totalDelta = total2 - total1;
    const idleDelta = idle2 - idle1;

    if (totalDelta <= 0) return null;

    const percent = ((totalDelta - idleDelta) / totalDelta) * 100;
    return Math.min(100, Math.max(0, Math.round(percent * 100) / 100));
  }

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------

  private async collectMemory(
    machineId: string,
    isMac: boolean,
  ): Promise<{ used: number | null; total: number | null }> {
    try {
      if (isMac) {
        return await this.collectMemoryMac(machineId);
      }
      return await this.collectMemoryLinux(machineId);
    } catch {
      return { used: null, total: null };
    }
  }

  private async collectMemoryMac(
    machineId: string,
  ): Promise<{ used: number | null; total: number | null }> {
    // Get total physical memory
    const [vmResult, totalResult] = await Promise.all([
      this.pool.exec(machineId, "vm_stat"),
      this.pool.exec(machineId, "sysctl -n hw.memsize"),
    ]);

    let total: number | null = null;
    if (totalResult.exitCode === 0 && totalResult.stdout.trim()) {
      const parsed = parseInt(totalResult.stdout.trim(), 10);
      if (!isNaN(parsed)) total = parsed;
    }

    if (vmResult.exitCode !== 0 || !vmResult.stdout.trim()) {
      return { used: null, total };
    }

    // Parse vm_stat output — values are in page counts
    // "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
    const pageSizeMatch = vmResult.stdout.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

    const extract = (key: string): number => {
      const re = new RegExp(`${key}:\\s+(\\d+)`);
      const m = vmResult.stdout.match(re);
      return m ? parseInt(m[1], 10) : 0;
    };

    const free = extract("Pages free");
    const speculative = extract("Pages speculative");
    const inactive = extract("Pages inactive");

    // "Used" = total minus free/inactive/speculative pages
    const freeBytes = (free + speculative + inactive) * pageSize;
    const used = total !== null ? total - freeBytes : null;

    return { used: used !== null && used >= 0 ? used : null, total };
  }

  private async collectMemoryLinux(
    machineId: string,
  ): Promise<{ used: number | null; total: number | null }> {
    const { stdout, exitCode } = await this.pool.exec(machineId, "free -b");
    if (exitCode !== 0 || !stdout.trim()) return { used: null, total: null };

    // "Mem:   total   used   free   shared  buff/cache  available"
    const memLine = stdout.split("\n").find((l) => l.startsWith("Mem:"));
    if (!memLine) return { used: null, total: null };

    const parts = memLine.split(/\s+/);
    // parts: ["Mem:", total, used, free, shared, buff/cache, available]
    const total = parseInt(parts[1], 10);
    const available = parseInt(parts[6], 10);

    if (isNaN(total)) return { used: null, total: null };

    // Used = total - available (gives a more meaningful "used" than the raw used column)
    const used = !isNaN(available) ? total - available : parseInt(parts[2], 10);

    return {
      used: !isNaN(used) && used >= 0 ? used : null,
      total,
    };
  }

  // ---------------------------------------------------------------------------
  // Disk
  // ---------------------------------------------------------------------------

  private async collectDisk(
    machineId: string,
    isMac: boolean,
  ): Promise<{ used: number | null; total: number | null }> {
    try {
      // Try Linux byte-based output first, fall back to 1K blocks for macOS
      const { stdout, exitCode } = await this.pool.exec(
        machineId,
        "df -B1 / 2>/dev/null || df -k /",
      );
      if (exitCode !== 0 || !stdout.trim()) return { used: null, total: null };

      return this.parseDfOutput(stdout, isMac);
    } catch {
      return { used: null, total: null };
    }
  }

  private parseDfOutput(
    raw: string,
    isMac: boolean,
  ): { used: number | null; total: number | null } {
    const lines = raw.trim().split("\n");
    // The header is the first line; data is on the second (possibly continued)
    // We join all non-header lines in case the output wraps
    if (lines.length < 2) return { used: null, total: null };

    const dataLine = lines.slice(1).join(" ");
    const parts = dataLine.split(/\s+/);

    // Typical df columns: Filesystem 1B-blocks/1K-blocks Used Available Use% Mounted
    // We want columns at index 1 (total), 2 (used)
    if (parts.length < 4) return { used: null, total: null };

    let total = parseInt(parts[1], 10);
    let used = parseInt(parts[2], 10);

    if (isNaN(total) || isNaN(used)) return { used: null, total: null };

    // If df -B1 failed and we got df -k output, values are in 1K blocks
    // Detect: if the header contains "1K-blocks" or "1024-blocks" or if we're
    // on macOS (df -B1 doesn't exist on macOS), multiply by 1024.
    const header = lines[0];
    const isKiloBlocks =
      isMac ||
      header.includes("1K-blocks") ||
      header.includes("1024-blocks");

    if (isKiloBlocks) {
      total *= 1024;
      used *= 1024;
    }

    return {
      total: total >= 0 ? total : null,
      used: used >= 0 ? used : null,
    };
  }
}
