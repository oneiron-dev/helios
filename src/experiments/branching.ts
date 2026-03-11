/**
 * Experiment branching — auto-create git branches per experiment.
 * Creates a branch when an experiment starts, commits results when it finishes.
 */

import type { RemoteExecutor } from "../remote/executor.js";
import { shellQuote } from "../ui/format.js";

export interface ExperimentBranch {
  machineId: string;
  repoPath: string;
  branchName: string;
  originalBranch: string;
}

export class ExperimentBrancher {
  private branches = new Map<string, ExperimentBranch>();

  constructor(private executor: RemoteExecutor) {}

  /**
   * Create a new git branch for an experiment.
   * Returns the branch name, or null if not in a git repo.
   */
  async createBranch(
    machineId: string,
    repoPath: string,
    experimentName: string,
  ): Promise<string | null> {
    // Check if in a git repo
    const check = await this.executor.exec(
      machineId,
      `cd ${shellQuote(repoPath)} && git rev-parse --is-inside-work-tree 2>/dev/null`,
    );
    if (check.exitCode !== 0 || check.stdout.trim() !== "true") {
      return null;
    }

    // Get current branch
    const currentBranch = await this.executor.exec(
      machineId,
      `cd ${shellQuote(repoPath)} && git rev-parse --abbrev-ref HEAD`,
    );
    const originalBranch = currentBranch.stdout.trim() || "main";

    // Create experiment branch
    const sanitized = experimentName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const branchName = `helios/exp-${sanitized}-${Date.now().toString(36)}`;

    const create = await this.executor.exec(
      machineId,
      `cd ${shellQuote(repoPath)} && git checkout -b ${shellQuote(branchName)}`,
    );
    if (create.exitCode !== 0) {
      return null;
    }

    const key = `${machineId}:${branchName}`;
    this.branches.set(key, {
      machineId,
      repoPath,
      branchName,
      originalBranch,
    });

    return branchName;
  }

  /**
   * Commit current changes on an experiment branch with a message.
   */
  async commitResults(
    machineId: string,
    repoPath: string,
    branchName: string,
    message: string,
  ): Promise<boolean> {
    const result = await this.executor.exec(
      machineId,
      `cd ${shellQuote(repoPath)} && git add -A && git diff --cached --quiet || git commit -m ${shellQuote(message)}`,
    );
    return result.exitCode === 0;
  }

  /**
   * Switch back to the original branch after an experiment.
   */
  async returnToOriginal(
    machineId: string,
    branchName: string,
  ): Promise<void> {
    const key = `${machineId}:${branchName}`;
    const branch = this.branches.get(key);
    if (!branch) return;

    await this.executor.exec(
      machineId,
      `cd ${shellQuote(branch.repoPath)} && git checkout ${shellQuote(branch.originalBranch)}`,
    );
    this.branches.delete(key);
  }

  /**
   * Get diff between two experiment branches.
   */
  async diff(
    machineId: string,
    repoPath: string,
    branchA: string,
    branchB: string,
  ): Promise<string> {
    const result = await this.executor.exec(
      machineId,
      `cd ${shellQuote(repoPath)} && git diff ${shellQuote(branchA)}..${shellQuote(branchB)}`,
    );
    return result.stdout;
  }

  /**
   * List all helios experiment branches in a repo.
   */
  async listBranches(
    machineId: string,
    repoPath: string,
  ): Promise<string[]> {
    const result = await this.executor.exec(
      machineId,
      `cd ${shellQuote(repoPath)} && git branch --list 'helios/exp-*' --format='%(refname:short)'`,
    );
    if (result.exitCode !== 0) return [];
    return result.stdout.trim().split("\n").filter(Boolean);
  }
}
