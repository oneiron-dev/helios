import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Experiment,
  ExperimentAdapter,
  ExperimentSummary,
  ExperimentDetail,
  ColumnDef,
  OperatorAction,
  LineageInfo,
} from "../types.js";

const GATES = [
  { name: "macro_f1 >= 0.40", key: "macro_f1", min: 0.40 },
  { name: "rel_ref_precision >= 0.30", key: "rel_ref_precision", min: 0.30 },
  { name: "peak_vram_mb <= 1500", key: "peak_vram_mb", max: 1500 },
] as const;

const COMPOSITE_WEIGHTS = [
  { label: "REL_REF F0.5", key: "rel_ref_f05", weight: 0.40 },
  { label: "Sync macro F1", key: "macro_f1", weight: 0.25 },
  { label: "REL hard-neg prec", key: "rel_hard_neg_prec", weight: 0.20 },
  { label: "Multilingual F1", key: "multilingual_f1", weight: 0.10 },
  { label: "Latency bonus", key: "latency_bonus", weight: 0.05 },
] as const;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatVram(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)}G`;
  return `${mb.toFixed(0)}M`;
}

function fmtMetric(decimals: number, fallback: string): (v: unknown) => string {
  return (v) => v != null ? (v as number).toFixed(decimals) : fallback;
}

function resolveStatusColor(status: string): Experiment["statusColor"] {
  if (status === "keep") return "success";
  if (status === "revert") return "error";
  return "dim";
}

function checkGates(metrics: Record<string, number>): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const gate of GATES) {
    const val = metrics[gate.key];
    if (val === undefined) continue;
    if ("min" in gate && val < gate.min) {
      failures.push(`${gate.name} (got ${val.toFixed(3)})`);
    }
    if ("max" in gate && val > gate.max) {
      failures.push(`${gate.name} (got ${val.toFixed(0)})`);
    }
  }
  return { passed: failures.length === 0, failures };
}

export class AutoresearchTsvAdapter implements ExperimentAdapter {
  id = "autoresearch-tsv";
  name = "Autoresearch NER";

  private projectRoot: string;
  private researchDir: string;
  private tsvPath: string;
  private experiments: Experiment[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbacks: Array<() => void> = [];
  private lastTsvContent = "";

  constructor(projectRoot: string, researchDir?: string) {
    this.projectRoot = projectRoot;
    this.researchDir = researchDir ?? join(projectRoot, "research");
    this.tsvPath = join(this.researchDir, "results.tsv");
  }

  async load(): Promise<Experiment[]> {
    const rows = this.parseTsv();
    const reasoning = this.loadReasoning(rows.map((r) => r.commit).filter(Boolean));

    this.experiments = rows.map((row, i) => {
      const status = (row.status ?? "").toLowerCase();
      const metrics: Record<string, number> = {};
      for (const key of [
        "macro_f1", "micro_f1", "rel_ref_f05", "rel_ref_precision",
        "rel_hard_neg_prec", "multilingual_f1", "latency_bonus",
        "tokens_seen", "steps", "peak_vram_mb",
      ]) {
        const val = parseFloat(row[key]);
        if (!isNaN(val)) metrics[key] = val;
      }

      const { passed: gatesPassed, failures: gateFailures } = checkGates(metrics);
      const composite = parseFloat(row.composite);
      const commitId = row.commit ?? `row-${i}`;

      return {
        id: commitId,
        status,
        statusColor: resolveStatusColor(status),
        compositeScore: isNaN(composite) ? null : composite,
        metrics,
        description: row.description ?? "",
        parentId: i > 0 ? (rows[i - 1].commit ?? `row-${i - 1}`) : undefined,
        familyId: "autoresearch",
        generation: i,
        metadata: {
          row_number: i + 1,
          gatesPassed,
          gateFailures,
          reasoning: reasoning.get(commitId) ?? null,
        },
      };
    });
    return this.experiments;
  }

  getSummary(): ExperimentSummary {
    const exps = this.experiments;
    const keep = exps.filter((e) => e.status === "keep");
    const revert = exps.filter((e) => e.status === "revert");
    const gatesFailed = exps.filter((e) => !e.metadata.gatesPassed).length;
    const bestScore = keep.length > 0
      ? Math.max(...keep.map((e) => e.compositeScore ?? 0))
      : null;

    return {
      label: "autoresearch: NER",
      stats: [
        { key: "total", value: String(exps.length) },
        { key: "keep", value: String(keep.length) },
        { key: "revert", value: String(revert.length) },
        { key: "gates_failed", value: String(gatesFailed) },
      ],
      bestScore,
      totalCount: exps.length,
      activeCount: 0,
    };
  }

  getDetail(experimentId: string): ExperimentDetail {
    const exp = this.experiments.find((e) => e.id === experimentId);
    if (!exp) return { sections: [{ title: "Error", content: "Experiment not found" }] };

    const sections: ExperimentDetail["sections"] = [];

    sections.push({
      title: "Experiment",
      content: [
        `commit: ${exp.id}`,
        `status: ${exp.status}`,
        `description: ${exp.description}`,
      ].join("\n"),
    });

    // 2. Captain reasoning (if available)
    const reasoning = exp.metadata.reasoning as string | null;
    if (reasoning) {
      sections.push({ title: "Captain Reasoning", content: reasoning });
    }

    // 3. Composite breakdown
    const breakdownLines = COMPOSITE_WEIGHTS.map((w) => {
      const val = exp.metrics[w.key] ?? 0;
      const contribution = val * w.weight;
      return `${w.label.padEnd(20)} ${val.toFixed(4)} × ${w.weight.toFixed(2)} = ${contribution.toFixed(4)}`;
    });
    const total = COMPOSITE_WEIGHTS.reduce(
      (sum, w) => sum + (exp.metrics[w.key] ?? 0) * w.weight,
      0,
    );
    breakdownLines.push(`${"TOTAL".padEnd(20)} ${" ".repeat(16)} ${total.toFixed(4)}`);
    sections.push({ title: "Composite Breakdown", content: breakdownLines.join("\n") });

    const gateLines = GATES.map((gate) => {
      const val = exp.metrics[gate.key];
      if (val === undefined) return `? ${gate.name} (no data)`;
      let passed = true;
      if ("min" in gate && val < gate.min) passed = false;
      if ("max" in gate && val > gate.max) passed = false;
      return `${passed ? "✓" : "✗"} ${gate.name} (actual: ${val.toFixed(3)})`;
    });
    sections.push({ title: "Gate Status", content: gateLines.join("\n") });

    const tokens = exp.metrics.tokens_seen;
    const steps = exp.metrics.steps;
    const vram = exp.metrics.peak_vram_mb;
    const trainingLines = [
      tokens !== undefined ? `tokens: ${formatTokens(tokens)}` : null,
      steps !== undefined ? `steps: ${steps}` : null,
      vram !== undefined ? `peak VRAM: ${formatVram(vram)}` : null,
    ].filter(Boolean);
    if (trainingLines.length > 0) {
      sections.push({ title: "Training Stats", content: trainingLines.join("\n") });
    }

    return { sections };
  }

  getColumns(width: number): ColumnDef[] {
    const narrow = width < 80;
    const cols: ColumnDef[] = [
      { key: "row_number", label: "#", width: 3, align: "right" },
      { key: "id", label: "COMMIT", width: 10, align: "left" },
      {
        key: "status",
        label: "DECISION",
        width: 8,
        align: "left",
        color: (v) => (v === "keep" ? "green" : "red"),
      },
      {
        key: "compositeScore",
        label: "SCORE",
        width: 8,
        align: "right",
        format: fmtMetric(4, "-.----"),
      },
      {
        key: "macro_f1",
        label: "F1",
        width: 6,
        align: "right",
        format: fmtMetric(3, "-.-"),
      },
      {
        key: "rel_ref_f05",
        label: "REL",
        width: 6,
        align: "right",
        format: fmtMetric(3, "-.-"),
      },
      {
        key: "rel_hard_neg_prec",
        label: "NEG_P",
        width: 6,
        align: "right",
        format: fmtMetric(3, "-.-"),
      },
    ];

    if (!narrow) {
      cols.push({
        key: "tokens_seen",
        label: "TOKENS",
        width: 7,
        align: "right",
        format: (v) => v != null ? formatTokens(v as number) : "—",
      }, {
        key: "peak_vram_mb",
        label: "VRAM",
        width: 6,
        align: "right",
        format: (v) => v != null ? formatVram(v as number) : "—",
      });
    }

    return cols;
  }

  getActions(): OperatorAction[] {
    return [
      {
        name: "view-config-diff",
        label: "View config diff",
        buildExec: (exp) => ({
          argv: ["git", "diff", `${exp.id}~1`, exp.id, "--", "research/train.py"],
          cwd: this.projectRoot,
        }),
      },
      {
        name: "rerun-from-point",
        label: "Rerun from point",
        confirmRequired: true,
        buildExec: (exp) => ({
          argv: ["prose", "run", "research/autoresearch.prose", "--from", exp.id],
          cwd: this.projectRoot,
        }),
      },
    ];
  }

  getLineage(): LineageInfo[] {
    return this.experiments.map((exp) => ({
      experimentId: exp.id,
      primaryParentId: exp.parentId,
      parentIds: exp.parentId ? [exp.parentId] : undefined,
      familyId: exp.familyId ?? "autoresearch",
      generation: exp.generation ?? 0,
    }));
  }

  startPolling(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      const content = this.readTsvRaw();
      if (content !== this.lastTsvContent) {
        this.lastTsvContent = content;
        await this.load();
        for (const cb of this.callbacks) cb();
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onUpdate(callback: () => void): void {
    this.callbacks.push(callback);
  }

  // ─── Private helpers ─────────────────────────────────

  /**
   * Load captain reasoning with 3-tier priority:
   * 1. Structured sidecar: research/reasoning.jsonl
   * 2. Git log fallback: commit messages for each experiment commit
   * 3. TSV description column (already in experiment.description, not here)
   */
  private loadReasoning(commitIds: string[]): Map<string, string> {
    // Tier 1: reasoning.jsonl sidecar
    const sidecar = this.loadReasoningJsonl();
    if (sidecar.size > 0) return sidecar;

    // Tier 2: git log fallback
    if (commitIds.length > 0) {
      return this.loadGitReasoning(commitIds);
    }

    return new Map();
  }

  private loadReasoningJsonl(): Map<string, string> {
    const jsonlPath = join(this.researchDir, "reasoning.jsonl");
    if (!existsSync(jsonlPath)) return new Map();

    try {
      const raw = readFileSync(jsonlPath, "utf-8");
      const map = new Map<string, string>();
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { experimentId?: string; reasoning?: string };
          if (entry.experimentId && entry.reasoning) {
            map.set(entry.experimentId, entry.reasoning);
          }
        } catch { /* skip malformed lines */ }
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private loadGitReasoning(commitIds: string[]): Map<string, string> {
    const map = new Map<string, string>();
    // Resolve git dir: use the research dir's repo, or fall back to projectRoot
    const gitDir = this.findGitRoot();
    if (!gitDir) return map;

    for (const commitId of commitIds) {
      try {
        const msg = execFileSync(
          "git", ["log", "-1", "--format=%B", commitId],
          { cwd: gitDir, encoding: "utf-8", timeout: 5000 },
        ).trim();
        if (msg) map.set(commitId, msg);
      } catch { /* commit not found in this repo — skip */ }
    }
    return map;
  }

  private findGitRoot(): string | null {
    // Check if researchDir is inside a git repo
    try {
      return execFileSync(
        "git", ["rev-parse", "--show-toplevel"],
        { cwd: this.researchDir, encoding: "utf-8", timeout: 3000 },
      ).trim();
    } catch {
      // researchDir might not exist or not be a git repo
      try {
        return execFileSync(
          "git", ["rev-parse", "--show-toplevel"],
          { cwd: this.projectRoot, encoding: "utf-8", timeout: 3000 },
        ).trim();
      } catch {
        return null;
      }
    }
  }

  private readTsvRaw(): string {
    try {
      return readFileSync(this.tsvPath, "utf-8");
    } catch {
      return "";
    }
  }

  private parseTsv(): Array<Record<string, string>> {
    const raw = this.readTsvRaw();
    if (!raw.trim()) return [];

    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length < 2) return [];

    const header = lines[0].split("\t");
    return lines.slice(1).map((line) => {
      const values = line.split("\t");
      const row: Record<string, string> = {};
      for (let j = 0; j < header.length; j++) {
        row[header[j]] = values[j] ?? "";
      }
      return row;
    });
  }
}
