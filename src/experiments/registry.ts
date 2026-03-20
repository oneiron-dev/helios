import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExperimentAdapter } from "./types.js";

export interface AdapterConfig {
  experimentAdapter?: string;
  experimentConfig?: Record<string, unknown>;
}

export async function createAdapter(
  config: AdapterConfig,
  projectRoot: string,
): Promise<ExperimentAdapter | null> {
  if (config.experimentAdapter) {
    return createByName(config.experimentAdapter, config.experimentConfig ?? {}, projectRoot);
  }
  return autoDetect(projectRoot);
}

async function createByName(
  name: string,
  config: Record<string, unknown>,
  projectRoot: string,
): Promise<ExperimentAdapter | null> {
  switch (name) {
    case "arena-sweep": {
      const { ArenaSweepAdapter } = await import("./adapters/arena-sweep.js");
      const artifactsDir = resolve(
        projectRoot,
        (config.artifactsDir as string) ?? "python/train/artifacts",
      );
      return new ArenaSweepAdapter(artifactsDir);
    }
    case "autoresearch-tsv": {
      const { AutoresearchTsvAdapter } = await import("./adapters/autoresearch-tsv.js");
      const researchDir = config.researchDir as string | undefined;
      return new AutoresearchTsvAdapter(projectRoot, researchDir);
    }
    default:
      return null;
  }
}

async function autoDetect(projectRoot: string): Promise<ExperimentAdapter | null> {
  const artifactsDir = join(projectRoot, "python", "train", "artifacts");
  const searchSweepsDir = join(artifactsDir, "search_sweeps");
  const outerloopDir = join(projectRoot, "artifacts", "outerloop");

  if (existsSync(searchSweepsDir)) {
    const { ArenaSweepAdapter } = await import("./adapters/arena-sweep.js");
    return new ArenaSweepAdapter(artifactsDir);
  }

  if (existsSync(outerloopDir)) {
    const { ArenaSweepAdapter } = await import("./adapters/arena-sweep.js");
    return new ArenaSweepAdapter(outerloopDir);
  }

  if (
    existsSync(join(projectRoot, "research", "results.tsv")) &&
    existsSync(join(projectRoot, "research", "autoresearch.prose"))
  ) {
    const { AutoresearchTsvAdapter } = await import("./adapters/autoresearch-tsv.js");
    return new AutoresearchTsvAdapter(projectRoot);
  }

  // Fallback: scan artifacts dir for anything sweep-like
  if (existsSync(artifactsDir)) {
    try {
      const entries = readdirSync(artifactsDir);
      const hasSweeps = entries.some((e) => e.startsWith("search_sweep") || e.includes("sweep"));
      if (hasSweeps) {
        const { ArenaSweepAdapter } = await import("./adapters/arena-sweep.js");
        return new ArenaSweepAdapter(artifactsDir);
      }
    } catch { /* ignore */ }
  }

  return null;
}
