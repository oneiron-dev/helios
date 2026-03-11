import type Database from "better-sqlite3";

interface Migration {
  version: number;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        token_count INTEGER,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        command TEXT NOT NULL,
        pid INTEGER,
        log_path TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        exit_code INTEGER,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        value REAL NOT NULL,
        step INTEGER,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_task_name
        ON metrics(task_id, metric_name, timestamp);

      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        key_path TEXT,
        labels TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        expression TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        sleep_reason TEXT,
        context_snapshot_id TEXT,
        poll_interval_ms INTEGER,
        deadline INTEGER,
        satisfied_leaves TEXT,
        last_evaluated_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        satisfied_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_name_ts
        ON metrics(metric_name, timestamp);

      CREATE TABLE IF NOT EXISTS memory_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        gist TEXT NOT NULL,
        content TEXT,
        is_dir INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(session_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_session_path
        ON memory_nodes(session_id, path);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE metrics ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_metrics_agent
        ON metrics(agent_id, metric_name, timestamp);

      ALTER TABLE sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_sessions_agent
        ON sessions(agent_id, last_active_at);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_metrics_agent_task
        ON metrics(agent_id, task_id, metric_name, timestamp);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const currentVersion =
    (
      db.prepare("SELECT MAX(version) as v FROM _schema_version").get() as
        | { v: number | null }
        | undefined
    )?.v ?? 0;

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare("INSERT INTO _schema_version (version) VALUES (?)").run(
          migration.version,
        );
      })();
    }
  }
}
