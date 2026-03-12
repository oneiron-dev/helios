import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert";
import { test, describe, before, after } from "node:test";
import { ArenaSweepAdapter } from "../src/experiments/adapters/arena-sweep.js";

const TEST_DIR = join(tmpdir(), `helios-test-${Date.now()}`);

function setupFixture() {
  const sweepDir = join(TEST_DIR, "search_sweeps", "test_sweep_v1");
  const runDir = join(sweepDir, "run_001");
  const candidateDir = join(runDir, "candidate_abc123");

  mkdirSync(candidateDir, { recursive: true });

  // Write a run manifest
  const manifest = {
    run_id: "run_001",
    status: "running",
    program: "outerloop.prose",
    candidates: {
      candidate_abc123: {
        candidate_id: "candidate_abc123",
        genome_hash: "abc123hash",
        kind: "mutate",
        stages: {
          stage0: join(candidateDir, "stage0.json"),
          stage1: join(candidateDir, "stage1.json"),
          stage2: join(candidateDir, "stage2.json"),
        },
      },
    },
  };
  writeFileSync(join(runDir, "run_manifest.json"), JSON.stringify(manifest));

  // Stage results
  writeFileSync(
    join(candidateDir, "stage0.json"),
    JSON.stringify({
      run_id: "run_001",
      candidate_id: "candidate_abc123",
      stage: "stage0",
      status: "ready",
      started_at: "2026-03-12T10:00:00Z",
      finished_at: "2026-03-12T10:01:00Z",
      genome_hash: "abc123hash",
    }),
  );

  writeFileSync(
    join(candidateDir, "stage1.json"),
    JSON.stringify({
      run_id: "run_001",
      candidate_id: "candidate_abc123",
      stage: "stage1",
      status: "screening",
      started_at: "2026-03-12T10:01:00Z",
      finished_at: "2026-03-12T10:05:00Z",
      genome_hash: "abc123hash",
      result: { status: "screening" },
    }),
  );

  writeFileSync(
    join(candidateDir, "stage2.json"),
    JSON.stringify({
      run_id: "run_001",
      candidate_id: "candidate_abc123",
      stage: "stage2",
      status: "accepted",
      started_at: "2026-03-12T10:05:00Z",
      finished_at: "2026-03-12T10:15:00Z",
      genome_hash: "abc123hash",
      promotable: true,
      result: {
        status: "accepted",
        composite_score: 1.85,
        heldout_body_diff: 4.2,
        shadow_body_diff: 1.8,
        java_smoke_passed: 1.0,
      },
    }),
  );
}

describe("ArenaSweepAdapter", () => {
  before(() => setupFixture());
  after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  test("loads experiments from fixture artifacts", async () => {
    const adapter = new ArenaSweepAdapter(TEST_DIR);
    const experiments = await adapter.load();

    assert.ok(experiments.length > 0, "should find at least one experiment");

    const exp = experiments[0];
    assert.strictEqual(exp.id, "candidate_abc123");
    assert.strictEqual(exp.status, "accepted");
    assert.strictEqual(exp.statusColor, "success");
    assert.strictEqual(exp.compositeScore, 1.85);
    assert.strictEqual(exp.metadata.stage, 2);
    assert.strictEqual(exp.metadata.promotable, true);
  });

  test("returns correct column definitions", () => {
    const adapter = new ArenaSweepAdapter(TEST_DIR);
    const columns = adapter.getColumns(120);

    assert.ok(columns.length > 0, "should have columns");
    const labels = columns.map((c) => c.label);
    assert.ok(labels.includes("CANDIDATE"), "should have CANDIDATE column");
    assert.ok(labels.includes("STATUS"), "should have STATUS column");
    assert.ok(labels.includes("SCORE"), "should have SCORE column");
    assert.ok(labels.includes("BODY"), "should have BODY column");
  });

  test("returns correct summary", async () => {
    const adapter = new ArenaSweepAdapter(TEST_DIR);
    await adapter.load();
    const summary = adapter.getSummary();

    assert.ok(summary.label.length > 0, "should have a label");
    assert.strictEqual(summary.totalCount, 1);
    assert.strictEqual(summary.bestScore, 1.85);
  });

  test("returns actions with buildExec", () => {
    const adapter = new ArenaSweepAdapter(TEST_DIR);
    const actions = adapter.getActions();

    assert.ok(actions.length >= 2, "should have rerun and promote actions");

    const rerun = actions.find((a) => a.name === "rerun");
    assert.ok(rerun, "should have rerun action");

    const promote = actions.find((a) => a.name === "promote");
    assert.ok(promote, "should have promote action");
    assert.strictEqual(promote.confirmRequired, true);
  });

  test("handles empty artifacts directory", async () => {
    const emptyDir = join(TEST_DIR, "empty");
    mkdirSync(emptyDir, { recursive: true });

    const adapter = new ArenaSweepAdapter(emptyDir);
    const experiments = await adapter.load();
    assert.strictEqual(experiments.length, 0);

    const summary = adapter.getSummary();
    assert.strictEqual(summary.totalCount, 0);
    assert.strictEqual(summary.bestScore, null);
  });

  test("removes update listeners on unsubscribe", () => {
    const adapter = new ArenaSweepAdapter(TEST_DIR);
    const unsubscribe = adapter.onUpdate(() => {});

    assert.strictEqual((adapter as any).callbacks.length, 1);

    unsubscribe();

    assert.strictEqual((adapter as any).callbacks.length, 0);
  });
});
