import type { ToolDefinition, ModelProvider } from "../providers/types.js";
import { formatError } from "../ui/format.js";

/**
 * Build the writeup system prompt.
 * @param transcript - true when the input is a full session transcript (slash command),
 *                     false when the input is user-provided notes (tool call).
 */
export function buildWriteupSystemPrompt(options: { transcript?: boolean } = {}): string {
  const inputDesc = options.transcript
    ? "the full transcript of an ML experiment session — including the researcher's goals, the agent's actions, tool calls, metric results, and conclusions"
    : "experiment notes from an ML research agent — including goals, configurations, metric results, and observations";

  const taskPrefix = options.transcript ? "Your task: produce" : "Produce";

  const extraCitation = options.transcript
    ? "\n- Look for hub_fetch, hub_read, and hub_log tool calls in the transcript to identify sources"
    : "";

  const dataSource = options.transcript ? " from the transcript" : "";

  return `You are a scientific writing assistant. You will receive ${inputDesc}.

${taskPrefix} a clean, structured experiment writeup. Write it as a practitioner's report, not an academic paper. Be concise but thorough.

## Format

# [Title — infer from the goal]

## Objective
What was the researcher trying to achieve?

## Setup
- Model architecture, dataset, hardware
- Key hyperparameters and configuration

## Experiments
For each distinct experiment/run:
- What was tried and why
- Key metrics (include actual numbers)
- Whether it improved over the previous best

## Results
- Best configuration found
- Final metric values
- Comparison to baseline / starting point

## Observations
- What worked, what didn't
- Surprising findings
- Hypotheses about why certain changes helped/hurt

## Next Steps (if applicable)
- Promising directions not yet explored
- Known limitations

## Citations
- If the work builds on another agent's commit, cite it: "Based on [agent_id/hash_prefix]"
- If referencing an AgentHub post, cite by post ID: "As noted in post #42"
- If reproducing or extending results from another agent, credit them explicitly${extraCitation}

Keep the writing direct and data-driven. Use actual metric values${dataSource}. Do not invent data.`;
}

export function createWriteupTool(
  getProvider: () => ModelProvider | null,
): ToolDefinition {
  return {
    name: "writeup",
    description:
      "Generate a structured experiment writeup from your notes. Pass your experiment observations, metrics, and findings as input. Returns a formatted writeup suitable for posting to AgentHub.",
    parameters: {
      type: "object",
      properties: {
        notes: {
          type: "string",
          description: "Your experiment notes: goal, what you tried, metric values, observations, conclusions. Be thorough — the writeup is only as good as the input.",
        },
      },
      required: ["notes"],
    },
    execute: async (args) => {
      const notes = args.notes as string;
      if (!notes?.trim()) {
        return JSON.stringify({ error: "notes is required" });
      }

      const provider = getProvider();
      if (!provider) {
        return JSON.stringify({ error: "No active provider" });
      }

      const session = await provider.createSession({
        systemPrompt: buildWriteupSystemPrompt(),
      });

      try {
        let writeup = "";
        for await (const event of provider.send(session, notes, [])) {
          if (event.type === "text" && event.delta) {
            writeup += event.delta;
          }
        }
        return JSON.stringify({ writeup: writeup || "(empty response)" });
      } catch (err) {
        return JSON.stringify({ error: `Writeup failed: ${formatError(err)}` });
      } finally {
        await provider.closeSession(session).catch(() => {});
      }
    },
  };
}
