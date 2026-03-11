import { z } from "zod";

// --- Agent Events (unified across providers) ---

export interface TextEvent {
  type: "text";
  text: string;
  /** Incremental delta for streaming */
  delta?: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: "tool_result";
  callId: string;
  result: string;
  isError?: boolean;
}

export interface ErrorEvent {
  type: "error";
  error: Error;
  recoverable: boolean;
}

export interface DoneEvent {
  type: "done";
  usage?: TokenUsage;
}

export type AgentEvent =
  | TextEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent
  | DoneEvent;

// --- Token Usage ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

// --- Session ---

export interface Session {
  id: string;
  providerId: string;
  providerSessionId?: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionConfig {
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// --- Tool Definition ---

export const ToolParameterSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.any()),
  required: z.array(z.string()).optional(),
});

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.infer<typeof ToolParameterSchema>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// --- Provider Interface ---

export interface ModelProvider {
  readonly name: "claude" | "openai";
  readonly displayName: string;

  /** Check if the provider is authenticated */
  isAuthenticated(): Promise<boolean>;

  /** Initiate authentication flow */
  authenticate(): Promise<void>;

  /** Create a new conversation session */
  createSession(config: SessionConfig): Promise<Session>;

  /** Resume an existing session */
  resumeSession(id: string): Promise<Session>;

  /** Send a message and stream events */
  send(
    session: Session,
    message: string,
    tools: ToolDefinition[],
    attachments?: Attachment[],
  ): AsyncGenerator<AgentEvent>;

  /** Interrupt the current generation */
  interrupt(session: Session): void;

  /** Replace conversation history with a checkpoint briefing (context window management). */
  resetHistory(session: Session, briefingMessage: string): void;

  /** Clean up session resources */
  closeSession(session: Session): Promise<void>;

  /** Fetch available models (optional) */
  fetchModels?(): Promise<ModelInfo[]>;

  /** Get/set the current model */
  currentModel: string;

  /** Get/set reasoning effort */
  reasoningEffort: ReasoningEffort;
}

// Claude: "medium" | "high" | "max"
// OpenAI: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}

// --- Attachments ---

export interface Attachment {
  /** Original filename (e.g. "plan.pdf", "screenshot.png") */
  filename: string;
  /** MIME type */
  mediaType: string;
  /** Base64-encoded file content */
  data: string;
}

// --- Constants ---

/** Faux-assistant response used after a context checkpoint reset. */
export const CHECKPOINT_ACK = "Understood. I have my memory tree and will continue working. Let me check what needs to be done.";

// --- Auth Types ---

export type AuthMethod = "api_key" | "oauth";

export interface AuthCredentials {
  method: AuthMethod;
  provider: "claude" | "openai";
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresAt?: number;
}
