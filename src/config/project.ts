import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  /** Default provider for this project */
  provider?: "claude" | "openai";
  /** Default model */
  model?: string;
  /** Default machine to run experiments on */
  defaultMachine?: string;
  /** Metric names the agent should always track */
  metricNames?: string[];
  /** Metric regex patterns: name -> regex with one capture group */
  metricPatterns?: Record<string, string>;
  /** Project-specific system prompt addendum -- appended to the base prompt */
  instructions?: string;
  /** Notification config */
  notifications?: {
    channels: Array<
      | { type: "desktop" }
      | { type: "webhook"; url: string; method?: "GET" | "POST"; headers?: Record<string, string> }
      | { type: "command"; command: string }
    >;
    events?: string[];
  };
  /** Working directory for experiments (relative to project root) */
  experimentDir?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = "helios.json";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` looking for `helios.json`.
 * Returns the full path to the config file, or null if not found.
 * Stops at the filesystem root or the user's home directory.
 */
function walkUp(startDir: string): string | null {
  const home = homedir();
  let dir = resolve(startDir);

  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }

    // Stop if we've reached home or filesystem root
    if (dir === home) break;

    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root — dirname('/') === '/'

    dir = parent;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk up from `process.cwd()` looking for `helios.json`.
 * Returns the full path to the config file, or null if not found.
 */
export function findProjectConfigPath(): string | null {
  try {
    return walkUp(process.cwd());
  } catch {
    return null;
  }
}

/**
 * Walk up from `process.cwd()` looking for `helios.json`.
 * If found, parse and return it. If not found or parse fails, return null.
 */
export function findProjectConfig(): ProjectConfig | null {
  try {
    const configPath = walkUp(process.cwd());
    if (!configPath) return null;

    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as ProjectConfig;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Same walk-up logic as `findProjectConfig` but returns the directory
 * containing `helios.json`, or null.
 */
export function findProjectRoot(): string | null {
  try {
    const configPath = walkUp(process.cwd());
    if (!configPath) return null;
    return dirname(configPath);
  } catch {
    return null;
  }
}

/**
 * Write `helios.json` to the given directory with pretty-printed JSON.
 */
export function writeProjectConfig(dir: string, config: ProjectConfig): void {
  const target = join(resolve(dir), CONFIG_FILENAME);
  writeFileSync(target, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Merge project-level config with global user preferences.
 * Project config takes precedence over global prefs.
 */
export function mergeWithGlobalPrefs(
  projectConfig: ProjectConfig | null,
  globalPrefs: { lastProvider?: string; claudeAuthMode?: string },
): { provider?: "claude" | "openai"; claudeMode?: "cli" | "api"; model?: string } {
  const result: { provider?: "claude" | "openai"; claudeMode?: "cli" | "api"; model?: string } = {};

  // Provider — project config wins, then global prefs
  if (projectConfig?.provider) {
    result.provider = projectConfig.provider;
  } else if (globalPrefs.lastProvider === "claude" || globalPrefs.lastProvider === "openai") {
    result.provider = globalPrefs.lastProvider;
  }

  // Claude auth mode — derive from global prefs (project config doesn't specify this)
  if (globalPrefs.claudeAuthMode === "cli" || globalPrefs.claudeAuthMode === "api") {
    result.claudeMode = globalPrefs.claudeAuthMode;
  }

  // Model — only project config carries this
  if (projectConfig?.model) {
    result.model = projectConfig.model;
  }

  return result;
}
