import { getDb } from "../store/database.js";

export interface MetricPoint {
  metricName: string;
  value: number;
  step?: number;
  timestamp: number;
}

export class MetricStore {
  private agentId: string;

  constructor(agentId = "") {
    this.agentId = agentId;
  }

  insert(
    taskId: string,
    machineId: string,
    point: MetricPoint,
  ): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO metrics (task_id, machine_id, metric_name, value, step, timestamp, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      machineId,
      point.metricName,
      point.value,
      point.step ?? null,
      point.timestamp,
      this.agentId,
    );
  }

  insertBatch(
    taskId: string,
    machineId: string,
    points: MetricPoint[],
  ): void {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO metrics (task_id, machine_id, metric_name, value, step, timestamp, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertMany = db.transaction((pts: MetricPoint[]) => {
      for (const p of pts) {
        stmt.run(
          taskId,
          machineId,
          p.metricName,
          p.value,
          p.step ?? null,
          p.timestamp,
          this.agentId,
        );
      }
    });

    insertMany(points);
  }

  getLatest(
    taskId: string,
    metricName: string,
  ): MetricPoint | null {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT * FROM metrics
         WHERE task_id = ? AND metric_name = ? AND agent_id = ?
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(taskId, metricName, this.agentId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      metricName: row.metric_name as string,
      value: row.value as number,
      step: row.step as number | undefined,
      timestamp: row.timestamp as number,
    };
  }

  getSeries(
    taskId: string,
    metricName: string,
    limit = 200,
  ): MetricPoint[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM metrics
           WHERE task_id = ? AND metric_name = ? AND agent_id = ?
           ORDER BY timestamp DESC
           LIMIT ?
         ) ORDER BY timestamp ASC`,
      )
      .all(taskId, metricName, this.agentId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      metricName: row.metric_name as string,
      value: row.value as number,
      step: row.step as number | undefined,
      timestamp: row.timestamp as number,
    }));
  }

  getMetricNames(taskId: string): string[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT DISTINCT metric_name FROM metrics WHERE task_id = ? AND agent_id = ?`,
      )
      .all(taskId, this.agentId) as { metric_name: string }[];
    return rows.map((r) => r.metric_name);
  }

  /** Get all distinct task IDs that have metrics */
  getTaskIds(): string[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT DISTINCT task_id FROM metrics WHERE agent_id = ?")
      .all(this.agentId) as { task_id: string }[];
    return rows.map((r) => r.task_id);
  }

  /** Get all metric names across all tasks for this agent */
  getAllMetricNames(): string[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT DISTINCT metric_name FROM metrics WHERE agent_id = ?")
      .all(this.agentId) as { metric_name: string }[];
    return rows.map((r) => r.metric_name);
  }

  /** Get series for a metric name across all tasks, merged by timestamp */
  getSeriesAcrossTasks(
    metricName: string,
    limit = 200,
  ): MetricPoint[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM metrics
           WHERE metric_name = ? AND agent_id = ?
           ORDER BY timestamp DESC
           LIMIT ?
         ) ORDER BY timestamp ASC`,
      )
      .all(metricName, this.agentId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      metricName: row.metric_name as string,
      value: row.value as number,
      step: row.step as number | undefined,
      timestamp: row.timestamp as number,
    }));
  }

  /** Get recent series for ALL metric names in a single query. Returns a map of name → values. */
  getAllSeries(limit = 50): Map<string, number[]> {
    const db = getDb();
    // Get the most recent `limit` points per metric name
    const rows = db
      .prepare(
        `SELECT metric_name, value FROM (
           SELECT metric_name, value, timestamp,
             ROW_NUMBER() OVER (PARTITION BY metric_name ORDER BY timestamp DESC) AS rn
           FROM metrics
           WHERE agent_id = ?
         ) WHERE rn <= ?
         ORDER BY metric_name, timestamp ASC`,
      )
      .all(this.agentId, limit) as { metric_name: string; value: number }[];

    const result = new Map<string, number[]>();
    for (const row of rows) {
      let arr = result.get(row.metric_name);
      if (!arr) {
        arr = [];
        result.set(row.metric_name, arr);
      }
      arr.push(row.value);
    }
    return result;
  }

  /** Get a summary of final metrics for a task (latest value of each metric) */
  getTaskSummary(taskId: string): Record<string, { latest: number; min: number; max: number; count: number }> {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT metric_name,
                (SELECT value FROM metrics m2 WHERE m2.task_id = m1.task_id AND m2.metric_name = m1.metric_name AND m2.agent_id = ? ORDER BY timestamp DESC LIMIT 1) as latest,
                MIN(value) as min_val,
                MAX(value) as max_val,
                COUNT(*) as cnt
         FROM metrics m1
         WHERE task_id = ? AND agent_id = ?
         GROUP BY metric_name`,
      )
      .all(this.agentId, taskId, this.agentId) as Record<string, unknown>[];

    const summary: Record<string, { latest: number; min: number; max: number; count: number }> = {};
    for (const row of rows) {
      summary[row.metric_name as string] = {
        latest: row.latest as number,
        min: row.min_val as number,
        max: row.max_val as number,
        count: row.cnt as number,
      };
    }
    return summary;
  }

  /** Delete all metrics for a specific task */
  clearTask(taskId: string): number {
    const db = getDb();
    const result = db
      .prepare("DELETE FROM metrics WHERE task_id = ? AND agent_id = ?")
      .run(taskId, this.agentId);
    return result.changes;
  }

  /** Delete all metrics for this agent */
  clear(): number {
    const db = getDb();
    const result = db
      .prepare("DELETE FROM metrics WHERE agent_id = ?")
      .run(this.agentId);
    return result.changes;
  }

  /** Get latest value for every metric of a given task in a single query. */
  getLatestAll(taskId: string): Record<string, number> {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT metric_name, value FROM metrics m1
         WHERE task_id = ? AND agent_id = ?
           AND timestamp = (
             SELECT MAX(timestamp) FROM metrics m2
             WHERE m2.task_id = m1.task_id AND m2.metric_name = m1.metric_name AND m2.agent_id = m1.agent_id
           )`,
      )
      .all(taskId, this.agentId) as { metric_name: string; value: number }[];

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.metric_name] = row.value;
    }
    return result;
  }

  /** Get the latest value for every metric name across all tasks in one query. */
  getLatestPerMetric(): Record<string, number> {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT metric_name, value FROM metrics m1
         WHERE agent_id = ?
           AND timestamp = (
             SELECT MAX(timestamp) FROM metrics m2
             WHERE m2.metric_name = m1.metric_name AND m2.agent_id = m1.agent_id
           )`,
      )
      .all(this.agentId) as { metric_name: string; value: number }[];

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.metric_name] = row.value;
    }
    return result;
  }

  /** Clean up metrics older than retentionDays */
  cleanup(retentionDays: number): number {
    const db = getDb();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const result = db
      .prepare("DELETE FROM metrics WHERE timestamp < ? AND agent_id = ?")
      .run(cutoff, this.agentId);
    return result.changes;
  }
}
