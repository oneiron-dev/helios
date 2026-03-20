import { G } from "../ui/theme.js";
import type { Experiment, LineageInfo } from "./types.js";

// ─── Types ───────────────────────────────────────────

export interface TreeNode {
  experiment: Experiment;
  children: TreeNode[];
}

export interface FlatTreeRow {
  experiment: Experiment;
  depth: number;
  connectors: string;
  isRoot: boolean;
}

// ─── Tree Building ───────────────────────────────────

/** Compare tree nodes by compositeScore descending, nulls last. */
function compareByScore(a: TreeNode, b: TreeNode): number {
  const sa = a.experiment.compositeScore;
  const sb = b.experiment.compositeScore;
  if (sa === null && sb === null) return 0;
  if (sa === null) return 1;
  if (sb === null) return -1;
  return sb - sa;
}

/** Recursively sort a node's children (and their children) by score. */
function sortDescendants(node: TreeNode): void {
  node.children.sort(compareByScore);
  for (const child of node.children) sortDescendants(child);
}

/** Merge lineage info onto experiment copies (does not mutate originals). */
function applyLineage(experiments: Experiment[], lineage: LineageInfo[]): Experiment[] {
  const map = new Map(lineage.map((l) => [l.experimentId, l]));
  return experiments.map((exp) => {
    const info = map.get(exp.id);
    if (!info) return exp;
    return {
      ...exp,
      primaryParentId: info.primaryParentId ?? exp.primaryParentId,
      parentIds: info.parentIds ?? exp.parentIds,
      familyId: info.familyId ?? exp.familyId,
      generation: info.generation ?? exp.generation,
      branchLabel: info.branchLabel ?? exp.branchLabel,
    };
  });
}

/**
 * Build a forest of TreeNodes from experiments and optional lineage info.
 * Roots are experiments with no resolvable parent.
 * Self-references and cycles are treated as roots.
 */
export function buildForest(experiments: Experiment[], lineage?: LineageInfo[]): TreeNode[] {
  if (experiments.length === 0) return [];

  const resolved = lineage && lineage.length > 0
    ? applyLineage(experiments, lineage)
    : experiments;

  // Build node map
  const nodeMap = new Map<string, TreeNode>();
  for (const exp of resolved) {
    nodeMap.set(exp.id, { experiment: exp, children: [] });
  }

  // Wire children via primaryParentId (fall back to parentId)
  // Guard against self-references; cycles are broken by treating them as roots
  const roots: TreeNode[] = [];
  for (const node of nodeMap.values()) {
    const parentId = node.experiment.primaryParentId ?? node.experiment.parentId;
    const parent = parentId && parentId !== node.experiment.id
      ? nodeMap.get(parentId)
      : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  roots.sort(compareByScore);
  for (const root of roots) sortDescendants(root);

  return roots;
}

// ─── Flattening ──────────────────────────────────────

/**
 * Flatten a forest into rows with pre-computed connector strings for rendering.
 * Uses a visited set to protect against cycles.
 */
export function flattenForest(roots: TreeNode[]): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  const visited = new Set<string>();

  function walk(node: TreeNode, depth: number, ancestorHasMore: boolean[]): void {
    if (visited.has(node.experiment.id)) return;
    visited.add(node.experiment.id);

    rows.push({
      experiment: node.experiment,
      depth,
      connectors: computeConnectors(depth, ancestorHasMore),
      isRoot: depth === 0,
    });

    for (let i = 0; i < node.children.length; i++) {
      const hasMoreSiblings = i < node.children.length - 1;
      walk(node.children[i], depth + 1, [...ancestorHasMore, hasMoreSiblings]);
    }
  }

  for (const root of roots) {
    walk(root, 0, []);
  }

  return rows;
}

/**
 * Compute box-drawing connector prefix for a tree row.
 *
 * `ancestorHasMore[i]` is true when the ancestor at depth `i` has more
 * siblings below the current path, so a vertical pipe should continue.
 * The last entry describes the current node itself.
 */
export function computeConnectors(depth: number, ancestorHasMore: boolean[]): string {
  if (depth === 0) return "";

  let prefix = "";
  // Ancestor continuation lines (all levels except the current)
  for (let i = 0; i < ancestorHasMore.length - 1; i++) {
    prefix += ancestorHasMore[i] ? `${G.pipe} ` : "  ";
  }

  // Current node connector: last child gets └, others get ├
  const isLastChild = !ancestorHasMore[ancestorHasMore.length - 1];
  prefix += isLastChild ? `${G.branchEnd} ` : `${G.branch} `;

  return prefix;
}
