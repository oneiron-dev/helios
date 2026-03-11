/**
 * Tools for experiment git branching — the model decides when to branch.
 */

import type { ToolDefinition } from "../providers/types.js";
import type { ExperimentBrancher } from "../experiments/branching.js";
import { formatError } from "../ui/format.js";

export function createExperimentBranchTools(brancher: ExperimentBrancher): ToolDefinition[] {
  return [
    {
      name: "exp_branch",
      description:
        "Create a new git branch for an experiment. Use this before modifying code for an experiment so you can compare, revert, or diff later. Returns the branch name.",
      parameters: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine where the git repo lives",
          },
          repo_path: {
            type: "string",
            description: "Absolute path to the git repository",
          },
          experiment_name: {
            type: "string",
            description: "Short name for the experiment (e.g. 'lr-sweep', 'bigger-model')",
          },
        },
        required: ["machine_id", "repo_path", "experiment_name"],
      },
      execute: async (args) => {
        try {
          const branch = await brancher.createBranch(
            args.machine_id as string,
            args.repo_path as string,
            args.experiment_name as string,
          );
          if (!branch) {
            return JSON.stringify({ error: "Not a git repo or branch creation failed" });
          }
          return JSON.stringify({ branch, created: true });
        } catch (err) {
          return JSON.stringify({ error: formatError(err) });
        }
      },
    },
    {
      name: "exp_commit",
      description:
        "Commit all changes on the current experiment branch. Use after an experiment completes to snapshot the code + results.",
      parameters: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine where the git repo lives",
          },
          repo_path: {
            type: "string",
            description: "Absolute path to the git repository",
          },
          branch: {
            type: "string",
            description: "Branch name (from exp_branch)",
          },
          message: {
            type: "string",
            description: "Commit message describing the experiment results",
          },
        },
        required: ["machine_id", "repo_path", "branch", "message"],
      },
      execute: async (args) => {
        try {
          const ok = await brancher.commitResults(
            args.machine_id as string,
            args.repo_path as string,
            args.branch as string,
            args.message as string,
          );
          return JSON.stringify({ committed: ok });
        } catch (err) {
          return JSON.stringify({ error: formatError(err) });
        }
      },
    },
    {
      name: "exp_diff",
      description:
        "Show the code diff between two experiment branches. Use to understand what changed between experiments.",
      parameters: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine where the git repo lives",
          },
          repo_path: {
            type: "string",
            description: "Absolute path to the git repository",
          },
          branch_a: {
            type: "string",
            description: "First branch name",
          },
          branch_b: {
            type: "string",
            description: "Second branch name",
          },
        },
        required: ["machine_id", "repo_path", "branch_a", "branch_b"],
      },
      execute: async (args) => {
        try {
          const diff = await brancher.diff(
            args.machine_id as string,
            args.repo_path as string,
            args.branch_a as string,
            args.branch_b as string,
          );
          return JSON.stringify({ diff: diff || "(no differences)" });
        } catch (err) {
          return JSON.stringify({ error: formatError(err) });
        }
      },
    },
    {
      name: "exp_branches",
      description:
        "List all helios experiment branches in a repo.",
      parameters: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine where the git repo lives",
          },
          repo_path: {
            type: "string",
            description: "Absolute path to the git repository",
          },
        },
        required: ["machine_id", "repo_path"],
      },
      execute: async (args) => {
        try {
          const branches = await brancher.listBranches(
            args.machine_id as string,
            args.repo_path as string,
          );
          return JSON.stringify({ branches });
        } catch (err) {
          return JSON.stringify({ error: formatError(err) });
        }
      },
    },
    {
      name: "exp_checkout",
      description:
        "Switch back to the original branch after an experiment. Use when you're done with an experiment branch and want to return to the main line.",
      parameters: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine where the git repo lives",
          },
          branch: {
            type: "string",
            description: "Experiment branch to leave",
          },
        },
        required: ["machine_id", "branch"],
      },
      execute: async (args) => {
        try {
          await brancher.returnToOriginal(
            args.machine_id as string,
            args.branch as string,
          );
          return JSON.stringify({ returned: true });
        } catch (err) {
          return JSON.stringify({ error: formatError(err) });
        }
      },
    },
  ];
}
