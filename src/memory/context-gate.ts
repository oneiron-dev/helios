import { getCheckpointThreshold } from "./token-estimator.js";
import { truncate } from "../ui/format.js";
import type { MemoryStore } from "./memory-store.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { MetricStore } from "../metrics/store.js";

export interface ContextGateConfig {
  /** Override checkpoint threshold (for testing). */
  thresholdOverride?: number;
}

/**
 * ContextGate monitors token usage and triggers checkpoints when
 * the context window is filling up.
 *
 * Uses actual input_tokens from the API response (reported in DoneEvent.usage)
 * rather than re-estimating from history text.
 *
 * On checkpoint:
 * 1. Save active tasks + latest metrics to memory
 * 2. Build a briefing from the memory tree
 * 3. Orchestrator resets provider history with the briefing
 */
export class ContextGate {
  private memory: MemoryStore;
  private executor: RemoteExecutor | null = null;
  private metricStore: MetricStore | null = null;
  private config: ContextGateConfig;

  constructor(memory: MemoryStore, config: ContextGateConfig = {}) {
    this.memory = memory;
    this.config = config;
  }

  /** Update the memory store's session ID when a new session starts. */
  onSessionStart(sessionId: string): void {
    this.memory.setSession(sessionId);
  }

  setExecutor(executor: RemoteExecutor): void {
    this.executor = executor;
  }

  setMetricStore(store: MetricStore): void {
    this.metricStore = store;
  }

  /**
   * Check if actual input token count exceeds checkpoint threshold.
   * Called by Orchestrator after each send() completes.
   */
  checkThreshold(model: string, inputTokens: number): boolean {
    if (inputTokens === 0) return false;
    const threshold =
      this.config.thresholdOverride ?? getCheckpointThreshold(model);
    return inputTokens >= threshold;
  }

  /**
   * Perform a checkpoint with a model-generated gist.
   * Saves active state + gist to memory, returns the briefing.
   */
  performCheckpointWithGist(gist: string): string {
    // Save the model's gist
    this.memory.write(
      "/context/gist",
      "Model-generated summary of conversation before checkpoint",
      gist,
    );

    // Save active tasks to /context/active-tasks
    this.saveActiveTasks();

    return this.buildBriefing(gist);
  }

  private saveActiveTasks(): void {
    if (!this.executor) return;

    const tasks = this.executor.getBackgroundProcesses();
    if (tasks.length === 0) return;

    const taskLines = tasks.map((t) => {
      const latestMetrics = this.getLatestMetrics(t.machineId, t.pid);
      return [
        `${t.machineId}:${t.pid} — ${truncate(t.command, 80)}`,
        latestMetrics ? `  metrics: ${latestMetrics}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    });

    this.memory.write(
      "/context/active-tasks",
      `${tasks.length} running task(s)`,
      taskLines.join("\n\n"),
    );
  }

  /** Build a checkpoint briefing string from the memory tree + optional gist. */
  buildBriefing(gist: string | null): string {
    const tree = this.memory.formatTree("/");

    const parts = [
      "=== CONTEXT CHECKPOINT ===",
      "You are Helios, continuing an autonomous ML research session.",
      "Your previous conversation has been archived.",
    ];

    if (gist) {
      parts.push(
        "\n## Your gist (written by you before the checkpoint):\n",
        gist,
      );
    }

    parts.push(
      "\n## Memory tree:\n",
      tree,
      "\nUse memory_read(path) for details on any item above.",
      "Use memory_write to store new findings as you work.",
      "Check /sources/ for prior work you've built on — cite these in any writeups.",
      "Continue working toward your goal.",
    );

    return parts.join("\n");
  }

  private getLatestMetrics(machineId: string, pid: number): string | null {
    if (!this.metricStore) return null;

    const taskId = `${machineId}:${pid}`;
    const names = this.metricStore.getMetricNames(taskId);
    if (names.length === 0) return null;

    const parts: string[] = [];
    for (const name of names.slice(0, 5)) {
      const series = this.metricStore.getSeries(taskId, name, 1);
      if (series.length > 0) {
        parts.push(`${name}=${series[0].value}`);
      }
    }

    return parts.length > 0 ? parts.join(", ") : null;
  }
}
