import type { Skill } from "./types.js";
import type { ToolDefinition, AgentEvent, ModelProvider } from "../providers/types.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { renderTemplate } from "./loader.js";
import { formatError } from "../ui/format.js";
/** Sleep that can be interrupted by an AbortSignal. */
function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export interface SkillExecContext {
  orchestrator: Orchestrator;
  /** All registered tools on the orchestrator (for filtering). */
  allTools: ToolDefinition[];
  /** Signal to stop a looping skill. */
  signal?: AbortSignal;
}

/**
 * Resolve which provider a skill should use.
 * "other" means the non-active provider (for consult-style skills).
 */
function resolveProvider(skill: Skill, orch: Orchestrator): ModelProvider | null {
  const cfg = skill.config.provider;
  if (!cfg || cfg === null) return orch.currentProvider ?? null;

  if (cfg === "other") {
    const activeName = orch.currentProvider?.name;
    if (!activeName) return null;
    const otherName = activeName === "claude" ? "openai" : "claude";
    return orch.getProvider(otherName);
  }

  return orch.getProvider(cfg);
}

/** Filter tools based on skill's allow/deny config. */
function filterTools(allTools: ToolDefinition[], skill: Skill): ToolDefinition[] {
  const access = skill.config.tools;
  if (!access) return allTools;

  if (access.allow) {
    const allowed = new Set(access.allow);
    return allTools.filter((t) => allowed.has(t.name));
  }

  if (access.deny) {
    const denied = new Set(access.deny);
    return allTools.filter((t) => !denied.has(t.name));
  }

  return allTools;
}

/** Run a single iteration of a skill (one provider session). */
async function* runOnce(
  skill: Skill,
  args: Record<string, string>,
  input: string,
  provider: ModelProvider,
  tools: ToolDefinition[],
  orch: Orchestrator,
): AsyncGenerator<AgentEvent> {
  const systemPrompt = renderTemplate(skill.template, args);

  // Temporarily override provider model if skill specifies one
  const originalModel = provider.currentModel;
  if (skill.config.model) {
    provider.currentModel = skill.config.model;
  }

  const session = await provider.createSession({
    systemPrompt,
    model: skill.config.model ?? undefined,
  });

  const stream = provider.send(session, input, tools);
  try {
    for await (const event of stream) {
      if (event.type === "done" && event.usage?.costUsd) {
        orch.addCost(event.usage.costUsd, event.usage.inputTokens, event.usage.outputTokens);
      }
      yield event;
    }
  } finally {
    // Ensure inner generator is closed on early termination (preserves yield* semantics)
    await stream.return(undefined).catch(() => {});
    await provider.closeSession(session).catch(() => {});
    // Restore original model
    if (skill.config.model) {
      provider.currentModel = originalModel;
    }
  }
}

/**
 * Execute a skill. Yields AgentEvents that the caller can
 * render however they want (TUI streaming, stdout, tool result JSON, etc.).
 *
 * For looping skills (loop: true), runs repeatedly with delay_ms pauses,
 * each iteration as a fresh session. The model uses memory to maintain
 * continuity. Loops until ctx.signal is aborted.
 */
export async function* executeSkill(
  skill: Skill,
  args: Record<string, string>,
  input: string,
  ctx: SkillExecContext,
): AsyncGenerator<AgentEvent> {
  const provider = resolveProvider(skill, ctx.orchestrator);
  if (!provider) {
    yield { type: "error", error: new Error(`No provider available for skill "${skill.name}"`), recoverable: false };
    return;
  }

  // Check auth for cross-provider skills
  if (skill.config.provider === "other") {
    if (!(await provider.isAuthenticated())) {
      yield {
        type: "error",
        error: new Error(`Provider "${provider.name}" is not authenticated. Run /switch ${provider.name} first.`),
        recoverable: false,
      };
      return;
    }
  }

  const tools = filterTools(ctx.allTools, skill);

  if (!skill.config.loop) {
    // One-shot skill
    yield* runOnce(skill, args, input, provider, tools, ctx.orchestrator);
    return;
  }

  // Looping skill — re-invoke with delay between iterations
  const delayMs = skill.config.delay_ms ?? 60_000;
  let iteration = 0;

  while (!ctx.signal?.aborted) {
    iteration++;
    const loopMsg = skill.config.loop_message ?? "Continue. This is iteration {iteration}.";
    const iterInput = iteration === 1
      ? input
      : loopMsg.replace(/\{iteration\}/g, String(iteration));

    try {
      yield* runOnce(skill, args, iterInput, provider, tools, ctx.orchestrator);
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
        recoverable: true,
      };
    }

    // Wait between iterations (interruptible)
    if (ctx.signal?.aborted) break;
    yield {
      type: "text",
      text: `\n*[next iteration in ${Math.round(delayMs / 1000)}s — Esc to stop]*\n`,
      delta: `\n*[next iteration in ${Math.round(delayMs / 1000)}s — Esc to stop]*\n`,
    };
    await interruptibleSleep(delayMs, ctx.signal);
  }
}

/**
 * Execute a skill and collect all text output into a string.
 * Used by tools that wrap skills (e.g. the writeup tool, consult tool).
 */
export async function executeSkillToString(
  skill: Skill,
  args: Record<string, string>,
  input: string,
  ctx: SkillExecContext,
): Promise<{ text: string; error?: string }> {
  let text = "";
  try {
    for await (const event of executeSkill(skill, args, input, ctx)) {
      if (event.type === "text" && event.delta) {
        text += event.delta;
      }
      if (event.type === "error") {
        return { text, error: formatError(event.error) };
      }
    }
    return { text: text || "(empty response)" };
  } catch (err) {
    return { text, error: formatError(err) };
  }
}
