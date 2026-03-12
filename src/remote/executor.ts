import { ConnectionPool } from "./connection-pool.js";
import type { ExecResult, BackgroundProcess } from "./types.js";

/**
 * High-level remote execution interface.
 * Wraps ConnectionPool with task tracking and convenience methods.
 */
export class RemoteExecutor {
  private backgroundProcesses = new Map<string, BackgroundProcess>();

  constructor(private pool: ConnectionPool) {}

  async exec(
    machineId: string,
    command: string,
    timeoutMs?: number,
  ): Promise<ExecResult> {
    if (timeoutMs) {
      const wrappedCmd = `timeout ${Math.ceil(timeoutMs / 1000)} ${command}`;
      return this.pool.exec(machineId, wrappedCmd);
    }
    return this.pool.exec(machineId, command);
  }

  async execBackground(
    machineId: string,
    command: string,
    logPath?: string,
    opts?: {
      metricNames?: string[];
      metricPatterns?: Record<string, string>;
      groupId?: string;
      groupLabel?: string;
    },
  ): Promise<BackgroundProcess> {
    const result = await this.pool.execBackground(
      machineId,
      command,
      logPath,
    );

    const proc: BackgroundProcess = {
      pid: result.pid,
      machineId,
      command,
      logPath: result.logPath,
      startedAt: Date.now(),
      metricNames: opts?.metricNames,
      metricPatterns: opts?.metricPatterns,
      groupId: opts?.groupId,
      groupLabel: opts?.groupLabel,
    };

    const key = `${machineId}:${result.pid}`;
    this.backgroundProcesses.set(key, proc);
    return proc;
  }

  async isRunning(machineId: string, pid: number): Promise<boolean> {
    return this.pool.isProcessRunning(machineId, pid);
  }

  async tail(
    machineId: string,
    path: string,
    lines = 50,
  ): Promise<string> {
    return this.pool.tailFile(machineId, path, lines);
  }

  getBackgroundProcesses(): BackgroundProcess[] {
    return Array.from(this.backgroundProcesses.values());
  }

  getBackgroundProcess(
    machineId: string,
    pid: number,
  ): BackgroundProcess | undefined {
    return this.backgroundProcesses.get(`${machineId}:${pid}`);
  }

  removeBackgroundProcess(key: string): void {
    this.backgroundProcesses.delete(key);
  }
}
