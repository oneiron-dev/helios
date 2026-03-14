import type { ToolDefinition } from "../providers/types.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import type { MetricCollector } from "../metrics/collector.js";
import {
  type MetricPatterns,
  patternsFromNames,
  patternsFromRegexes,
} from "../metrics/parser.js";
import { formatError, shellQuote, toolError } from "../ui/format.js";

/**
 * Compute the cartesian product of a parameter grid.
 * e.g. {lr: [0.001, 0.0001], bs: [32, 64]} → [{lr:0.001,bs:32}, {lr:0.001,bs:64}, ...]
 */
function cartesianProduct(
  params: Record<string, unknown[]>,
): Record<string, unknown>[] {
  const keys = Object.keys(params);
  if (keys.length === 0) return [{}];
  const [first, ...rest] = keys;
  const restProduct = cartesianProduct(
    Object.fromEntries(rest.map((k) => [k, params[k]])),
  );
  return params[first].flatMap((val) =>
    restProduct.map((combo) => ({ [first]: val, ...combo })),
  );
}

/**
 * Replace {param_name} placeholders in a command template with concrete values.
 */
function buildCommand(
  template: string,
  params: Record<string, unknown>,
): string {
  let cmd = template;
  for (const [key, value] of Object.entries(params)) {
    const strVal = String(value);
    // Numeric values are safe to inline; quote anything else
    const safe = /^-?[\d.e+-]+$/.test(strVal) ? strVal : shellQuote(strVal);
    cmd = cmd.replaceAll(`{${key}}`, safe);
  }
  return cmd;
}

export function createSweepTool(
  executor: RemoteExecutor,
  pool: ConnectionPool,
  metricCollector: MetricCollector,
): ToolDefinition {
  return {
    name: "sweep",
    description:
      "Launch a hyperparameter sweep. Defines a parameter grid and runs experiments in parallel across available machines. Each combination gets its own background process with metric tracking.",
    parameters: {
      type: "object",
      properties: {
        command_template: {
          type: "string",
          description:
            'Command template with {param_name} placeholders. Example: "python train.py --lr {lr} --batch-size {bs}"',
        },
        params: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: { type: "string" },
          },
          description:
            'Parameter grid. Keys are param names, values are arrays of values. Example: {"lr": [0.001, 0.0001], "bs": [32, 64]}',
        },
        machines: {
          type: "array",
          items: { type: "string" },
          description:
            "Machine IDs to distribute across. Default: all connected machines.",
        },
        metric_names: {
          type: "array",
          items: { type: "string" },
          description:
            'Metrics to track for each run in key=value format. Example: ["loss", "acc"]',
        },
        metric_patterns: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            'Custom regex patterns for metric parsing. Example: {"loss": "Loss:\\\\s*([\\\\d.e+-]+)"}',
        },
        max_parallel: {
          type: "number",
          description:
            "Max concurrent runs. Default: number of available machines.",
        },
      },
      required: ["command_template", "params"],
    },
    execute: async (args) => {
      const commandTemplate = args.command_template as string;
      const paramGrid = args.params as Record<string, unknown[]>;
      const requestedMachines = args.machines as string[] | undefined;
      const metricNames = args.metric_names as string[] | undefined;
      const metricPatterns = args.metric_patterns as
        | Record<string, string>
        | undefined;
      const maxParallelArg = args.max_parallel as number | undefined;

      // 1. Generate all parameter combinations
      const combinations = cartesianProduct(paramGrid);
      if (combinations.length === 0) {
        return toolError("No parameter combinations generated. Check your params grid.");
      }

      // 2. Determine available machines
      let machineIds: string[];
      if (requestedMachines && requestedMachines.length > 0) {
        machineIds = requestedMachines;
      } else {
        machineIds = pool
          .getMachineIds()
          .filter((id) => pool.getStatus(id).connected);
      }

      if (machineIds.length === 0) {
        return toolError("No connected machines available for sweep.");
      }

      const maxParallel = maxParallelArg ?? machineIds.length;
      const toLaunch = combinations.slice(0, maxParallel);
      const skipped = combinations.length - toLaunch.length;

      // Build metric patterns once (shared across all runs)
      let patterns: MetricPatterns | undefined;
      if (metricPatterns) {
        patterns = patternsFromRegexes(metricPatterns);
      } else if (metricNames && metricNames.length > 0) {
        patterns = patternsFromNames(metricNames);
      }

      // 3. Launch runs, distributing across machines round-robin
      const launched: Array<{
        machineId: string;
        pid: number;
        params: Record<string, unknown>;
        command: string;
        log_path: string | undefined;
      }> = [];
      const errors: Array<{
        params: Record<string, unknown>;
        error: string;
      }> = [];

      await Promise.all(
        toLaunch.map(async (combo, i) => {
          const machineId = machineIds[i % machineIds.length];
          const command = buildCommand(commandTemplate, combo);

          try {
            const proc = await executor.execBackground(
              machineId,
              command,
              undefined,
              { metricNames, metricPatterns },
            );

            // Register with metric collector if patterns are available
            if (patterns && proc.logPath) {
              try {
                metricCollector.addSource({
                  taskId: `${machineId}:${proc.pid}`,
                  machineId,
                  logPath: proc.logPath,
                  patterns,
                });
              } catch {
                // Metric registration failure is non-fatal
              }
            }

            launched.push({
              machineId,
              pid: proc.pid,
              params: combo,
              command,
              log_path: proc.logPath,
            });
          } catch (err) {
            errors.push({
              params: combo,
              error: formatError(err),
            });
          }
        }),
      );

      return JSON.stringify({
        launched,
        skipped,
        skipped_note: skipped > 0 ? `${skipped} combinations were not launched due to max_parallel=${maxParallel}. Call sweep again with the remaining params to run them.` : undefined,
        total_combinations: combinations.length,
        machines_used: machineIds,
        ...(errors.length > 0 ? { errors } : {}),
      });
    },
  };
}
