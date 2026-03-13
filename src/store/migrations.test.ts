import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** List all user tables (excluding sqlite internals). */
function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/** Get column names for a table. */
function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map(
    (c) => c.name,
  );
}

/** Get the current schema version stored in the DB. */
function currentVersion(db: Database.Database): number {
  const row = db
    .prepare("SELECT MAX(version) as v FROM _schema_version")
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

describe("runMigrations", () => {
  it("creates _schema_version table", () => {
    const db = freshDb();
    runMigrations(db);
    const tables = tableNames(db);
    expect(tables).toContain("_schema_version");
    db.close();
  });

  it("runs all migrations on fresh database (version reaches 5)", () => {
    const db = freshDb();
    runMigrations(db);
    expect(currentVersion(db)).toBe(6);
    db.close();
  });

  it("migrations are idempotent (running twice does not error)", () => {
    const db = freshDb();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(currentVersion(db)).toBe(6);
    db.close();
  });

  it("creates sessions table with correct columns", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "sessions");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "provider",
        "provider_session_id",
        "model",
        "status",
        "created_at",
        "last_active_at",
      ]),
    );
    db.close();
  });

  it("creates messages table with correct columns", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "messages");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "session_id",
        "role",
        "content",
        "tool_calls",
        "token_count",
        "timestamp",
      ]),
    );
    db.close();
  });

  it("creates tasks table with correct columns", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "tasks");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "session_id",
        "machine_id",
        "command",
        "pid",
        "log_path",
        "status",
        "exit_code",
        "created_at",
        "completed_at",
      ]),
    );
    db.close();
  });

  it("creates metrics table with correct columns", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "metrics");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "task_id",
        "machine_id",
        "metric_name",
        "value",
        "step",
        "timestamp",
        "agent_id", // added in v3
      ]),
    );
    db.close();
  });

  it("creates machines table with correct columns", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "machines");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "host",
        "port",
        "username",
        "auth_method",
        "key_path",
        "labels",
        "created_at",
      ]),
    );
    db.close();
  });

  it("creates triggers table with correct columns", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "triggers");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "session_id",
        "expression",
        "status",
        "sleep_reason",
        "context_snapshot_id",
        "poll_interval_ms",
        "deadline",
        "satisfied_leaves",
        "last_evaluated_at",
        "last_error",
        "created_at",
        "satisfied_at",
      ]),
    );
    db.close();
  });

  it("creates memory_nodes table with correct columns (v2)", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "memory_nodes");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "session_id",
        "path",
        "gist",
        "content",
        "is_dir",
        "created_at",
        "updated_at",
      ]),
    );
    db.close();
  });

  it("version 3 adds agent_id to metrics", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "metrics");
    expect(cols).toContain("agent_id");
    db.close();
  });

  it("version 3 adds agent_id to sessions", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "sessions");
    expect(cols).toContain("agent_id");
    db.close();
  });

  it("version 5 adds cost columns to sessions", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = columnNames(db, "sessions");
    expect(cols).toContain("cost_usd");
    expect(cols).toContain("input_tokens");
    expect(cols).toContain("output_tokens");
    db.close();
  });

  it("respects existing schema version (skips applied migrations)", () => {
    const db = freshDb();
    runMigrations(db);
    expect(currentVersion(db)).toBe(6);

    // Running again should be a no-op — version stays at 5
    runMigrations(db);
    const versions = (
      db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    // Each version should appear exactly once
    expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
    db.close();
  });

  it("can insert and query sessions after migration", () => {
    const db = freshDb();
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      "INSERT INTO sessions (id, provider, status, created_at, last_active_at, agent_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("sess-1", "claude", "active", now, now, "");

    const row = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get("sess-1") as Record<string, unknown>;
    expect(row.id).toBe("sess-1");
    expect(row.provider).toBe("claude");
    expect(row.status).toBe("active");
    db.close();
  });

  it("can insert and query messages after migration", () => {
    const db = freshDb();
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      "INSERT INTO sessions (id, provider, status, created_at, last_active_at, agent_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("sess-1", "claude", "active", now, now, "");
    db.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
    ).run("sess-1", "user", "hello", now);

    const row = db
      .prepare("SELECT * FROM messages WHERE session_id = ?")
      .get("sess-1") as Record<string, unknown>;
    expect(row.role).toBe("user");
    expect(row.content).toBe("hello");
    db.close();
  });

  it("can insert and query metrics after migration", () => {
    const db = freshDb();
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      "INSERT INTO metrics (task_id, machine_id, metric_name, value, step, timestamp, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("task-1", "m-1", "loss", 0.5, 100, now, "agent-1");

    const row = db
      .prepare("SELECT * FROM metrics WHERE task_id = ?")
      .get("task-1") as Record<string, unknown>;
    expect(row.metric_name).toBe("loss");
    expect(row.value).toBe(0.5);
    expect(row.agent_id).toBe("agent-1");
    db.close();
  });

  it("can insert and query memory_nodes after migration", () => {
    const db = freshDb();
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      "INSERT INTO memory_nodes (session_id, path, gist, content, is_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("sess-1", "/experiments/run1", "first run", "details", 0, now, now);

    const row = db
      .prepare("SELECT * FROM memory_nodes WHERE session_id = ?")
      .get("sess-1") as Record<string, unknown>;
    expect(row.path).toBe("/experiments/run1");
    expect(row.gist).toBe("first run");
    expect(row.is_dir).toBe(0);
    db.close();
  });

  it("foreign key constraint works (message references session)", () => {
    const db = freshDb();
    runMigrations(db);
    const now = Date.now();
    // Insert a message referencing a non-existent session should fail
    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
        )
        .run("nonexistent-session", "user", "hello", now),
    ).toThrow();
    db.close();
  });

  it("indexes are created (verify with PRAGMA index_list)", () => {
    const db = freshDb();
    runMigrations(db);

    const metricsIndexes = (
      db.pragma("index_list(metrics)") as { name: string }[]
    ).map((i) => i.name);
    expect(metricsIndexes).toContain("idx_metrics_task_name");
    expect(metricsIndexes).toContain("idx_metrics_name_ts");
    expect(metricsIndexes).toContain("idx_metrics_agent");
    expect(metricsIndexes).toContain("idx_metrics_agent_task");

    const messagesIndexes = (
      db.pragma("index_list(messages)") as { name: string }[]
    ).map((i) => i.name);
    expect(messagesIndexes).toContain("idx_messages_session");

    const memoryIndexes = (
      db.pragma("index_list(memory_nodes)") as { name: string }[]
    ).map((i) => i.name);
    expect(memoryIndexes).toContain("idx_memory_session_path");

    const sessionsIndexes = (
      db.pragma("index_list(sessions)") as { name: string }[]
    ).map((i) => i.name);
    expect(sessionsIndexes).toContain("idx_sessions_agent");

    db.close();
  });
});
