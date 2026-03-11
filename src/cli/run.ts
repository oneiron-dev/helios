/**
 * Default command — launches the interactive TUI or runs in print mode.
 */

import { Effect, Option } from "effect";
import type { Attachment } from "../providers/types.js";

export interface RunOptions {
  provider: Option.Option<string>;
  claudeMode: Option.Option<string>;
  model: Option.Option<string>;
  continueSession: boolean;
  resumeSession: Option.Option<string>;
  print: boolean;
  headless: boolean;
  files: string[];
  prompt: Option.Option<string>;
}

export function run(opts: RunOptions): Effect.Effect<void> {
  return Effect.gen(function* () {
    const providerArg = Option.getOrUndefined(opts.provider) as "claude" | "openai" | undefined;
    const claudeModeArg = Option.getOrUndefined(opts.claudeMode) as "cli" | "api" | undefined;
    const modelArg = Option.getOrUndefined(opts.model);
    const resumeId = Option.getOrUndefined(opts.resumeSession);
    const promptText = Option.getOrUndefined(opts.prompt);

    if (opts.print) {
      yield* printMode({ provider: providerArg, claudeMode: claudeModeArg, model: modelArg, prompt: promptText, files: opts.files });
    } else {
      yield* tuiMode({
        provider: providerArg,
        claudeMode: claudeModeArg,
        model: modelArg,
        headless: opts.headless,
        continueSession: opts.continueSession,
        resumeSessionId: resumeId,
        prompt: promptText,
        files: opts.files,
      });
    }
  });
}

// ── File loading ────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

async function loadAttachments(paths: string[]): Promise<Attachment[]> {
  if (paths.length === 0) return [];

  const { readFile, stat } = await import("node:fs/promises");
  const { extname, basename } = await import("node:path");

  return Promise.all(
    paths.map(async (filePath) => {
      const ext = extname(filePath).toLowerCase();
      const mediaType = MIME_TYPES[ext];
      if (!mediaType) {
        throw new Error(`Unsupported file type: ${ext} (supported: ${Object.keys(MIME_TYPES).join(", ")})`);
      }
      const info = await stat(filePath);
      if (info.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${basename(filePath)} (${(info.size / 1024 / 1024).toFixed(0)}MB, max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
      }
      const data = await readFile(filePath);
      return {
        filename: basename(filePath),
        mediaType,
        data: data.toString("base64"),
      };
    }),
  );
}

// ── Print mode: run prompt, stream response to stdout, exit ──

interface PrintOpts {
  provider?: "claude" | "openai";
  claudeMode?: "cli" | "api";
  model?: string;
  prompt?: string;
  files: string[];
}

function printMode(opts: PrintOpts): Effect.Effect<void> {
  return Effect.promise(async () => {
    if (!opts.prompt) {
      // Read from stdin if no prompt argument
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      opts.prompt = Buffer.concat(chunks).toString("utf-8").trim();
    }

    if (!opts.prompt) {
      process.stderr.write("Error: no prompt provided. Pass a prompt as an argument or pipe via stdin.\n");
      process.exit(1);
    }

    const attachments = await loadAttachments(opts.files);

    const { createRuntime } = await import("../init.js");
    const runtime = await createRuntime({ provider: opts.provider, claudeMode: opts.claudeMode });

    if (opts.model) {
      await runtime.orchestrator.setModel(opts.model);
    }

    try {
      for await (const event of runtime.orchestrator.send(opts.prompt, attachments.length > 0 ? attachments : undefined)) {
        if (event.type === "text" && event.delta) {
          process.stdout.write(event.delta);
        }
      }
      process.stdout.write("\n");
    } finally {
      runtime.cleanup();
    }
  });
}

// ── TUI mode: launch the Ink full-screen UI ──

interface TuiOpts {
  provider?: "claude" | "openai";
  claudeMode?: "cli" | "api";
  model?: string;
  headless: boolean;
  continueSession: boolean;
  resumeSessionId?: string;
  prompt?: string;
  files: string[];
}

function tuiMode(opts: TuiOpts): Effect.Effect<void> {
  return Effect.promise(async () => {
    const initialPrompt = opts.prompt;
    const attachments = await loadAttachments(opts.files);

    // Dynamic imports to avoid pulling React into print mode
    const { withFullScreen } = await import("fullscreen-ink");
    const { App } = await import("../app.js");
    const { createMouseFilter } = await import("../ui/mouse-filter.js");
    const { createElement } = await import("react");

    const { filteredStdin, mouseEmitter } = createMouseFilter(process.stdin);

    const { start, waitUntilExit } = withFullScreen(
      createElement(App, {
        defaultProvider: opts.provider,
        claudeMode: opts.claudeMode,
        mouseEmitter: opts.headless ? undefined : mouseEmitter,
        headless: opts.headless,
        initialPrompt,
        initialAttachments: attachments.length > 0 ? attachments : undefined,
        resumeSessionId: opts.resumeSessionId,
        continueSession: opts.continueSession,
        model: opts.model,
      }),
      { exitOnCtrlC: false, stdin: filteredStdin as any },
    );

    await start();
    await waitUntilExit();
  });
}
