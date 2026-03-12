export interface ProseStep {
  number: number;
  label: string;
  status: "pending" | "running" | "complete" | "error";
  substeps?: string[];
}

export interface ProseRun {
  id: string;
  programPath: string;
  programName: string;
  status: "running" | "done" | "error" | "stalled";
  steps: ProseStep[];
  lastLine: string;
  startedAt: number;
  updatedAt: number;
  candidateCount: number;
  pid?: number;
}

export interface ProseRunConfig {
  runsDir: string;
  pollIntervalMs: number;
  stalledThresholdMs: number;
}
