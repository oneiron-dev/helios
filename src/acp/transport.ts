/**
 * JSON-RPC 2.0 over stdio transport for ACP.
 * Messages are newline-delimited JSON on stdin/stdout.
 */

import { createInterface } from "node:readline";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
} from "./types.js";

type MethodHandler = (params: Record<string, unknown>, id: number | string) => Promise<unknown>;
type NotificationHandler = (params: Record<string, unknown>) => void;

export class StdioTransport {
  private rl;
  private methods = new Map<string, MethodHandler>();
  private notifications = new Map<string, NotificationHandler>();
  private pending = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private nextId = 1;

  constructor() {
    this.rl = createInterface({ input: process.stdin, terminal: false });
  }

  /** Register a handler for incoming requests (has id, expects response). */
  onMethod(method: string, handler: MethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Register a handler for incoming notifications (no id, no response). */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notifications.set(method, handler);
  }

  /** Send a notification to the client (no response expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.writeLine(msg);
  }

  /** Send a request to the client and wait for a response (30s timeout). */
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.writeLine(msg);
    });
  }

  /** Start reading from stdin. */
  start(): void {
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      this.dispatch(msg);
    });
  }

  stop(): void {
    this.rl.close();
  }

  // ── Internal ────────────────────────────────────────

  private dispatch(msg: Record<string, unknown>): void {
    // Response to one of our requests
    if ("result" in msg || "error" in msg) {
      const id = msg.id as number | string;
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (msg.error) {
          const err = msg.error as JsonRpcError;
          p.reject(new Error(err.message));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    const method = msg.method as string;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    // Notification (no id)
    if (!("id" in msg) || msg.id === undefined || msg.id === null) {
      const handler = this.notifications.get(method);
      if (handler) handler(params);
      return;
    }

    // Request (has id)
    const id = msg.id as number | string;
    const handler = this.methods.get(method);
    if (!handler) {
      this.sendError(id, -32601, `Method not found: ${method}`);
      return;
    }
    handler(params, id)
      .then((result) => this.sendResult(id, result))
      .catch((err) => this.sendError(id, -32000, err instanceof Error ? err.message : "Internal error"));
  }

  private sendResult(id: number | string, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result: result ?? null };
    this.writeLine(msg);
  }

  private sendError(id: number | string, code: number, message: string): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
    this.writeLine(msg);
  }

  private writeLine(msg: unknown): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }
}
