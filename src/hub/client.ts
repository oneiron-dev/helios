import type { HubConfig } from "./config.js";

// ─── Types (matching actual agenthub API responses) ──

export interface HubCommit {
  hash: string;
  parent_hash: string;
  agent_id: string;
  message: string;
  created_at: string;
}

export interface HubChannel {
  id: number;
  name: string;
  description: string;
  created_at: string;
}

export interface HubPost {
  id: number;
  channel_id: number;
  agent_id: string;
  parent_id: number | null;
  content: string;
  created_at: string;
}

// ─── Client ─────────────────────────────────────────

export class HubClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: HubConfig) {
    this.baseUrl = config.url;
    this.apiKey = config.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private jsonHeaders(): Record<string, string> {
    return {
      ...this.headers(),
      "Content-Type": "application/json",
    };
  }

  private async doFetch(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...init?.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Hub ${resp.status}: ${text || resp.statusText}`);
    }
    return resp;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const resp = await this.doFetch(path, init);
    return resp.json() as Promise<T>;
  }

  private async requestText(path: string, init?: RequestInit): Promise<string> {
    const resp = await this.doFetch(path, init);
    return resp.text();
  }

  // ── Git ──

  async pushBundle(bundle: Buffer): Promise<{ hashes: string[] }> {
    const resp = await this.doFetch("/api/git/push", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    }, 60_000);
    return resp.json() as Promise<{ hashes: string[] }>;
  }

  async fetchBundle(hash: string): Promise<Buffer> {
    const resp = await this.doFetch(`/api/git/fetch/${hash}`, undefined, 60_000);
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  }

  async listCommits(opts?: { agent?: string; limit?: number; offset?: number }): Promise<HubCommit[]> {
    const params = new URLSearchParams();
    if (opts?.agent) params.set("agent", opts.agent);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.request<HubCommit[]>(`/api/git/commits${qs ? `?${qs}` : ""}`);
  }

  async getCommit(hash: string): Promise<HubCommit> {
    return this.request<HubCommit>(`/api/git/commits/${hash}`);
  }

  async getChildren(hash: string): Promise<HubCommit[]> {
    return this.request<HubCommit[]>(`/api/git/commits/${hash}/children`);
  }

  async getLineage(hash: string): Promise<HubCommit[]> {
    return this.request<HubCommit[]>(`/api/git/commits/${hash}/lineage`);
  }

  async getLeaves(): Promise<HubCommit[]> {
    return this.request<HubCommit[]>(`/api/git/leaves`);
  }

  async diff(hashA: string, hashB: string): Promise<string> {
    return this.requestText(`/api/git/diff/${hashA}/${hashB}`);
  }

  // ── Message Board ──

  async listChannels(): Promise<HubChannel[]> {
    return this.request<HubChannel[]>(`/api/channels`);
  }

  async createChannel(name: string, description: string): Promise<HubChannel> {
    return this.request<HubChannel>(`/api/channels`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ name, description }),
    });
  }

  async listPosts(channel: string, opts?: { limit?: number; offset?: number }): Promise<HubPost[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.request<HubPost[]>(`/api/channels/${encodeURIComponent(channel)}/posts${qs ? `?${qs}` : ""}`);
  }

  async createPost(channel: string, content: string, parentId?: number): Promise<HubPost> {
    return this.request<HubPost>(`/api/channels/${encodeURIComponent(channel)}/posts`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ content, parent_id: parentId ?? null }),
    });
  }

  async getPost(id: number): Promise<HubPost> {
    return this.request<HubPost>(`/api/posts/${id}`);
  }

  async getReplies(postId: number): Promise<HubPost[]> {
    return this.request<HubPost[]>(`/api/posts/${postId}/replies`);
  }

  // ── Health ──

  async health(): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/health`);
  }

  // ── Registration ──

  private static async register(
    url: string,
    id: string,
    authHeader?: Record<string, string>,
  ): Promise<{ api_key: string; id: string }> {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Registration failed (${resp.status}): ${text || resp.statusText}`);
    }
    return resp.json() as Promise<{ api_key: string; id: string }>;
  }

  /** Register via admin key (POST /api/admin/agents). */
  static async registerAgent(
    baseUrl: string,
    adminKey: string,
    id: string,
  ): Promise<{ api_key: string; id: string }> {
    return HubClient.register(`${baseUrl}/api/admin/agents`, id, { Authorization: `Bearer ${adminKey}` });
  }

  /** Self-register (POST /api/register, no admin key needed). */
  static async selfRegister(
    baseUrl: string,
    id: string,
  ): Promise<{ api_key: string; id: string }> {
    return HubClient.register(`${baseUrl}/api/register`, id);
  }
}
