/**
 * Shared task polling loop used by both TUI and ACP modes.
 * Polls background processes, detects completion, collects final metrics,
 * updates experiment tracker, and fires notifications.
 */

import type { RemoteExecutor } from "../remote/executor.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import type { MetricCollector } from "../metrics/collector.js";
import type { MetricStore } from "../metrics/store.js";
import type { ExperimentTracker } from "../memory/experiment-tracker.js";
import type { Notifier } from "../notifications/notifier.js";
import type { BackgroundProcess } from "../remote/types.js";
import type { MonitorConfig } from "./monitor.js";

export interface TaskStatus {
  proc: BackgroundProcess;
  running: boolean;
}

export interface TaskPollResult {
  statuses: TaskStatus[];
  finished: string[];
}

export interface TaskPollerDeps {
  executor: RemoteExecutor;
  connectionPool: ConnectionPool;
  metricCollector: MetricCollector;
  metricStore: MetricStore;
  experimentTracker: ExperimentTracker;
  notifier: Notifier | null;
}

/**
 * Check all background processes and return their statuses.
 */
export async function pollTaskStatuses(executor: RemoteExecutor): Promise<TaskPollResult> {
  const procs = executor.getBackgroundProcesses();
  const statuses = await Promise.all(
    procs.map(async (proc) => {
      try {
        const running = await executor.isRunning(proc.machineId, proc.pid);
        return { proc, running };
      } catch {
        return { proc, running: true }; // Transient error — assume still running
      }
    }),
  );

  const finished: string[] = [];
  for (const { proc, running } of statuses) {
    if (!running) finished.push(`${proc.machineId}:${proc.pid}`);
  }

  return { statuses, finished };
}

/**
 * Handle finished tasks: get exit codes, update experiment tracker,
 * send notifications, and clean up.
 */
export async function handleFinishedTasks(
  finished: string[],
  deps: TaskPollerDeps,
): Promise<void> {
  const { executor, connectionPool, metricCollector, metricStore, experimentTracker, notifier } = deps;

  // Collect final metrics before cleanup
  if (finished.length > 0) {
    await metricCollector.collectAll().catch(() => {});
  }

  await Promise.all(finished.map(async (key) => {
    const [machineId, pidStr] = key.split(":");
    const pid = parseInt(pidStr, 10);

    let exitCode = 0;
    try {
      // Read exit code from the .exit file written by the launch wrapper
      const proc = executor.getBackgroundProcesses().find(
        (p) => p.machineId === machineId && p.pid === pid,
      );
      if (proc?.logPath) {
        const result = await connectionPool.exec(machineId, `cat ${proc.logPath}.exit 2>/dev/null`);
        const parsed = parseInt(result.stdout.trim(), 10);
        if (!isNaN(parsed)) exitCode = parsed;
      }
    } catch { /* default to 0 */ }

    const metrics = metricStore.getLatestAll(key);
    experimentTracker.updateExperiment(
      machineId, pid, exitCode,
      Object.keys(metrics).length > 0 ? metrics : undefined,
    );

    if (notifier) {
      const event = exitCode === 0 ? "task_complete" : "task_failed";
      notifier.notifyAll({
        event,
        title: exitCode === 0 ? "Task completed" : "Task failed",
        body: `${key} exited with code ${exitCode}`,
        machineId,
        pid,
        metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
        timestamp: Date.now(),
      }).catch(() => {});
    }

    metricCollector.removeSource(key);
    executor.removeBackgroundProcess(key);
  }));
}

/**
 * Build the monitor tick status message from live task/metric state.
 */
export function buildMonitorMessage(
  config: MonitorConfig,
  executor: RemoteExecutor,
  metricStore: MetricStore,
): string {
  const elapsedMin = Math.round((Date.now() - config.startedAt) / 60_000);
  const intervalMin = Math.round(config.intervalMs / 60_000);
  const parts: string[] = [
    `[Monitor check — ${elapsedMin}m elapsed, interval ${intervalMin}m]`,
    `Goal: ${config.goal}`,
  ];

  const procs = executor.getBackgroundProcesses();
  if (procs.length > 0) {
    parts.push("Tasks:");
    for (const p of procs) {
      const short = p.command.length > 50 ? p.command.slice(0, 47) + "..." : p.command;
      parts.push(`  ◆ ${p.machineId}:${p.pid} running — ${short}`);
    }
  }

  const latestMetrics = metricStore.getLatestPerMetric();
  const metricNames = Object.keys(latestMetrics);
  if (metricNames.length > 0) {
    parts.push("Metrics:");
    for (const name of metricNames) {
      parts.push(`  ${name}: ${latestMetrics[name]}`);
    }
  }

  return parts.join("\n");
}
