import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type {
  Experiment,
  ExperimentAdapter,
  ExperimentSummary,
  ExperimentDetail,
  ColumnDef,
  OperatorAction,
  LineageInfo,
} from "../types.js";

interface CandidateResult {
  run_id: string;
  candidate_id: string;
  candidate_dir: string;
  stage: string;
  status: string;
  started_at?: string;
  finished_at?: string;
  genome_hash?: string;
  artifact_hash?: string;
  behavior_hash?: string;
  promotable?: boolean;
  result?: {
    status: string;
    heldout_body_diff?: number;
    shadow_body_diff?: number;
    java_smoke_passed?: number;
    composite_score?: number;
    [key: string]: unknown;
  };
  training?: {
    metrics?: Record<string, unknown>;
  };
}

interface RunManifest {
  run_id: string;
  program?: string;
  status: string;
  promoted_candidate_id?: string;
  candidates: Record<string, {
    candidate_id: string;
    genome_hash?: string;
    kind?: string;
    stages: Record<string, string>; // stage name -> path to result JSON
  }>;
}

/** summary.json format from sweep_search.py (WinterChallenge) */
interface SweepSummary {
  run_name: string;
  promoted: boolean;
  accepted_candidates: number;
  stage1_candidates: number;
  stage2_candidates: number;
  best_result?: SweepResultEntry;
  stage1_results: SweepResultEntry[];
  stage2_results: SweepResultEntry[];
}

interface SweepResultEntry {
  candidate_config: string;
  composite_score: number;
  status: string;
  authoritative_status?: string;
  failures: string[];
  metrics: {
    heldout_body_diff?: number;
    shadow_body_diff?: number;
    java_smoke_passed?: number;
    java_smoke_skipped?: number;
    heldout_tiebreak_win_rate?: number;
    later_turn_p95_ms?: number;
    opening_move_max_ms?: number;
    [key: string]: unknown;
  };
}

export class ArenaSweepAdapter implements ExperimentAdapter {
  id = "arena-sweep";
  name = "Arena Sweep";

  private artifactsDir: string;
  private experiments: Experiment[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbacks: Array<() => void> = [];

  constructor(artifactsDir: string) {
    this.artifactsDir = artifactsDir;
  }

  async load(): Promise<Experiment[]> {
    this.experiments = this.scanArtifacts();
    return this.experiments;
  }

  getSummary(): ExperimentSummary {
    const exps = this.experiments;
    const accepted = exps.filter((e) => e.status === "accepted");
    const rejected = exps.filter((e) => e.status === "rejected");
    const screening = exps.filter((e) => e.status === "screening");
    const running = exps.filter((e) => e.status === "running");
    const best = accepted.length > 0
      ? Math.max(...accepted.map((e) => e.compositeScore ?? 0))
      : null;

    // Find sweep name from directory
    const sweepName = this.findSweepName();

    const stage1Count = exps.filter((e) => (e.metadata.stage as number) >= 1).length;
    const stage2Count = exps.filter((e) => (e.metadata.stage as number) >= 2).length;

    return {
      label: `sweep: ${sweepName}`,
      stats: [
        { key: "stg1", value: String(stage1Count) },
        { key: "stg2", value: String(stage2Count) },
        { key: "accepted", value: String(accepted.length) },
        { key: "rejected", value: String(rejected.length) },
        { key: "screening", value: String(screening.length) },
        { key: "running", value: String(running.length) },
      ],
      bestScore: best,
      totalCount: exps.length,
      activeCount: running.length + screening.length,
    };
  }

  getDetail(experimentId: string): ExperimentDetail {
    const exp = this.experiments.find((e) => e.id === experimentId);
    if (!exp) return { sections: [{ title: "Error", content: "Experiment not found" }] };

    const sections: ExperimentDetail["sections"] = [];

    // Genome info
    if (exp.metadata.genome_hash) {
      sections.push({
        title: "Genome",
        content: `hash: ${exp.metadata.genome_hash}\nkind: ${exp.metadata.kind ?? "unknown"}`,
      });
    }

    // Metrics breakdown
    const metricLines = Object.entries(exp.metrics)
      .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(4) : v}`)
      .join("\n");
    if (metricLines) {
      sections.push({ title: "Metrics", content: metricLines });
    }

    // Stage results
    if (exp.metadata.stageResults) {
      const results = exp.metadata.stageResults as Record<string, unknown>;
      sections.push({
        title: "Stage Results",
        content: JSON.stringify(results, null, 2),
      });
    }

    return { sections };
  }

  getColumns(width: number): ColumnDef[] {
    const nameWidth = Math.max(20, width - 60);
    return [
      { key: "id", label: "CANDIDATE", width: nameWidth, align: "left" },
      { key: "stage", label: "STG", width: 4, align: "right" },
      { key: "status", label: "STATUS", width: 10, align: "left" },
      {
        key: "compositeScore",
        label: "SCORE",
        width: 7,
        align: "right",
        format: (v) => v !== null && v !== undefined ? (v as number).toFixed(2) : "-.--",
      },
      {
        key: "heldout_body_diff",
        label: "BODY",
        width: 7,
        align: "right",
        format: (v) => v !== null && v !== undefined ? ((v as number) >= 0 ? "+" : "") + (v as number).toFixed(1) : "-.--",
        color: (v) => v !== null && v !== undefined ? ((v as number) > 0 ? "green" : "red") : "gray",
      },
      {
        key: "shadow_body_diff",
        label: "SHADOW",
        width: 7,
        align: "right",
        format: (v) => v !== null && v !== undefined ? ((v as number) >= 0 ? "+" : "") + (v as number).toFixed(1) : "-.--",
      },
      {
        key: "java_smoke_passed",
        label: "SMOKE",
        width: 6,
        align: "center",
        format: (v) => v === 1 || v === 1.0 ? "\u2713" : v === 0 || v === 0.0 ? "\u2717" : "\u256C",
      },
      {
        key: "elapsed",
        label: "TIME",
        width: 6,
        align: "right",
        format: (v) => {
          if (v === null || v === undefined) return "\u2014";
          const ms = v as number;
          const m = Math.floor(ms / 60000);
          return m > 0 ? `${m}m` : `${Math.floor(ms / 1000)}s`;
        },
      },
    ];
  }

  getActions(): OperatorAction[] {
    return [
      {
        name: "rerun",
        label: "Rerun stage",
        buildExec: (exp) => ({
          argv: ["python", "-m", "train.sweep", "--stage", String(exp.metadata.stage ?? 1)],
          cwd: (exp.metadata.artifactsDir as string) ?? this.artifactsDir,
        }),
      },
      {
        name: "promote",
        label: "Promote winner",
        confirmRequired: true,
        buildExec: (exp) => ({
          argv: ["python", "-m", "train.sweep", "--promote", exp.id],
          cwd: (exp.metadata.artifactsDir as string) ?? this.artifactsDir,
        }),
      },
    ];
  }

  getLineage(): LineageInfo[] {
    // Index experiments by ID for O(1) parent chain lookups
    const byId = new Map(this.experiments.map((e) => [e.id, e]));

    return this.experiments.map((exp) => {
      const parentRef = (exp.metadata.source_name ?? exp.metadata.source) as string | undefined;
      const primaryParentId = parentRef && parentRef !== exp.id && byId.has(parentRef)
        ? parentRef
        : undefined;

      // Walk parent chain to compute generation depth
      let generation = 0;
      let cur = primaryParentId;
      while (cur) {
        generation++;
        const parent = byId.get(cur);
        const nextRef = (parent?.metadata.source_name ?? parent?.metadata.source) as string | undefined;
        if (!nextRef || nextRef === cur || !byId.has(nextRef)) break;
        cur = nextRef;
      }

      const notes = exp.metadata.notes as string | undefined;
      return {
        experimentId: exp.id,
        primaryParentId,
        familyId: parentRef ?? exp.id,
        generation,
        branchLabel: notes ? notes.slice(0, 50) : undefined,
      };
    });
  }

  startPolling(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      const prev = this.experiments;
      await this.load();
      if (JSON.stringify(prev) !== JSON.stringify(this.experiments)) {
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

  private static readGenomeMeta(dir: string): { source_name?: string; source?: string; notes?: string } {
    try {
      const genomePath = join(dir, "genome.json");
      if (!existsSync(genomePath)) return {};
      const genome = JSON.parse(readFileSync(genomePath, "utf-8")) as Record<string, unknown>;
      const meta = (genome.metadata ?? genome) as Record<string, unknown>;
      return {
        source_name: typeof meta.source_name === "string" ? meta.source_name : undefined,
        source: typeof meta.source === "string" ? meta.source : undefined,
        notes: typeof meta.notes === "string" ? meta.notes : undefined,
      };
    } catch { return {}; }
  }

  private static resolveStatus(
    arenaStatus: string,
    stageNum: number,
  ): { status: string; statusColor: Experiment["statusColor"] } {
    if (arenaStatus === "accepted" || arenaStatus === "promoted") {
      return { status: "accepted", statusColor: "success" };
    }
    if (arenaStatus === "rejected") {
      return { status: "rejected", statusColor: "error" };
    }
    if (arenaStatus === "running" || arenaStatus === "ready") {
      return { status: "running", statusColor: "primary" };
    }
    if (arenaStatus === "screening" || stageNum <= 1) {
      return { status: "screening", statusColor: "dim" };
    }
    return { status: arenaStatus, statusColor: "dim" };
  }

  private findSweepName(): string {
    try {
      const sweepsDir = join(this.artifactsDir, "search_sweeps");
      if (existsSync(sweepsDir)) {
        const entries = readdirSync(sweepsDir);
        if (entries.length > 0) {
          // Return the most recent sweep
          return entries.sort().reverse()[0];
        }
      }
    } catch { /* ignore */ }
    return basename(this.artifactsDir);
  }

  private scanArtifacts(): Experiment[] {
    const experiments: Experiment[] = [];

    // Strategy 1: Look for summary.json (sweep_search.py format)
    const summaries = this.findSummaries();
    for (const summaryPath of summaries) {
      try {
        const summary: SweepSummary = JSON.parse(readFileSync(summaryPath, "utf-8"));
        experiments.push(...this.summaryToExperiments(summary));
      } catch { /* skip bad summaries */ }
    }

    // Strategy 2: Look for run manifests (registry.py format)
    if (experiments.length === 0) {
      const manifests = this.findManifests();
      for (const manifestPath of manifests) {
        try {
          const manifest: RunManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          for (const [, candidateInfo] of Object.entries(manifest.candidates ?? {})) {
            const exp = this.candidateToExperiment(candidateInfo, manifest);
            if (exp) experiments.push(exp);
          }
        } catch { /* skip bad manifests */ }
      }
    }

    // Strategy 3: If nothing found, scan for candidate directories directly
    if (experiments.length === 0) {
      const candidates = this.scanCandidateDirs();
      experiments.push(...candidates);
    }

    // Sort by composite score descending (nulls last)
    experiments.sort((a, b) => {
      if (a.compositeScore === null && b.compositeScore === null) return 0;
      if (a.compositeScore === null) return 1;
      if (b.compositeScore === null) return -1;
      return b.compositeScore - a.compositeScore;
    });

    return experiments;
  }

  private findSummaries(): string[] {
    const summaries: string[] = [];

    const sweepsDir = join(this.artifactsDir, "search_sweeps");
    if (existsSync(sweepsDir)) {
      try {
        for (const sweep of readdirSync(sweepsDir)) {
          const sweepDir = join(sweepsDir, sweep);
          if (!statSync(sweepDir).isDirectory()) continue;
          const summaryPath = join(sweepDir, "summary.json");
          if (existsSync(summaryPath)) summaries.push(summaryPath);
        }
      } catch { /* skip */ }
    }

    // Check direct summary.json in artifacts dir
    const directSummary = join(this.artifactsDir, "summary.json");
    if (existsSync(directSummary)) summaries.push(directSummary);

    return summaries;
  }

  private summaryToExperiments(summary: SweepSummary): Experiment[] {
    const experiments: Experiment[] = [];

    const processEntry = (entry: SweepResultEntry, stage: number): Experiment => {
      const finalStatus = entry.authoritative_status ?? entry.status;
      const { status, statusColor } = ArenaSweepAdapter.resolveStatus(finalStatus, stage);

      const metrics: Record<string, number> = {};
      if (entry.metrics) {
        for (const [k, v] of Object.entries(entry.metrics)) {
          if (typeof v === "number") metrics[k] = v;
        }
      }

      return {
        id: entry.candidate_config,
        status,
        statusColor,
        compositeScore: entry.composite_score ?? null,
        metrics,
        description: entry.candidate_config,
        metadata: {
          stage,
          artifactsDir: this.artifactsDir,
          runName: summary.run_name,
          promotable: summary.promoted,
          failures: entry.failures,
          heldout_body_diff: entry.metrics?.heldout_body_diff,
          shadow_body_diff: entry.metrics?.shadow_body_diff,
          java_smoke_passed: entry.metrics?.java_smoke_passed,
        },
      };
    };

    // Stage 2 results take priority — collect their IDs to avoid duplicates
    const stage2Ids = new Set<string>();
    for (const entry of summary.stage2_results ?? []) {
      stage2Ids.add(entry.candidate_config);
      experiments.push(processEntry(entry, 2));
    }

    // Stage 1 results — only if not already in stage 2
    for (const entry of summary.stage1_results ?? []) {
      if (!stage2Ids.has(entry.candidate_config)) {
        experiments.push(processEntry(entry, 1));
      }
    }

    return experiments;
  }

  private findManifests(): string[] {
    const manifests: string[] = [];

    // Check search_sweeps/<name>/run_manifest.json
    const sweepsDir = join(this.artifactsDir, "search_sweeps");
    if (existsSync(sweepsDir)) {
      try {
        for (const sweep of readdirSync(sweepsDir)) {
          const sweepDir = join(sweepsDir, sweep);
          if (!statSync(sweepDir).isDirectory()) continue;

          // Look for run manifests within each sweep
          try {
            for (const entry of readdirSync(sweepDir)) {
              const entryPath = join(sweepDir, entry);
              if (entry === "run_manifest.json" || entry === "manifest.json") {
                manifests.push(entryPath);
              } else if (statSync(entryPath).isDirectory()) {
                // Run directories inside sweep
                const runManifest = join(entryPath, "run_manifest.json");
                if (existsSync(runManifest)) manifests.push(runManifest);
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    // Check direct run_manifest.json in artifacts dir
    const directManifest = join(this.artifactsDir, "run_manifest.json");
    if (existsSync(directManifest)) manifests.push(directManifest);

    // Check outerloop run directories
    const outerloopDir = join(this.artifactsDir, "outerloop");
    if (existsSync(outerloopDir)) {
      try {
        for (const runDir of readdirSync(outerloopDir)) {
          const manifest = join(outerloopDir, runDir, "run_manifest.json");
          if (existsSync(manifest)) manifests.push(manifest);
        }
      } catch { /* skip */ }
    }

    return manifests;
  }

  private candidateToExperiment(
    candidateInfo: RunManifest["candidates"][string],
    manifest: RunManifest,
  ): Experiment | null {
    const id = candidateInfo.candidate_id;

    // Load highest available stage result
    let highestStage = 0;
    let latestResult: CandidateResult | null = null;

    for (const [stageName, stagePath] of Object.entries(candidateInfo.stages ?? {})) {
      try {
        const result: CandidateResult = JSON.parse(readFileSync(stagePath, "utf-8"));
        const stageNum = parseInt(stageName.replace("stage", ""), 10) || 0;
        if (stageNum >= highestStage) {
          highestStage = stageNum;
          latestResult = result;
        }
      } catch { /* skip */ }
    }

    if (!latestResult) return null;

    const arenaResult = latestResult.result;
    const arenaStatus = arenaResult?.status ?? latestResult.status ?? "pending";
    const { status, statusColor } = ArenaSweepAdapter.resolveStatus(arenaStatus, highestStage);

    // Extract metrics
    const metrics: Record<string, number> = {};
    if (arenaResult) {
      if (typeof arenaResult.heldout_body_diff === "number") metrics.heldout_body_diff = arenaResult.heldout_body_diff;
      if (typeof arenaResult.shadow_body_diff === "number") metrics.shadow_body_diff = arenaResult.shadow_body_diff;
      if (typeof arenaResult.java_smoke_passed === "number") metrics.java_smoke_passed = arenaResult.java_smoke_passed;
      if (typeof arenaResult.composite_score === "number") metrics.compositeScore = arenaResult.composite_score;
    }

    // Compute elapsed time
    let elapsed: number | undefined;
    if (latestResult.started_at && latestResult.finished_at) {
      elapsed = new Date(latestResult.finished_at).getTime() - new Date(latestResult.started_at).getTime();
    }

    // Read genome.json for lineage metadata
    const candidateDir = latestResult.candidate_dir;
    const genomeMeta = candidateDir ? ArenaSweepAdapter.readGenomeMeta(candidateDir) : {};

    return {
      id,
      status,
      statusColor,
      compositeScore: arenaResult?.composite_score ?? null,
      metrics,
      description: id,
      startedAt: latestResult.started_at ? new Date(latestResult.started_at).getTime() : undefined,
      finishedAt: latestResult.finished_at ? new Date(latestResult.finished_at).getTime() : undefined,
      metadata: {
        stage: highestStage,
        genome_hash: candidateInfo.genome_hash ?? latestResult.genome_hash,
        kind: candidateInfo.kind,
        artifactsDir: this.artifactsDir,
        runId: manifest.run_id,
        candidateDir,
        promotable: latestResult.promotable,
        stageResults: latestResult.result,
        elapsed,
        heldout_body_diff: arenaResult?.heldout_body_diff,
        shadow_body_diff: arenaResult?.shadow_body_diff,
        java_smoke_passed: arenaResult?.java_smoke_passed,
        source_name: genomeMeta.source_name,
        source: genomeMeta.source,
        notes: genomeMeta.notes,
      },
    };
  }

  private scanCandidateDirs(): Experiment[] {
    // Fallback: scan for directories that look like candidate dirs
    const experiments: Experiment[] = [];

    const scanDir = (dir: string) => {
      try {
        for (const entry of readdirSync(dir)) {
          const entryPath = join(dir, entry);
          if (!statSync(entryPath).isDirectory()) continue;

          // Look for stage result files
          for (const stageFile of ["stage2.json", "stage1.json", "stage0.json"]) {
            const stagePath = join(entryPath, stageFile);
            if (existsSync(stagePath)) {
              try {
                const result: CandidateResult = JSON.parse(readFileSync(stagePath, "utf-8"));
                const stageNum = parseInt(stageFile.replace("stage", "").replace(".json", ""), 10);
                const arenaResult = result.result;
                const arenaStatus = arenaResult?.status ?? result.status ?? "pending";
                const { status, statusColor } = ArenaSweepAdapter.resolveStatus(arenaStatus, stageNum);

                const metrics: Record<string, number> = {};
                if (arenaResult) {
                  if (typeof arenaResult.heldout_body_diff === "number") metrics.heldout_body_diff = arenaResult.heldout_body_diff;
                  if (typeof arenaResult.shadow_body_diff === "number") metrics.shadow_body_diff = arenaResult.shadow_body_diff;
                  if (typeof arenaResult.java_smoke_passed === "number") metrics.java_smoke_passed = arenaResult.java_smoke_passed;
                }

                const genomeMeta = ArenaSweepAdapter.readGenomeMeta(entryPath);
                experiments.push({
                  id: result.candidate_id ?? entry,
                  status,
                  statusColor,
                  compositeScore: arenaResult?.composite_score ?? null,
                  metrics,
                  description: result.candidate_id ?? entry,
                  startedAt: result.started_at ? new Date(result.started_at).getTime() : undefined,
                  finishedAt: result.finished_at ? new Date(result.finished_at).getTime() : undefined,
                  metadata: {
                    stage: stageNum,
                    genome_hash: result.genome_hash,
                    artifactsDir: this.artifactsDir,
                    runId: result.run_id,
                    candidateDir: result.candidate_dir,
                    elapsed: result.started_at && result.finished_at
                      ? new Date(result.finished_at).getTime() - new Date(result.started_at).getTime()
                      : undefined,
                    source_name: genomeMeta.source_name,
                    source: genomeMeta.source,
                    notes: genomeMeta.notes,
                  },
                });
                break; // Use highest stage found
              } catch { /* skip */ }
            }
          }
        }
      } catch { /* skip */ }
    };

    // Scan the artifacts dir and search_sweeps subdirs
    scanDir(this.artifactsDir);
    const sweepsDir = join(this.artifactsDir, "search_sweeps");
    if (existsSync(sweepsDir)) {
      try {
        for (const sweep of readdirSync(sweepsDir)) {
          scanDir(join(sweepsDir, sweep));
        }
      } catch { /* skip */ }
    }

    return experiments;
  }
}
