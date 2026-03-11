import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";
import type { HubClient } from "../hub/client.js";
import type { RemoteExecutor } from "../remote/executor.js";
import { shellQuote, formatError } from "../ui/format.js";

function createHubPushTool(client: HubClient, executor: RemoteExecutor): ToolDefinition {
  return {
    name: "hub_push",
    description:
      "Push the current git HEAD from a repo to AgentHub as a bundle. Use this after committing experiment code/results to share with other agents.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: 'Machine where the git repo lives (e.g. "local")',
        },
        repo_path: {
          type: "string",
          description: "Absolute path to the git repository",
        },
        parent_hash: {
          type: "string",
          description: "Optional AgentHub commit hash to create an incremental bundle from. Omit for first push.",
        },
      },
      required: ["machine_id", "repo_path"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const repoPath = args.repo_path as string;
      const parentHash = args.parent_hash as string | undefined;

      try {
        // Get HEAD hash
        const headResult = await executor.exec(machineId, `cd ${shellQuote(repoPath)} && git rev-parse HEAD`);
        if (headResult.exitCode !== 0) {
          return JSON.stringify({ error: `Not a git repo or no commits: ${headResult.stderr.trim()}` });
        }
        const head = headResult.stdout.trim();

        // Create bundle
        const bundlePath = `/tmp/helios-bundle-${randomBytes(6).toString("hex")}.bundle`;
        const range = parentHash ? `${shellQuote(parentHash)}..HEAD` : "HEAD";
        const bundleCmd = `cd ${shellQuote(repoPath)} && git bundle create ${bundlePath} ${range}`;
        const bundleResult = await executor.exec(machineId, bundleCmd);
        if (bundleResult.exitCode !== 0) {
          return JSON.stringify({ error: `Bundle creation failed: ${bundleResult.stderr.trim()}` });
        }

        // Read bundle and push
        let bundleBuffer: Buffer;
        if (machineId === "local") {
          bundleBuffer = readFileSync(bundlePath);
          unlinkSync(bundlePath);
        } else {
          // Remote: base64 encode over SSH
          const b64Result = await executor.exec(machineId, `base64 < ${bundlePath} && rm -f ${bundlePath}`, 60_000);
          if (b64Result.exitCode !== 0) {
            return JSON.stringify({ error: `Failed to read bundle: ${b64Result.stderr.trim()}` });
          }
          bundleBuffer = Buffer.from(b64Result.stdout.replace(/\s/g, ""), "base64");
        }

        const result = await client.pushBundle(bundleBuffer);
        return JSON.stringify({ pushed: true, hashes: result.hashes, head, bytes: bundleBuffer.length });
      } catch (err) {
        return JSON.stringify({ error: formatError(err) });
      }
    },
  };
}

function createHubFetchTool(client: HubClient, executor: RemoteExecutor): ToolDefinition {
  return {
    name: "hub_fetch",
    description:
      "Fetch a commit from AgentHub and apply it to a local git repo. Use this to build on another agent's work.",
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
        hash: {
          type: "string",
          description: "AgentHub commit hash to fetch",
        },
      },
      required: ["machine_id", "repo_path", "hash"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const repoPath = args.repo_path as string;
      const hash = args.hash as string;

      try {
        const bundle = await client.fetchBundle(hash);
        const bundlePath = `/tmp/helios-fetch-${randomBytes(6).toString("hex")}.bundle`;

        if (machineId === "local") {
          writeFileSync(bundlePath, bundle);
        } else {
          // Write bundle to remote: split base64 into chunks to avoid ARG_MAX
          const b64 = bundle.toString("base64");
          const CHUNK_SIZE = 65536; // 64KB chunks, well under ARG_MAX
          // Truncate any existing file, then append chunks
          await executor.exec(machineId, `> ${bundlePath}`, 10_000);
          for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
            const chunk = b64.slice(i, i + CHUNK_SIZE);
            const appendResult = await executor.exec(machineId, `printf '%s' '${chunk}' >> ${bundlePath}.b64`, 10_000);
            if (appendResult.exitCode !== 0) {
              return JSON.stringify({ error: `Failed to write bundle chunk: ${appendResult.stderr.trim()}` });
            }
          }
          // base64 -d works on Linux and modern macOS; -D is the legacy macOS flag
          const decodeResult = await executor.exec(machineId, `(base64 -d < ${bundlePath}.b64 > ${bundlePath} 2>/dev/null || base64 -D < ${bundlePath}.b64 > ${bundlePath}) && rm -f ${bundlePath}.b64`, 60_000);
          if (decodeResult.exitCode !== 0) {
            return JSON.stringify({ error: `Failed to decode bundle: ${decodeResult.stderr.trim()}` });
          }
        }

        // Verify and unbundle
        const verifyResult = await executor.exec(machineId, `cd ${shellQuote(repoPath)} && git bundle verify ${bundlePath} 2>&1`);
        if (verifyResult.exitCode !== 0) {
          await executor.exec(machineId, `rm -f ${bundlePath}`);
          return JSON.stringify({ error: `Bundle verification failed: ${verifyResult.stdout.trim()}` });
        }

        const unbundleResult = await executor.exec(machineId, `cd ${shellQuote(repoPath)} && git bundle unbundle ${bundlePath} && rm -f ${bundlePath}`);
        if (unbundleResult.exitCode !== 0) {
          return JSON.stringify({ error: `Unbundle failed: ${unbundleResult.stderr.trim()}` });
        }

        return JSON.stringify({ fetched: true, hash, output: unbundleResult.stdout.trim() });
      } catch (err) {
        return JSON.stringify({ error: formatError(err) });
      }
    },
  };
}

function createHubLogTool(client: HubClient): ToolDefinition {
  return {
    name: "hub_log",
    description: "List recent commits on AgentHub. Optionally filter by agent ID.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Filter by agent ID (optional)" },
        limit: { type: "number", description: "Number of commits to return (default 10)" },
      },
    },
    execute: async (args) => {
      try {
        const commits = await client.listCommits({
          agent: args.agent as string | undefined,
          limit: (args.limit as number) || 10,
        });
        return JSON.stringify(commits);
      } catch (err) {
        return JSON.stringify({ error: formatError(err) });
      }
    },
  };
}

function createHubLeavesTool(client: HubClient): ToolDefinition {
  return {
    name: "hub_leaves",
    description: "Get the frontier commits on AgentHub — commits with no children. These represent the latest experiments by all agents.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      try {
        const leaves = await client.getLeaves();
        return JSON.stringify(leaves);
      } catch (err) {
        return JSON.stringify({ error: formatError(err) });
      }
    },
  };
}

function createHubDiffTool(client: HubClient): ToolDefinition {
  return {
    name: "hub_diff",
    description: "Compare two commits on AgentHub. Returns a unified diff.",
    parameters: {
      type: "object",
      properties: {
        hash_a: { type: "string", description: "First commit hash" },
        hash_b: { type: "string", description: "Second commit hash" },
      },
      required: ["hash_a", "hash_b"],
    },
    execute: async (args) => {
      try {
        const diff = await client.diff(args.hash_a as string, args.hash_b as string);
        return JSON.stringify({ diff });
      } catch (err) {
        return JSON.stringify({ error: formatError(err) });
      }
    },
  };
}

function createHubPostTool(client: HubClient): ToolDefinition {
  return {
    name: "hub_post",
    description: "Post to an AgentHub channel. Use this to share experiment writeups, findings, or coordination notes with other agents.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name to post to" },
        content: { type: "string", description: "Post content (markdown)" },
      },
      required: ["channel", "content"],
    },
    execute: async (args) => {
      try {
        const post = await client.createPost(
          args.channel as string,
          args.content as string,
        );
        return JSON.stringify({ posted: true, id: post.id, channel_id: post.channel_id });
      } catch (err) {
        return JSON.stringify({ error: formatError(err) });
      }
    },
  };
}

function createHubReadTool(client: HubClient): ToolDefinition {
  return {
    name: "hub_read",
    description: "Read posts from an AgentHub channel, or read a specific post and its replies.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name to read from (omit if reading a specific post)" },
        post_id: { type: "number", description: "Specific post ID to read with replies (omit to list channel posts)" },
        limit: { type: "number", description: "Number of posts to return (default 10)" },
      },
    },
    execute: async (args) => {
      try {
        const postId = args.post_id as number | undefined;
        if (postId) {
          const [post, replies] = await Promise.all([
            client.getPost(postId),
            client.getReplies(postId),
          ]);
          return JSON.stringify({ post, replies });
        }

        const channel = args.channel as string;
        if (!channel) {
          return JSON.stringify({ error: "Provide either channel or post_id" });
        }
        const posts = await client.listPosts(channel, { limit: (args.limit as number) || 10 });
        return JSON.stringify(posts);
      } catch (err) {
        return JSON.stringify({ error: formatError(err) });
      }
    },
  };
}

function createHubReplyTool(client: HubClient): ToolDefinition {
  return {
    name: "hub_reply",
    description: "Reply to a post on AgentHub. You need the channel name and the post ID.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel the post is in" },
        post_id: { type: "number", description: "ID of the post to reply to" },
        content: { type: "string", description: "Reply content (markdown)" },
      },
      required: ["channel", "post_id", "content"],
    },
    execute: async (args) => {
      try {
        const reply = await client.createPost(
          args.channel as string,
          args.content as string,
          args.post_id as number,
        );
        return JSON.stringify({ replied: true, id: reply.id, parent_id: reply.parent_id });
      } catch (err) {
        return JSON.stringify({ error: formatError(err) });
      }
    },
  };
}


export function createHubTools(client: HubClient, executor: RemoteExecutor): ToolDefinition[] {
  return [
    createHubPushTool(client, executor),
    createHubFetchTool(client, executor),
    createHubLogTool(client),
    createHubLeavesTool(client),
    createHubDiffTool(client),
    createHubPostTool(client),
    createHubReadTool(client),
    createHubReplyTool(client),
  ];
}
