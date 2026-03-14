import { nanoid } from "nanoid";
import { EventEmitter } from "node:events";
import { formatError, truncate } from "../ui/format.js";
import type {
  SleepSession,
  Trigger,
  TriggerExpression,
} from "./triggers/types.js";
import { TriggerScheduler } from "./trigger-scheduler.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import type { MetricStore } from "../metrics/store.js";
import { formatDuration } from "../ui/format.js";

export interface SleepRequest {
  reason: string;
  expression: TriggerExpression;
  deadlineMs?: number;
  pollIntervalMs?: number;
}

export class SleepManager extends EventEmitter {
  private activeSleep: SleepSession | null = null;
  private executor: RemoteExecutor | null = null;
  private connectionPool: ConnectionPool | null = null;
  private metricStore: MetricStore | null = null;

  constructor(
    private scheduler: TriggerScheduler,
    private orchestrator: Orchestrator,
  ) {
    super();

    this.scheduler.on("wake", (session: SleepSession, reason: string) => {
      try {
        this.handleWake(session, reason);
      } catch (err) {
        // Don't let a wake handler crash the scheduler
        process.stderr.write(`[helios] Wake handler error: ${formatError(err)}\n`);
      }
    });
  }

  setExecutor(executor: RemoteExecutor): void {
    this.executor = executor;
  }

  setConnectionPool(pool: ConnectionPool): void {
    this.connectionPool = pool;
  }

  setMetricStore(store: MetricStore): void {
    this.metricStore = store;
  }

  get isSleeping(): boolean {
    return this.activeSleep !== null;
  }

  get currentSleep(): SleepSession | null {
    return this.activeSleep;
  }

  async sleep(request: SleepRequest): Promise<SleepSession> {
    if (this.activeSleep) {
      throw new Error("Already sleeping. Wake first.");
    }

    const session = this.orchestrator.currentSession;
    const provider = this.orchestrator.currentProvider;
    if (!session || !provider) {
      throw new Error("No active session to sleep");
    }

    const trigger: Trigger = {
      id: nanoid(),
      status: "pending",
      expression: request.expression,
      createdAt: Date.now(),
      deadline: request.deadlineMs
        ? Date.now() + request.deadlineMs
        : undefined,
      pollIntervalMs: request.pollIntervalMs,
      sleepReason: request.reason,
      contextSnapshotId: session.id,
      satisfiedLeaves: new Set(),
    };

    const sleepSession: SleepSession = {
      id: nanoid(),
      trigger,
      agentState: {
        sessionId: session.id,
        providerName: provider.name,
        providerSessionId: session.providerSessionId,
        pendingGoal: request.reason,
        activeMachines: this.connectionPool?.getMachineIds() ?? [],
      },
      createdAt: Date.now(),
    };

    this.activeSleep = sleepSession;
    this.orchestrator.stateMachine.transition(
      "sleeping",
      request.reason,
    );
    this.scheduler.start(sleepSession);
    this.emit("sleep", sleepSession);

    return sleepSession;
  }

  manualWake(userMessage?: string): void {
    if (!this.activeSleep) return;
    // Store the user message so handleWake can include it
    this._pendingUserMessage = userMessage ?? null;
    this.scheduler.onUserMessage();
  }

  private _pendingUserMessage: string | null = null;

  private handleWake(session: SleepSession, reason: string): void {
    this.activeSleep = null;
    this.orchestrator.stateMachine.transition("active", reason);

    // Build rich wake message and auto-resume the agent
    let wakeMessage = this.buildWakeMessage(session);
    if (this._pendingUserMessage) {
      wakeMessage += `\n\nUser message: ${this._pendingUserMessage}`;
      this._pendingUserMessage = null;
    }
    this.emit("wake", session, reason, wakeMessage);
  }

  buildWakeMessage(session: SleepSession): string {
    const elapsed = (session.wokeAt ?? Date.now()) - session.createdAt;

    const parts = [
      `[Wake — slept ${formatDuration(elapsed)}]`,
      `Reason: ${session.wakeReason === "trigger_satisfied" ? "trigger fired" : session.wakeReason}`,
      `Goal: ${session.agentState.pendingGoal}`,
    ];

    // What conditions were satisfied
    const satisfied = Array.from(session.trigger.satisfiedLeaves);
    if (satisfied.length > 0) {
      parts.push(`Satisfied conditions: ${satisfied.join(", ")}`);
    }

    // Active tasks status
    if (this.executor) {
      const procs = this.executor.getBackgroundProcesses();
      if (procs.length > 0) {
        parts.push("", "Active tasks:");
        for (const p of procs) {
          parts.push(`  ${p.machineId}:${p.pid} — ${truncate(p.command, 60)}`);
        }
      }
    }

    // Latest metric values
    if (this.metricStore) {
      const latest = this.metricStore.getLatestPerMetric();
      const entries = Object.entries(latest);
      if (entries.length > 0) {
        parts.push("", "Latest metrics:");
        for (const [name, value] of entries.slice(0, 10)) {
          parts.push(`  ${name}: ${value}`);
        }
      }
    }

    parts.push("", "Continue working toward your goal.");
    return parts.join("\n");
  }
}
