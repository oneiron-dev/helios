import type { OperatorAction, Experiment, ExecSpec } from "./types.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { BackgroundProcess } from "../remote/types.js";
import { shellQuote } from "../ui/format.js";

/** Convert ExecSpec to a shell command string. */
export function execSpecToShellCommand(spec: ExecSpec): string {
  const parts: string[] = [];
  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) {
      parts.push(`${k}=${shellQuote(v)}`);
    }
  }
  parts.push(...spec.argv.map(shellQuote));
  const cmd = parts.join(" ");
  return spec.cwd ? `cd ${shellQuote(spec.cwd)} && ${cmd}` : cmd;
}

/** Execute an adapter action as a background process. */
export async function executeAction(
  action: OperatorAction,
  experiment: Experiment,
  executor: RemoteExecutor,
  machineId = "local",
): Promise<BackgroundProcess> {
  const spec = action.buildExec(experiment);
  const command = execSpecToShellCommand(spec);
  return executor.execBackground(machineId, command, undefined, {
    groupId: `exp:${experiment.id}`,
    groupLabel: `${action.label}: ${experiment.id}`,
  });
}
