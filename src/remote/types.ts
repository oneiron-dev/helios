export interface RemoteMachine {
  id: string;
  host: string;
  port: number;
  username: string;
  authMethod: "key" | "agent" | "password";
  keyPath?: string;
  password?: string;
  labels?: string[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BackgroundProcess {
  pid: number;
  machineId: string;
  command: string;
  logPath?: string;
  startedAt: number;
  /** Metric names to auto-parse from stdout (key=value format) */
  metricNames?: string[];
  /** Custom regex patterns: metric name → regex with one capture group */
  metricPatterns?: Record<string, string>;
  /** Grouping: e.g. "prose:20260312-abc123" or "exp:candidate_42" */
  groupId?: string;
  /** Human-readable group label: e.g. "prose: outerloop" */
  groupLabel?: string;
}

export interface ConnectionStatus {
  machineId: string;
  connected: boolean;
  lastConnectedAt?: number;
  error?: string;
}
