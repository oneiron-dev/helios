import { getDb } from "../store/database.js";

export interface MemoryNode {
  path: string;
  gist: string;
  content: string | null;
  isDir: boolean;
  createdAt: number;
  updatedAt: number;
}

export class MemoryStore {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** List children of a directory path. */
  ls(dirPath = "/"): MemoryNode[] {
    const normalized = normalizeDirPath(dirPath);
    const db = getDb();
    const prefixLen = normalized.length;

    // Fetch all descendants, filter to direct children in JS (simple and correct)
    // Only fetches gist-level columns to keep it lightweight (no content)
    const rows = db
      .prepare(
        `SELECT path, gist, is_dir, created_at, updated_at
         FROM memory_nodes
         WHERE session_id = ? AND path LIKE ? AND path != ?`,
      )
      .all(this.sessionId, normalized + "%", normalized) as Record<string, unknown>[];

    return rows
      .filter((row) => {
        const rel = (row.path as string).slice(prefixLen);
        return !rel.includes("/") || (rel.endsWith("/") && !rel.slice(0, -1).includes("/"));
      })
      .map(rowToNode);
  }

  /** Recursively list all nodes under a path, returning paths + gists only. */
  tree(dirPath = "/"): Array<{ path: string; gist: string; isDir: boolean }> {
    const normalized = normalizeDirPath(dirPath);
    const db = getDb();

    const rows = db
      .prepare(
        `SELECT path, gist, is_dir
         FROM memory_nodes
         WHERE session_id = ? AND path LIKE ? AND path != ?
         ORDER BY path`,
      )
      .all(this.sessionId, normalized + "%", normalized) as Record<string, unknown>[];

    return rows.map((row) => ({
      path: row.path as string,
      gist: row.gist as string,
      isDir: (row.is_dir as number) === 1,
    }));
  }

  /** Read a node's full content. */
  read(path: string): MemoryNode | null {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT path, gist, content, is_dir, created_at, updated_at
         FROM memory_nodes
         WHERE session_id = ? AND path = ?`,
      )
      .get(this.sessionId, path) as Record<string, unknown> | undefined;

    return row ? rowToNode(row) : null;
  }

  /** Write or update a node. Auto-creates parent directories. */
  write(path: string, gist: string, content?: string | null): void {
    const db = getDb();
    const now = Date.now();
    const isDir = content === undefined || content === null;

    // Auto-create parent directories
    this.ensureParents(path);

    db.prepare(
      `INSERT INTO memory_nodes (session_id, path, gist, content, is_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, path) DO UPDATE SET
         gist = excluded.gist,
         content = excluded.content,
         is_dir = excluded.is_dir,
         updated_at = excluded.updated_at`,
    ).run(this.sessionId, path, gist, isDir ? null : content, isDir ? 1 : 0, now, now);
  }

  /** Remove a node and all children (if directory). */
  rm(path: string): number {
    const db = getDb();

    // Delete exact match + any children
    const result = db
      .prepare(
        `DELETE FROM memory_nodes
         WHERE session_id = ? AND (path = ? OR path LIKE ?)`,
      )
      .run(this.sessionId, path, path.endsWith("/") ? path + "%" : path + "/%");

    return result.changes;
  }

  /** Check if a path exists. */
  exists(path: string): boolean {
    const db = getDb();
    const row = db
      .prepare("SELECT 1 FROM memory_nodes WHERE session_id = ? AND path = ?")
      .get(this.sessionId, path);
    return !!row;
  }

  /** Count all nodes for this session. */
  count(): number {
    const db = getDb();
    const row = db
      .prepare("SELECT COUNT(*) as c FROM memory_nodes WHERE session_id = ?")
      .get(this.sessionId) as { c: number };
    return row.c;
  }

  /** Build a formatted tree string (paths + gists) for checkpoint briefings. */
  formatTree(dirPath = "/"): string {
    const nodes = this.tree(dirPath);
    if (nodes.length === 0) return "(empty)";

    const lines: string[] = [];
    for (const node of nodes) {
      const parts = node.path.split("/").filter(Boolean);
      const depth = parts.length - 1;
      const indent = "  ".repeat(depth);
      const name = parts[parts.length - 1] + (node.isDir ? "/" : "");
      lines.push(`${indent}${name}: ${node.gist}`);
    }
    return lines.join("\n");
  }

  /** Clear all memory for this session. */
  clear(): void {
    const db = getDb();
    db.prepare("DELETE FROM memory_nodes WHERE session_id = ?").run(this.sessionId);
  }

  private ensureParents(path: string): void {
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 1) return;
    const db = getDb();
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO memory_nodes (session_id, path, gist, content, is_dir, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 1, ?, ?)`,
    );
    // For "/a/b/c", ensure "/a/" and "/a/b/" exist
    for (let i = 1; i < parts.length; i++) {
      const parentPath = "/" + parts.slice(0, i).join("/") + "/";
      stmt.run(this.sessionId, parentPath, parts[i - 1], now, now);
    }
  }
}

function normalizeDirPath(path: string): string {
  if (path === "/") return "/";
  return path.endsWith("/") ? path : path + "/";
}

function rowToNode(row: Record<string, unknown>): MemoryNode {
  return {
    path: row.path as string,
    gist: row.gist as string,
    content: row.content as string | null,
    isDir: (row.is_dir as number) === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
