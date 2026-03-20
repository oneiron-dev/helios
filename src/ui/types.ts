export interface ToolData {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface Message {
  id: number;
  role: "user" | "assistant" | "tool" | "error" | "system";
  content: string;
  tool?: ToolData;
}

export interface TaskInfo {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  machineId: string;
  pid?: number;
  startedAt: number;
  type?: "process" | "subagent";
  /** Per-subagent cost in USD (only for type=subagent). */
  costUsd?: number;
  /** Current turn number (subagents only). */
  turn?: number;
  /** Last tool call name (subagents only, sign of life). */
  lastToolCall?: string;
  /** Rolling activity log (subagents only). */
  log?: Array<{ timestamp: number; type: string; summary: string }>;
  groupId?: string;
  groupLabel?: string;
}

export type PanelGroup = "default" | "prose" | "experiments";
