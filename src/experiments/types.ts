/** Structured command spec — no shell string interpolation */
export interface ExecSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Experiment {
  id: string;
  status: string;
  statusColor: "success" | "error" | "primary" | "dim";
  compositeScore: number | null;
  metrics: Record<string, number>;
  description: string;
  startedAt?: number;
  finishedAt?: number;
  parentId?: string;
  primaryParentId?: string;
  parentIds?: string[];
  familyId?: string;
  generation?: number;
  branchLabel?: string;
  metadata: Record<string, unknown>;
}

export interface ColumnDef {
  key: string;
  label: string;
  width: number;
  align: "left" | "right" | "center";
  format?: (value: unknown) => string;
  color?: (value: unknown) => string;
}

export interface ExperimentSummary {
  label: string;
  stats: Array<{ key: string; value: string }>;
  bestScore: number | null;
  totalCount: number;
  activeCount: number;
}

export interface ExperimentDetail {
  sections: Array<{ title: string; content: string }>;
}

export interface OperatorAction {
  name: string;
  label: string;
  confirmRequired?: boolean;
  appliesTo?: (exp: Experiment) => boolean;
  buildExec(experiment: Experiment): ExecSpec;
}

export interface LineageInfo {
  experimentId: string;
  primaryParentId?: string;
  parentIds?: string[];
  familyId?: string;
  generation: number;
  branchLabel?: string;
}

export interface ExperimentAdapter {
  id: string;
  name: string;
  load(): Promise<Experiment[]>;
  getSummary(): ExperimentSummary;
  getDetail(experimentId: string): ExperimentDetail;
  getColumns(width: number): ColumnDef[];
  getActions(): OperatorAction[];
  getLineage?(): LineageInfo[];
  startPolling(intervalMs?: number): void;
  stopPolling(): void;
  onUpdate(callback: () => void): void;
}
