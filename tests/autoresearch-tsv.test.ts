import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutoresearchTsvAdapter } from "../src/experiments/adapters/autoresearch-tsv.js";

const TEST_DIR = join(tmpdir(), `helios-autoresearch-test-${Date.now()}`);
const RESEARCH_DIR = join(TEST_DIR, "research");

// 5 rows: 3 KEEP, 2 REVERT. Row 4 intentionally fails gates.
const FIXTURE_TSV = [
  "commit\tstatus\tcomposite\tmacro_f1\tmicro_f1\trel_ref_f05\trel_ref_precision\trel_hard_neg_prec\tmultilingual_f1\tlatency_bonus\ttokens_seen\tsteps\tpeak_vram_mb\tdescription",
  "abc1234\tKEEP\t0.5200\t0.55\t0.60\t0.48\t0.42\t0.62\t0.38\t0.90\t1250000\t5000\t1200\tBaseline NER model",
  "def5678\tKEEP\t0.5800\t0.61\t0.65\t0.52\t0.45\t0.68\t0.41\t0.92\t2500000\t10000\t1100\tAdd entity embeddings",
  "ghi9012\tREVERT\t0.4100\t0.42\t0.44\t0.35\t0.31\t0.50\t0.30\t0.85\t3000000\t12000\t1300\tBad learning rate",
  "jkl3456\tREVERT\t0.3000\t0.28\t0.30\t0.25\t0.20\t0.40\t0.22\t0.70\t3500000\t14000\t1600\tFails all gates",
  "mno7890\tKEEP\t0.6100\t0.65\t0.68\t0.55\t0.50\t0.72\t0.45\t0.95\t4000000\t16000\t1050\tFinal tuned model",
].join("\n");

function setupFixture() {
  mkdirSync(RESEARCH_DIR, { recursive: true });
  writeFileSync(join(RESEARCH_DIR, "results.tsv"), FIXTURE_TSV);
  writeFileSync(join(RESEARCH_DIR, "autoresearch.prose"), "# placeholder");
}

describe("AutoresearchTsvAdapter", () => {
  beforeAll(() => setupFixture());
  afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("load() returns correct count and field mapping", async () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    const exps = await adapter.load();

    expect(exps.length).toBe(5);
    expect(exps[0].id).toBe("abc1234");
    expect(exps[0].status).toBe("keep");
    expect(exps[0].statusColor).toBe("success");
    expect(exps[0].compositeScore).toBe(0.52);
    expect(exps[0].description).toBe("Baseline NER model");
    expect(exps[0].metrics.macro_f1).toBe(0.55);

    expect(exps[3].status).toBe("revert");
    expect(exps[3].statusColor).toBe("error");
  });

  it("load() builds parentId chain", async () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    const exps = await adapter.load();

    expect(exps[0].parentId).toBeUndefined();
    expect(exps[1].parentId).toBe("abc1234");
    expect(exps[2].parentId).toBe("def5678");
    expect(exps[3].parentId).toBe("ghi9012");
    expect(exps[4].parentId).toBe("jkl3456");
  });

  it("load() computes gate status correctly", async () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    const exps = await adapter.load();

    // Row 0 (abc1234): all gates pass
    expect(exps[0].metadata.gatesPassed).toBe(true);
    expect((exps[0].metadata.gateFailures as string[]).length).toBe(0);

    // Row 3 (jkl3456): fails all gates (low F1, low precision, high VRAM)
    expect(exps[3].metadata.gatesPassed).toBe(false);
    const failures = exps[3].metadata.gateFailures as string[];
    expect(failures.length).toBe(3);
  });

  it("getSummary() returns correct counts and bestScore", async () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    await adapter.load();
    const summary = adapter.getSummary();

    expect(summary.label).toBe("autoresearch: NER");
    expect(summary.totalCount).toBe(5);
    expect(summary.activeCount).toBe(0);

    const statMap = Object.fromEntries(summary.stats.map((s) => [s.key, s.value]));
    expect(statMap.keep).toBe("3");
    expect(statMap.revert).toBe("2");
    expect(summary.bestScore).toBe(0.61);
  });

  it("getColumns() returns expected column keys", () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    const cols = adapter.getColumns(120);

    const keys = cols.map((c) => c.key);
    expect(keys).toContain("id");
    expect(keys).toContain("status");
    expect(keys).toContain("compositeScore");
    expect(keys).toContain("macro_f1");
    expect(keys).toContain("tokens_seen");
    expect(keys).toContain("peak_vram_mb");
  });

  it("getColumns() drops TOKENS and VRAM when narrow", () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    const cols = adapter.getColumns(60);

    const keys = cols.map((c) => c.key);
    expect(keys).not.toContain("tokens_seen");
    expect(keys).not.toContain("peak_vram_mb");
  });

  it("getDetail() includes composite breakdown section", async () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    await adapter.load();
    const detail = adapter.getDetail("abc1234");

    const titles = detail.sections.map((s) => s.title);
    expect(titles).toContain("Composite Breakdown");
    expect(titles).toContain("Gate Status");
    expect(titles).toContain("Training Stats");
  });

  it("getDetail() shows gate failures for failing experiment", async () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    await adapter.load();
    const detail = adapter.getDetail("jkl3456");

    const gateSection = detail.sections.find((s) => s.title === "Gate Status");
    expect(gateSection).toBeDefined();
    expect(gateSection!.content).toContain("✗");
  });

  it("getLineage() returns linear chain with correct generations", async () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    await adapter.load();
    const lineage = adapter.getLineage();

    expect(lineage.length).toBe(5);
    expect(lineage[0].parentIds).toBeUndefined();
    expect(lineage[0].generation).toBe(0);
    expect(lineage[0].experimentId).toBe("abc1234");
    expect(lineage[1].primaryParentId).toBe("abc1234");
    expect(lineage[1].generation).toBe(1);
    expect(lineage[4].generation).toBe(4);
    expect(lineage[0].familyId).toBe("autoresearch");
  });

  it("getActions() returns 2 actions with rerun requiring confirmation", () => {
    const adapter = new AutoresearchTsvAdapter(TEST_DIR);
    const actions = adapter.getActions();

    expect(actions.length).toBe(2);
    const rerun = actions.find((a) => a.name === "rerun-from-point");
    expect(rerun).toBeDefined();
    expect(rerun!.confirmRequired).toBe(true);

    const diff = actions.find((a) => a.name === "view-config-diff");
    expect(diff).toBeDefined();
    expect(diff!.confirmRequired).toBeUndefined();
  });

  it("handles empty TSV (header only) with 0 experiments", async () => {
    const emptyDir = join(TEST_DIR, "empty-research");
    mkdirSync(join(emptyDir, "research"), { recursive: true });
    writeFileSync(
      join(emptyDir, "research", "results.tsv"),
      "commit\tstatus\tcomposite\n",
    );

    const adapter = new AutoresearchTsvAdapter(emptyDir);
    const exps = await adapter.load();
    expect(exps.length).toBe(0);
  });

  it("handles missing file without throwing", async () => {
    const missingDir = join(TEST_DIR, "nonexistent");
    mkdirSync(missingDir, { recursive: true });

    const adapter = new AutoresearchTsvAdapter(missingDir);
    const exps = await adapter.load();
    expect(exps.length).toBe(0);
  });
});
