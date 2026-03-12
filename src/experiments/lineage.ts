import { G } from "../ui/theme.js";
import type { Experiment, LineageInfo } from "./types.js";

// ─── Types ───────────────────────────────────────────

export interface TreeNode {
  experiment: Experiment;
  children: TreeNode[];
  depth: number;
}

export interface FlatTreeRow {
  experiment: Experiment;
  depth: number;
  connectors: string;
  isRoot: boolean;
}

// ─── Tree Building ───────────────────────────────────

/**
 * Build a forest of TreeNodes from experiments and optional lineage info.
 * Roots are experiments with no resolvable parent.
 */
export function buildForest(experiments: Experiment[], lineage?: LineageInfo[]): TreeNode[] {
  if (experiments.length === 0) return [];

  // Merge lineage info onto experiments if provided
  if (lineage && lineage.length > 0) {
    const lineageMap = new Map(lineage.map((l) => [l.experimentId, l]));
    for (const exp of experiments) {
      const info = lineageMap.get(exp.id);
      if (!info) continue;
      if (info.primaryParentId !== undefined) exp.primaryParentId = info.primaryParentId;
      if (info.parentIds !== undefined) exp.parentIds = info.parentIds;
      if (info.familyId !== undefined) exp.familyId = info.familyId;
      if (info.generation !== undefined) exp.generation = info.generation;
      if (info.branchLabel !== undefined) exp.branchLabel = info.branchLabel;
    }
  }

  // Build node map
  const nodeMap = new Map<string, TreeNode>();
  for (const exp of experiments) {
    nodeMap.set(exp.id, { experiment: exp, children: [], depth: 0 });
  }

  // Wire children via primaryParentId (fall back to parentId)
  const roots: TreeNode[] = [];
  for (const node of nodeMap.values()) {
    const parentId = node.experiment.primaryParentId ?? node.experiment.parentId;
    if (parentId && nodeMap.has(parentId)) {
      nodeMap.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort: roots by compositeScore desc, children by compositeScore desc
  const scoreSort = (a: TreeNode, b: TreeNode) => {
    const sa = a.experiment.compositeScore;
    const sb = b.experiment.compositeScore;
    if (sa === null && sb === null) return 0;
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sb - sa;
  };

  roots.sort(scoreSort);

  function sortChildren(node: TreeNode): void {
    node.children.sort(scoreSort);
    for (const child of node.children) sortChildren(child);
  }
  for (const root of roots) sortChildren(root);

  return roots;
}

// ─── Flattening ──────────────────────────────────────

/**
 * Flatten a forest into rows with pre-computed connector strings for rendering.
 */
export function flattenForest(roots: TreeNode[]): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];

  function walk(node: TreeNode, depth: number, ancestorHasMore: boolean[]): void {
    const isLast = ancestorHasMore.length === 0 || !ancestorHasMore[ancestorHasMore.length - 1];
    const connectors = computeConnectors(depth, isLast, ancestorHasMore);
    rows.push({
      experiment: node.experiment,
      depth,
      connectors,
      isRoot: depth === 0,
    });

    for (let i = 0; i < node.children.length; i++) {
      const isLastChild = i === node.children.length - 1;
      walk(node.children[i], depth + 1, [...ancestorHasMore, !isLastChild]);
    }
  }

  for (const root of roots) {
    walk(root, 0, []);
  }

  return rows;
}

/**
 * Compute box-drawing connector prefix for a tree row.
 */
export function computeConnectors(depth: number, isLast: boolean, ancestorHasMore: boolean[]): string {
  if (depth === 0) return "";

  let prefix = "";
  // Ancestor levels (skip the last entry which is for the current node)
  for (let i = 0; i < ancestorHasMore.length - 1; i++) {
    prefix += ancestorHasMore[i] ? `${G.pipe} ` : "  ";
  }

  // Current level connector
  prefix += isLast ? `${G.branchEnd} ` : `${G.branch} `;

  return prefix;
}
