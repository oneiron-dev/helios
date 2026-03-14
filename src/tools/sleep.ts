import type { ToolDefinition } from "../providers/types.js";
import type { SleepManager } from "../scheduler/sleep-manager.js";
import type { TriggerExpression, MetricSource } from "../scheduler/triggers/types.js";
import { toolError, formatError } from "../ui/format.js";

export function createSleepTool(
  sleepManager: SleepManager,
): ToolDefinition {
  return {
    name: "sleep",
    description: `Put yourself to sleep and STOP your current turn. When you call this tool, you MUST immediately end your response — do not output any more text or tool calls after sleep returns. You will be automatically woken when triggers fire and resumed with a wake message containing elapsed time, which triggers fired, and your original goal.

IMPORTANT: Calling sleep means "I am done for now, wake me when conditions are met." After calling sleep, STOP. Do not call any more tools. Do not write any more text. Your turn is over.

Trigger types:
- timer: Wake after a duration. Provide wake_after_seconds.
- process_exit: Wake when a remote process exits. Provide machine_id and pid or process_pattern.
- metric: Wake when a metric meets a condition. Provide machine_id, source, field, comparator, threshold.
- file: Wake when a file appears/changes. Provide machine_id, path, mode (exists|modified|size_stable).
- resource: Wake when GPU/CPU crosses a threshold. Provide machine_id, resource, comparator, threshold.

Use logic "any" to wake on the first condition met, "all" to require all conditions.`,
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you are sleeping (shown to user)",
        },
        wake_conditions: {
          type: "array",
          description: "Conditions that will wake you up",
          items: { type: "object" },
        },
        logic: {
          type: "string",
          enum: ["any", "all"],
          description: "Wake on ANY condition (OR) or ALL conditions (AND)",
        },
        deadline_minutes: {
          type: "number",
          description: "Maximum sleep duration in minutes. Wake regardless after this.",
        },
      },
      required: ["reason", "wake_conditions"],
    },
    execute: async (args) => {
      const reason = args.reason as string;
      // Models sometimes use variant key names
      const conditions = (args.wake_conditions ?? args.conditions ?? args.triggers) as Record<string, unknown>[] | undefined;
      if (!conditions || !Array.isArray(conditions) || conditions.length === 0) {
        return toolError("No wake_conditions provided. Provide an array of trigger conditions.");
      }
      const logic = (args.logic as "any" | "all") ?? "any";
      const deadlineMin = args.deadline_minutes as number | undefined;

      let triggerConditions: TriggerExpression[];
      try {
        triggerConditions = conditions.map(parseTriggerCondition);
      } catch (err) {
        return toolError(`Failed to parse wake conditions: ${formatError(err)}. Check the trigger type and required fields.`);
      }

      const expression: TriggerExpression =
        triggerConditions.length === 1
          ? triggerConditions[0]
          : { op: logic === "all" ? "and" : "or", children: triggerConditions };

      let session;
      try {
        session = await sleepManager.sleep({
          reason,
          expression,
          deadlineMs: deadlineMin ? deadlineMin * 60 * 1000 : undefined,
        });
      } catch (err) {
        return toolError(`Failed to enter sleep: ${formatError(err)}`);
      }

      return JSON.stringify({
        status: "sleeping",
        session_id: session.id,
        trigger_id: session.trigger.id,
        reason,
        deadline: session.trigger.deadline
          ? new Date(session.trigger.deadline).toISOString()
          : null,
        instruction: "You are now sleeping. STOP your response immediately. Do not output any more text or tool calls. You will be woken automatically.",
      });
    },
  };
}

function parseTriggerCondition(
  raw: Record<string, unknown>,
): TriggerExpression {
  const type = raw.type as string;

  switch (type) {
    case "timer":
      return {
        kind: "timer",
        wakeAt:
          Date.now() + ((raw.wake_after_seconds as number) ?? 3600) * 1000,
      };

    case "process_exit":
      return {
        kind: "process_exit",
        machineId: raw.machine_id as string,
        pid: raw.pid as number | undefined,
        processPattern: raw.process_pattern as string | undefined,
      };

    case "metric":
      return {
        kind: "metric",
        machineId: raw.machine_id as string,
        source: raw.source as MetricSource,
        field: raw.field as string,
        comparator: raw.comparator as "<" | ">" | "<=" | ">=" | "==" | "!=",
        threshold: raw.threshold as number,
        sustainedChecks: raw.sustained_checks as number | undefined,
      };

    case "file":
      return {
        kind: "file",
        machineId: raw.machine_id as string,
        path: raw.path as string,
        mode: (raw.mode as "exists" | "modified" | "size_stable") ?? "exists",
      };

    case "resource":
      return {
        kind: "resource",
        machineId: raw.machine_id as string,
        resource: raw.resource as
          | "gpu_util"
          | "gpu_memory"
          | "cpu"
          | "memory"
          | "disk",
        comparator: (raw.comparator as "<" | ">" | "<=" | ">=") ?? "<",
        threshold: raw.threshold as number,
        gpuIndex: raw.gpu_index as number | undefined,
      };

    default:
      throw new Error(`Unknown trigger type: ${type}`);
  }
}
