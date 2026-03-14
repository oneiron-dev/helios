import type { ToolDefinition } from "../providers/types.js";
import type { SubagentManager } from "../subagent/manager.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { formatDuration, toolError } from "../ui/format.js";
import type { SubagentInfo } from "../subagent/types.js";

function formatStatus(info: SubagentInfo) {
  return {
    id: info.id,
    status: info.status,
    task: info.task,
    model: info.model,
    provider: info.provider,
    depth: info.depth,
    elapsed_ms: (info.completedAt ?? Date.now()) - info.createdAt,
    elapsed: formatDuration((info.completedAt ?? Date.now()) - info.createdAt),
    cost_usd: info.costUsd,
    ...(info.error ? { error: info.error } : {}),
  };
}

export function createSubagentTool(
  manager: SubagentManager,
  orchestrator: Orchestrator,
  memory: MemoryStore,
): ToolDefinition {
  return {
    name: "subagent",
    description:
      `Launch a subagent to work on a focused subtask in the background. Returns immediately with an ID — the subagent runs autonomously. Use for parallelizing research, delegating analysis, or running multiple hypothesis tests simultaneously.

The subagent gets its own agent session with tools and memory. It writes results to /subagents/{id}/ in your memory tree. Check progress with subagent_status, read results with subagent_result or memory_read("/subagents/{id}/result").

## Model Selection
| Model | Provider | Best For | Cost (in/out per 1M tok) |
|---|---|---|---|
| claude-opus-4-6 | claude | Complex reasoning | $15 / $75 |
| claude-sonnet-4-6 | claude | Balanced | $3 / $15 |
| gpt-5.4 | openai | Complex reasoning | ~$15 / ~$75 |
| gpt-5.3-codex | openai | Code tasks | ~$3 / ~$15 |
| gpt-5.2 | openai | Balanced | ~$3 / ~$15 |
| gpt-5.1 | openai | Cost-efficient | ~$1 / ~$5 |

Default: inherits your current model. Use cheaper models for simple retrieval/analysis.`,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Clear, specific task for the subagent. Be detailed — it only knows what you tell it plus what's in your memory tree.",
        },
        model: {
          type: "string",
          description: "Model ID (e.g. 'claude-sonnet-4-6', 'gpt-5.2'). Default: your current model.",
        },
        provider: {
          type: "string",
          description: "Provider: 'claude' or 'openai'. Default: inferred from model.",
        },
        tools_deny: {
          type: "array",
          items: { type: "string" },
          description: "Tools to exclude from the subagent (e.g. ['sweep'])",
        },
        max_turns: {
          type: "number",
          description: "Max agent loop turns (default: 50). Safety limit.",
        },
      },
      required: ["task"],
    },
    execute: async (args) => {
      const task = args.task as string;
      if (!task?.trim()) return toolError("task is required");

      const sessionId = orchestrator.activeSession?.id;
      if (!sessionId) return toolError("No active session");

      try {
        const info = manager.spawn(
          {
            task,
            model: args.model as string | undefined,
            provider: args.provider as "claude" | "openai" | undefined,
            tools_deny: args.tools_deny as string[] | undefined,
            max_turns: args.max_turns as number | undefined,
          },
          orchestrator,
          orchestrator.getTools(),
          memory,
          sessionId,
        );

        return JSON.stringify({
          id: info.id,
          status: "running",
          model: info.model,
          provider: info.provider,
          memory_prefix: info.memoryPrefix,
          note: `Subagent launched. Check with subagent_status("${info.id}") or read results from memory at /subagents/${info.id}/result`,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  };
}

export function createSubagentStatusTool(
  manager: SubagentManager,
): ToolDefinition {
  return {
    name: "subagent_status",
    description: "Check the status of one or all subagents. Returns status, elapsed time, and cost.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Subagent ID. Omit to list all subagents.",
        },
      },
    },
    execute: async (args) => {
      const id = args.id as string | undefined;
      if (id) {
        const info = manager.get(id);
        if (!info) return toolError(`Subagent not found: ${id}`);
        return JSON.stringify(formatStatus(info));
      }
      const all = manager.listAll();
      if (all.length === 0) return JSON.stringify({ subagents: [], note: "No subagents" });
      return JSON.stringify({ subagents: all.map(formatStatus) });
    },
  };
}

export function createSubagentResultTool(
  manager: SubagentManager,
  memory: MemoryStore,
): ToolDefinition {
  return {
    name: "subagent_result",
    description: "Read the final result from a completed subagent. Also available at /subagents/{id}/result in memory.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Subagent ID",
        },
      },
      required: ["id"],
    },
    execute: async (args) => {
      const id = args.id as string;
      const info = manager.get(id);
      if (!info) return toolError(`Subagent not found: ${id}`);

      if (info.status === "running") {
        return JSON.stringify({
          status: "running",
          elapsed: formatDuration(Date.now() - info.createdAt),
          note: `Still running. Check /subagents/${id}/ for partial results.`,
        });
      }

      // Read from memory (authoritative)
      const resultNode = memory.read(`/subagents/${id}/result`);
      return JSON.stringify({
        status: info.status,
        result: info.result ?? resultNode?.content ?? "(no result)",
        cost_usd: info.costUsd,
        elapsed: formatDuration((info.completedAt ?? Date.now()) - info.createdAt),
        ...(info.error ? { error: info.error } : {}),
      });
    },
  };
}

/** Convenience: create all three subagent tools. */
export function createSubagentTools(
  manager: SubagentManager,
  orchestrator: Orchestrator,
  memory: MemoryStore,
): ToolDefinition[] {
  return [
    createSubagentTool(manager, orchestrator, memory),
    createSubagentStatusTool(manager),
    createSubagentResultTool(manager, memory),
  ];
}
