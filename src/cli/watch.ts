/**
 * `helios watch <machine:pid>` — stream a running task's output + metrics.
 */

import { Effect } from "effect";
import { Command, Args } from "@effect/cli";

const target = Args.text({ name: "machine:pid" }).pipe(
  Args.withDescription("Task to watch, e.g. 'local:12345'"),
);

export const watch = Command.make(
  "watch",
  { target },
  ({ target }) =>
    Effect.promise(async () => {
      const [machineId, pidStr] = target.split(":");
      const pid = parseInt(pidStr, 10);
      if (!machineId || isNaN(pid)) {
        console.error("Usage: helios watch <machine_id:pid>");
        process.exit(1);
      }

      const { createRuntime } = await import("../init.js");
      const runtime = await createRuntime();

      const { connectionPool, metricStore, executor } = runtime;

      // Find the background process to get its log path
      const proc = executor.getBackgroundProcess(machineId, pid);

      // Check if process is running
      const running = await connectionPool.isProcessRunning(machineId, pid);
      if (!running && !proc) {
        console.error(`Process ${machineId}:${pid} is not running and has no log.`);
        runtime.cleanup();
        process.exit(1);
      }

      const taskKey = `${machineId}:${pid}`;
      console.log(`Watching ${taskKey}${running ? " (running)" : " (finished)"}...\n`);

      // Track how many lines we've already printed using wc -l
      let printedLines = 0;
      const pollInterval = 2000;

      const tick = async () => {
        try {
          // Get new lines since last poll using tail -n +offset
          if (proc?.logPath) {
            const result = await connectionPool.exec(
              machineId,
              `tail -n +${printedLines + 1} ${proc.logPath} 2>/dev/null`,
            );
            const output = result.stdout;
            if (output) {
              const lines = output.split("\n");
              // tail output ends with trailing newline → last element is empty
              const newLines = lines.filter((l, i) => l || i < lines.length - 1);
              for (const line of newLines) {
                process.stdout.write(line + "\n");
              }
              printedLines += newLines.length;
            }
          }

          // Show latest metrics
          const latest = metricStore.getLatestAll(taskKey);
          const metricEntries = Object.entries(latest);
          if (metricEntries.length > 0) {
            const metricLine = metricEntries
              .map(([name, value]) => `${name}=${typeof value === "number" ? value.toPrecision(4) : value}`)
              .join("  ");
            process.stdout.write(`\x1b[36m[metrics] ${metricLine}\x1b[0m\n`);
          }

          // Check if still running
          const stillRunning = await connectionPool.isProcessRunning(machineId, pid);
          if (!stillRunning) {
            console.log("\nProcess exited.");
            runtime.cleanup();
            process.exit(0);
          }
        } catch {
          // Resilient — keep watching even if one poll fails
        }
      };

      // Initial tick
      await tick();

      // Set up polling
      const timer = setInterval(tick, pollInterval);

      // Clean exit on Ctrl+C
      process.on("SIGINT", () => {
        clearInterval(timer);
        runtime.cleanup();
        process.exit(0);
      });

      // Keep alive
      await new Promise(() => {});
    }),
);
