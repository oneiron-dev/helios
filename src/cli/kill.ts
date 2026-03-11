/**
 * `helios kill <machine:pid>` — kill a running task from the CLI.
 */

import { Effect } from "effect";
import { Command, Args } from "@effect/cli";

const target = Args.text({ name: "machine:pid" }).pipe(
  Args.withDescription("Task to kill, e.g. 'local:12345'"),
);

export const kill = Command.make(
  "kill",
  { target },
  ({ target }) =>
    Effect.promise(async () => {
      const [machineId, pidStr] = target.split(":");
      const pid = parseInt(pidStr, 10);
      if (!machineId || isNaN(pid)) {
        console.error("Usage: helios kill <machine_id:pid>");
        process.exit(1);
      }

      const { createRuntime } = await import("../init.js");
      const runtime = await createRuntime();

      const { connectionPool, executor } = runtime;

      // Check if running
      const running = await connectionPool.isProcessRunning(machineId, pid);
      if (!running) {
        console.log(`Process ${machineId}:${pid} is not running.`);
        runtime.cleanup();
        return;
      }

      // Kill it
      const result = await connectionPool.exec(machineId, `kill ${pid} 2>/dev/null && echo killed || echo failed`);
      const outcome = result.stdout.trim();

      if (outcome === "killed") {
        console.log(`Killed ${machineId}:${pid}`);

        // Clean up from executor tracking
        const key = `${machineId}:${pid}`;
        executor.removeBackgroundProcess(key);
      } else {
        // Try SIGKILL
        const force = await connectionPool.exec(machineId, `kill -9 ${pid} 2>/dev/null && echo killed || echo failed`);
        if (force.stdout.trim() === "killed") {
          console.log(`Force-killed ${machineId}:${pid} (SIGKILL)`);
          executor.removeBackgroundProcess(`${machineId}:${pid}`);
        } else {
          console.error(`Failed to kill ${machineId}:${pid}. Check permissions.`);
        }
      }

      runtime.cleanup();
    }),
);
