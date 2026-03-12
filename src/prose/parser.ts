import type { ProseStep } from "./types.js";

export interface ParseResult {
  steps: ProseStep[];
  status: "running" | "done" | "error";
  lastLine: string;
}

export function parseStateMd(content: string): ParseResult {
  const lines = content.split("\n");
  const steps: ProseStep[] = [];
  let status: "running" | "done" | "error" = "running";
  let lastLine = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    lastLine = line;

    // End markers
    if (line.startsWith("---end ")) {
      status = "done";
      continue;
    }
    if (line.startsWith("---error ")) {
      status = "error";
      continue;
    }

    // Substep markers: Na-> label (e.g., 2a-> screen ✓) — skip these
    if (/^\d+[a-z]->\s+/.test(line)) {
      continue;
    }

    // Step markers: N-> label [✓]
    const stepMatch = line.match(/^(\d+)->\s+(.+)$/);
    if (!stepMatch) continue;

    const num = parseInt(stepMatch[1], 10);
    let label = stepMatch[2];

    // Parallel start: N-> ∥start a,b,c
    const parallelStart = label.match(/^∥start\s+(.+)$/);
    if (parallelStart) {
      const substeps = parallelStart[1].split(",").map((s) => s.trim());
      steps.push({
        number: num,
        label: `parallel: ${substeps.join(", ")}`,
        status: "running",
        substeps,
      });
      continue;
    }

    // Parallel done: N-> ∥done
    if (label === "∥done") {
      const pStep = steps.find((s) => s.number === num && s.substeps);
      if (pStep) pStep.status = "complete";
      continue;
    }

    // Loop marker: N-> loop:X/Y
    const loopMatch = label.match(/^loop:(\d+)\/(\d+)$/);
    if (loopMatch) {
      const existing = steps.find((s) => s.number === num);
      if (existing) {
        existing.label = `${existing.label} (${loopMatch[1]}/${loopMatch[2]})`;
      }
      continue;
    }

    // Check for completion marker ✓
    const isComplete = label.endsWith(" ✓") || label.endsWith("✓");
    if (isComplete) {
      label = label.replace(/\s*✓\s*$/, "");
    }

    const existing = steps.find((s) => s.number === num);
    if (existing) {
      existing.status = isComplete ? "complete" : "pending";
      existing.label = label;
    } else {
      steps.push({
        number: num,
        label,
        status: isComplete ? "complete" : "pending",
      });
    }
  }

  // Mark the last non-complete step as running (if overall status is running)
  if (status === "running") {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].status === "pending") {
        steps[i].status = "running";
        break;
      }
    }
  }

  return { steps, status, lastLine };
}
