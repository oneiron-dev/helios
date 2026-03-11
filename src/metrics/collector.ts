import type { ConnectionPool } from "../remote/connection-pool.js";
import { MetricStore, type MetricPoint } from "./store.js";
import { type MetricPatterns, parseWithPatterns } from "./parser.js";
import { shellQuote } from "../ui/format.js";

export interface CollectorSource {
  taskId: string;
  machineId: string;
  logPath: string;
  patterns: MetricPatterns;
}

export class MetricCollector {
  private sources: CollectorSource[] = [];
  private lastLineCount = new Map<string, number>();

  constructor(
    private pool: ConnectionPool,
    private store: MetricStore,
  ) {}

  addSource(source: CollectorSource): void {
    const exists = this.sources.some((s) => s.taskId === source.taskId);
    if (!exists) {
      this.sources.push(source);
    }
  }

  removeSource(taskId: string): void {
    this.sources = this.sources.filter((s) => s.taskId !== taskId);
    for (const key of this.lastLineCount.keys()) {
      if (key.startsWith(taskId + ":")) {
        this.lastLineCount.delete(key);
      }
    }
  }

  /** Reset all sources and line tracking (e.g. on metrics clear) */
  reset(): void {
    this.sources = [];
    this.lastLineCount.clear();
  }

  async collectAll(): Promise<MetricPoint[]> {
    const results = await Promise.all(
      this.sources.map(async (source) => {
        try {
          const points = await this.collect(source);
          if (points.length > 0) {
            this.store.insertBatch(source.taskId, source.machineId, points);
          }
          return points;
        } catch {
          return [];
        }
      }),
    );

    return results.flat();
  }

  private async collect(source: CollectorSource): Promise<MetricPoint[]> {
    const key = `${source.taskId}:${source.logPath}`;
    const lastCount = this.lastLineCount.get(key) ?? 0;

    const wcResult = await this.pool.exec(
      source.machineId,
      `wc -l < ${shellQuote(source.logPath)}`,
    );
    const totalLines = parseInt(wcResult.stdout.trim(), 10);
    if (isNaN(totalLines) || totalLines <= lastCount) {
      return [];
    }

    const newLineCount = totalLines - lastCount;
    const output = await this.pool.tailFile(
      source.machineId,
      source.logPath,
      newLineCount,
    );

    this.lastLineCount.set(key, totalLines);
    return parseWithPatterns(output, source.patterns);
  }
}
