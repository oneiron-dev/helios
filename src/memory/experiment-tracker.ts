import type { MemoryStore } from "./memory-store.js";
import type { AgentEvent } from "../providers/types.js";
import { truncate } from "../ui/format.js";

interface PendingExperiment {
  name: string;
  machineId: string;
  pid: number;
  command: string;
  metricNames?: string[];
  metricPatterns?: Record<string, string>;
  startedAt: number;
}

/**
 * Auto-populates /experiments/ in memory when remote_exec_background is called.
 * Listens to tool_call and tool_result events from the orchestrator.
 */
export class ExperimentTracker {
  private memory: MemoryStore;
  private experimentCount: number | null = null; // null = not yet initialized
  private pendingCalls = new Map<string, Record<string, unknown>>();
  private experiments = new Map<string, PendingExperiment>(); // "machine:pid" → experiment

  constructor(memory: MemoryStore) {
    this.memory = memory;
  }

  private getNextCount(): number {
    if (this.experimentCount === null) {
      // Lazy init — session ID should be set by now
      const existing = this.memory.ls("/experiments/");
      this.experimentCount = existing.length;
    }
    this.experimentCount++;
    return this.experimentCount;
  }

  /** Call this for every AgentEvent from the orchestrator. */
  onEvent(event: AgentEvent): void {
    if (event.type === "tool_call" && event.name === "remote_exec_background") {
      this.pendingCalls.set(event.id, event.args);
    }

    if (event.type === "tool_result" && this.pendingCalls.has(event.callId)) {
      const args = this.pendingCalls.get(event.callId)!;
      this.pendingCalls.delete(event.callId);

      if (event.isError) return;

      try {
        const result = JSON.parse(event.result);
        if (!result.pid) return;

        const num = String(this.getNextCount()).padStart(2, "0");
        const name = slugify(args.command as string);
        const path = `/experiments/${num}-${name}`;
        const key = `${result.machine_id ?? args.machine_id}:${result.pid}`;

        const experiment: PendingExperiment = {
          name: `${num}-${name}`,
          machineId: (result.machine_id ?? args.machine_id) as string,
          pid: result.pid as number,
          command: args.command as string,
          metricNames: args.metric_names as string[] | undefined,
          metricPatterns: args.metric_patterns as Record<string, string> | undefined,
          startedAt: Date.now(),
        };

        this.experiments.set(key, experiment);

        const gist = `${experiment.machineId}:${experiment.pid} — ${truncate(experiment.command, 50)}`;
        const content = [
          `command: ${experiment.command}`,
          `machine: ${experiment.machineId}`,
          `pid: ${experiment.pid}`,
          experiment.metricNames ? `metrics: ${experiment.metricNames.join(", ")}` : null,
          `status: running`,
          `started: ${new Date(experiment.startedAt).toISOString()}`,
        ]
          .filter(Boolean)
          .join("\n");

        this.memory.write(path, gist, content);
      } catch {
        // Parse failure — skip
      }
    }
  }

  /** Update an experiment with final results (call when a task completes). */
  updateExperiment(
    machineId: string,
    pid: number,
    exitCode: number,
    metrics?: Record<string, number>,
  ): void {
    const key = `${machineId}:${pid}`;
    const experiment = this.experiments.get(key);
    if (!experiment) return;

    const path = `/experiments/${experiment.name}`;

    const metricStr = metrics
      ? Object.entries(metrics)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : "none";

    const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
    const gist = `${key} — ${truncate(experiment.command, 50)} → ${metricStr} (${status})`;

    const content = [
      `command: ${experiment.command}`,
      `machine: ${experiment.machineId}`,
      `pid: ${experiment.pid}`,
      experiment.metricNames ? `metrics_config: ${experiment.metricNames.join(", ")}` : null,
      `status: ${status}`,
      `started: ${new Date(experiment.startedAt).toISOString()}`,
      `finished: ${new Date().toISOString()}`,
      `exit_code: ${exitCode}`,
      metrics ? `final_metrics: ${JSON.stringify(metrics)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    this.memory.write(path, gist, content);
    this.experiments.delete(key);
  }

  /** Get all pending experiment keys. */
  getPendingKeys(): string[] {
    return [...this.experiments.keys()];
  }
}

function slugify(cmd: string): string {
  // Take the first meaningful word from the command
  const words = cmd
    .replace(/[^a-zA-Z0-9\s_-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  return words.join("-").toLowerCase().slice(0, 30) || "run";
}

