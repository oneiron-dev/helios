// JSON-RPC 2.0 base types

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ACP Content types

export type ContentBlock =
  | TextContent
  | ImageContent
  | ResourceContent
  | ResourceLinkContent;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  mimeType: string;
  data: string;
}

export interface ResourceContent {
  type: "resource";
  resource: { uri: string; text?: string; blob?: string; mimeType?: string };
}

export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
  title?: string;
  description?: string;
  size?: number;
}

// Initialize

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo?: { name: string; title?: string; version?: string };
}

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: { name: string; version: string; title?: string };
  authMethods?: AuthMethod[];
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  sessionCapabilities?: SessionCapabilities;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
}

export interface SessionCapabilities {
  list?: Record<string, unknown> | null;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}

// Session

export interface SessionNewParams {
  cwd: string;
  mcpServers: McpServer[];
}

export interface McpServer {
  name: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
}

export interface SessionNewResult {
  sessionId: string;
  configOptions?: SessionConfigOption[] | null;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface SessionPromptResult {
  stopReason: StopReason;
}

export interface SessionCancelParams {
  sessionId: string;
}

// Session updates (agent → client notifications)

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | ToolCallInitUpdate
  | ToolCallStatusUpdate
  | AvailableCommandsUpdate
  | ConfigOptionUpdate;

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: TextContent;
}

/** Initial tool call report — discriminator "tool_call" */
export interface ToolCallInitUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind?: ToolCallKind;
  status?: ToolCallStatus;
  content?: ContentBlock[];
}

/** Subsequent tool call status change — discriminator "tool_call_update" */
export interface ToolCallStatusUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: ToolCallStatus;
  content?: ContentBlock[];
}

export type ToolCallKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: AvailableCommand[];
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

export interface ConfigOptionUpdate {
  sessionUpdate: "config_option_update";
  configOptions: SessionConfigOption[];
}

/** Discriminated union on `type`: "select" or "boolean" */
export type SessionConfigOption = SessionConfigSelectOption | SessionConfigBooleanOption;

interface SessionConfigBase {
  id: string;
  name: string;
  description?: string;
  category?: string;
}

export interface SessionConfigSelectOption extends SessionConfigBase {
  type: "select";
  currentValue: string;
  options: SessionConfigSelectValue[];
}

export interface SessionConfigBooleanOption extends SessionConfigBase {
  type: "boolean";
  currentValue: boolean;
}

export interface SessionConfigSelectValue {
  value: string;
  name: string;
  description?: string;
}

// Session list

export interface SessionListParams {
  cwd?: string;
  cursor?: string;
}

export interface SessionListResult {
  sessions: SessionInfo[];
  nextCursor?: string;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

// Set config option

export interface SetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string;
}

export interface SetConfigOptionResult {
  configOptions: SessionConfigOption[];
}
