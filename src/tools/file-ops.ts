import type { ToolDefinition } from "../providers/types.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import { shellQuote } from "../ui/format.js";

export function createReadFileTool(pool: ConnectionPool): ToolDefinition {
  return {
    name: "read_file",
    description:
      "Read a file's contents. Use this to inspect training scripts, configs, logs, or any text file.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: 'Machine to read from (use "local" for this machine)',
        },
        path: {
          type: "string",
          description: "Absolute path to the file",
        },
        offset: {
          type: "number",
          description: "Line number to start from (1-indexed, default: 1)",
        },
        limit: {
          type: "number",
          description: "Max lines to return (default: 200)",
        },
      },
      required: ["machine_id", "path"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const path = args.path as string;
      const offset = (args.offset as number) ?? 1;
      const limit = (args.limit as number) ?? 200;

      const end = offset + limit - 1;
      const result = await pool.exec(
        machineId,
        `sed -n '${offset},${end}p' ${shellQuote(path)}`,
      );

      if (result.exitCode !== 0) {
        return JSON.stringify({ error: result.stderr.trim() || `exit code ${result.exitCode}` });
      }

      // Count total lines for context
      const wcResult = await pool.exec(machineId, `wc -l < ${shellQuote(path)}`);
      const totalLines = parseInt(wcResult.stdout.trim(), 10) || 0;

      return JSON.stringify({
        content: result.stdout,
        lines: { from: offset, to: Math.min(end, totalLines), total: totalLines },
      });
    },
  };
}

export function createWriteFileTool(pool: ConnectionPool): ToolDefinition {
  return {
    name: "write_file",
    description:
      "Create or overwrite a file. Use this to write training scripts, configs, or data files.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: 'Machine to write to (use "local" for this machine)',
        },
        path: {
          type: "string",
          description: "Absolute path for the file",
        },
        content: {
          type: "string",
          description: "Full file content to write",
        },
        append: {
          type: "boolean",
          description: "Append instead of overwrite (default: false)",
        },
      },
      required: ["machine_id", "path", "content"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const path = args.path as string;
      const content = args.content as string;
      const append = (args.append as boolean) ?? false;

      // Ensure parent directory exists
      const dir = path.replace(/\/[^/]+$/, "");
      if (dir && dir !== path) {
        await pool.exec(machineId, `mkdir -p ${shellQuote(dir)}`);
      }

      const op = append ? ">>" : ">";
      // Use heredoc to handle multi-line content safely
      // Heredoc implicitly adds a trailing newline, so strip one from content to avoid doubling
      const body = content.endsWith("\n") ? content.slice(0, -1) : content;
      const heredocTag = "_HELIOS_EOF_" + Math.random().toString(36).slice(2, 8);
      const result = await pool.exec(
        machineId,
        `cat ${op} ${shellQuote(path)} <<'${heredocTag}'\n${body}\n${heredocTag}`,
      );

      if (result.exitCode !== 0) {
        return JSON.stringify({ error: result.stderr.trim() || `exit code ${result.exitCode}` });
      }

      const wcResult = await pool.exec(machineId, `wc -l < ${shellQuote(path)}`);
      const totalLines = parseInt(wcResult.stdout.trim(), 10) || 0;

      return JSON.stringify({ written: path, lines: totalLines });
    },
  };
}

export function createPatchFileTool(pool: ConnectionPool): ToolDefinition {
  return {
    name: "patch_file",
    description:
      "Edit a file by replacing a specific string with new content. Read the file first to see the exact text to match.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: 'Machine where the file lives (use "local" for this machine)',
        },
        path: {
          type: "string",
          description: "Absolute path to the file",
        },
        old_string: {
          type: "string",
          description: "Exact text to find and replace (must appear exactly once in the file)",
        },
        new_string: {
          type: "string",
          description: "Replacement text",
        },
      },
      required: ["machine_id", "path", "old_string", "new_string"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const path = args.path as string;
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;

      // Read current file
      const readResult = await pool.exec(machineId, `cat ${shellQuote(path)}`);
      if (readResult.exitCode !== 0) {
        return JSON.stringify({ error: readResult.stderr.trim() || "Failed to read file" });
      }

      const content = readResult.stdout;
      const count = content.split(oldStr).length - 1;

      if (count === 0) {
        return JSON.stringify({ error: "old_string not found in file" });
      }
      if (count > 1) {
        return JSON.stringify({ error: `old_string found ${count} times — must be unique. Include more surrounding context.` });
      }

      const patched = content.replace(oldStr, newStr);

      // Write back using heredoc
      // Strip trailing newline since heredoc adds one implicitly
      const body = patched.endsWith("\n") ? patched.slice(0, -1) : patched;
      const heredocTag = "_HELIOS_EOF_" + Math.random().toString(36).slice(2, 8);
      const writeResult = await pool.exec(
        machineId,
        `cat > ${shellQuote(path)} <<'${heredocTag}'\n${body}\n${heredocTag}`,
      );

      if (writeResult.exitCode !== 0) {
        return JSON.stringify({ error: writeResult.stderr.trim() || "Failed to write file" });
      }

      return JSON.stringify({ patched: path });
    },
  };
}

