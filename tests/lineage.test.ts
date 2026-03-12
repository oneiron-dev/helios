import { describe, it, expect } from "bun:test";
import { buildForest, flattenForest, computeConnectors } from "../src/experiments/lineage.js";
import type { Experiment, LineageInfo } from "../src/experiments/types.js";

function makeExp(overrides: Partial<Experiment> & { id: string }): Experiment {
  return {
    status: "accepted",
    statusColor: "success",
    compositeScore: null,
    metrics: {},
    description: overrides.id,
    metadata: {},
    ...overrides,
  };
}

describe("buildForest", () => {
  it("returns empty array for no experiments", () => {
    expect(buildForest([])).toEqual([]);
  });

  it("puts all experiments as roots when no parent links", () => {
    const exps = [makeExp({ id: "a" }), makeExp({ id: "b" })];
    const roots = buildForest(exps);
    expect(roots).toHaveLength(2);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  it("wires children via primaryParentId", () => {
    const exps = [
      makeExp({ id: "root", compositeScore: 2 }),
      makeExp({ id: "child1", primaryParentId: "root", compositeScore: 1.5 }),
      makeExp({ id: "child2", primaryParentId: "root", compositeScore: 1.0 }),
    ];
    const roots = buildForest(exps);
    expect(roots).toHaveLength(1);
    expect(roots[0].experiment.id).toBe("root");
    expect(roots[0].children).toHaveLength(2);
    expect(roots[0].children[0].experiment.id).toBe("child1");
    expect(roots[0].children[1].experiment.id).toBe("child2");
  });

  it("falls back to parentId when primaryParentId is absent", () => {
    const exps = [
      makeExp({ id: "root" }),
      makeExp({ id: "child", parentId: "root" }),
    ];
    const roots = buildForest(exps);
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].experiment.id).toBe("child");
  });

  it("treats unresolvable parent as root (orphan)", () => {
    const exps = [
      makeExp({ id: "orphan", primaryParentId: "nonexistent" }),
      makeExp({ id: "root" }),
    ];
    const roots = buildForest(exps);
    expect(roots).toHaveLength(2);
  });

  it("merges LineageInfo onto experiments", () => {
    const exps = [
      makeExp({ id: "root", compositeScore: 2 }),
      makeExp({ id: "child", compositeScore: 1 }),
    ];
    const lineage: LineageInfo[] = [
      { experimentId: "root", generation: 0, familyId: "fam1" },
      { experimentId: "child", primaryParentId: "root", generation: 1, familyId: "fam1", branchLabel: "test branch" },
    ];
    const roots = buildForest(exps, lineage);
    expect(roots).toHaveLength(1);
    expect(roots[0].experiment.id).toBe("root");
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].experiment.branchLabel).toBe("test branch");
    expect(roots[0].children[0].experiment.familyId).toBe("fam1");
  });

  it("sorts roots by compositeScore desc", () => {
    const exps = [
      makeExp({ id: "low", compositeScore: 1 }),
      makeExp({ id: "high", compositeScore: 3 }),
      makeExp({ id: "mid", compositeScore: 2 }),
    ];
    const roots = buildForest(exps);
    expect(roots.map((r) => r.experiment.id)).toEqual(["high", "mid", "low"]);
  });

  it("sorts children by compositeScore desc", () => {
    const exps = [
      makeExp({ id: "root", compositeScore: 5 }),
      makeExp({ id: "c1", primaryParentId: "root", compositeScore: 1 }),
      makeExp({ id: "c2", primaryParentId: "root", compositeScore: 3 }),
      makeExp({ id: "c3", primaryParentId: "root", compositeScore: 2 }),
    ];
    const roots = buildForest(exps);
    expect(roots[0].children.map((c) => c.experiment.id)).toEqual(["c2", "c3", "c1"]);
  });

  it("handles single root with no children", () => {
    const exps = [makeExp({ id: "solo", compositeScore: 1 })];
    const roots = buildForest(exps);
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(0);
    expect(roots[0].experiment.id).toBe("solo");
  });

  it("null scores sort after non-null", () => {
    const exps = [
      makeExp({ id: "scored", compositeScore: 1 }),
      makeExp({ id: "unscored", compositeScore: null }),
    ];
    const roots = buildForest(exps);
    expect(roots[0].experiment.id).toBe("scored");
    expect(roots[1].experiment.id).toBe("unscored");
  });
});

describe("flattenForest", () => {
  it("returns empty for empty roots", () => {
    expect(flattenForest([])).toEqual([]);
  });

  it("produces DFS order", () => {
    const exps = [
      makeExp({ id: "root", compositeScore: 5 }),
      makeExp({ id: "child", primaryParentId: "root", compositeScore: 3 }),
      makeExp({ id: "grandchild", primaryParentId: "child", compositeScore: 1 }),
    ];
    const roots = buildForest(exps);
    const rows = flattenForest(roots);
    expect(rows.map((r) => r.experiment.id)).toEqual(["root", "child", "grandchild"]);
  });

  it("marks roots correctly", () => {
    const exps = [
      makeExp({ id: "r1" }),
      makeExp({ id: "c1", primaryParentId: "r1" }),
      makeExp({ id: "r2" }),
    ];
    const roots = buildForest(exps);
    const rows = flattenForest(roots);
    expect(rows[0].isRoot).toBe(true);
    expect(rows[1].isRoot).toBe(false);
    expect(rows[2].isRoot).toBe(true);
  });

  it("sets correct depths", () => {
    const exps = [
      makeExp({ id: "root" }),
      makeExp({ id: "child", primaryParentId: "root" }),
      makeExp({ id: "grandchild", primaryParentId: "child" }),
    ];
    const roots = buildForest(exps);
    const rows = flattenForest(roots);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });
});

describe("computeConnectors", () => {
  it("returns empty for depth 0", () => {
    expect(computeConnectors(0, [])).toBe("");
  });

  it("uses branchEnd for last child at depth 1", () => {
    const result = computeConnectors(1, [false]);
    expect(result).toContain("└");
  });

  it("uses branch for non-last child at depth 1", () => {
    const result = computeConnectors(1, [true]);
    expect(result).toContain("├");
  });

  it("uses pipe prefix for depth 2+ with ancestor continuation", () => {
    // ancestorHasMore: [true (level 0 has more siblings), false (current is last)]
    const result = computeConnectors(2, [true, false]);
    expect(result).toContain("│");
    expect(result).toContain("└");
  });

  it("uses spaces for depth 2+ without ancestor continuation", () => {
    const result = computeConnectors(2, [false, false]);
    expect(result.startsWith("  ")).toBe(true);
    expect(result).toContain("└");
  });
});

describe("integration: buildForest + flattenForest", () => {
  it("produces correct tree visualization structure", () => {
    const exps = [
      makeExp({ id: "baseline", compositeScore: 1 }),
      makeExp({ id: "search-a", primaryParentId: "baseline", compositeScore: 1.85 }),
      makeExp({ id: "search-b", primaryParentId: "baseline", compositeScore: 0.92 }),
      makeExp({ id: "hybrid-c", primaryParentId: "search-b", compositeScore: null }),
      makeExp({ id: "search-d", primaryParentId: "baseline", compositeScore: 1.65 }),
    ];
    const roots = buildForest(exps);
    const rows = flattenForest(roots);

    // Root
    expect(rows[0].experiment.id).toBe("baseline");
    expect(rows[0].connectors).toBe("");

    // Children sorted by score: search-a (1.85), search-d (1.65), search-b (0.92)
    expect(rows[1].experiment.id).toBe("search-a");
    expect(rows[2].experiment.id).toBe("search-d");
    expect(rows[3].experiment.id).toBe("search-b");

    // Grandchild
    expect(rows[4].experiment.id).toBe("hybrid-c");
    expect(rows[4].depth).toBe(2);

    // Non-last children should use ├, last should use └
    expect(rows[1].connectors).toContain("├");
    expect(rows[3].connectors).toContain("└");
  });
});
