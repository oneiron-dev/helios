/**
 * Set environment variables from CLI options BEFORE any module imports
 * that read env vars at load time (paths.ts, hub/config.ts, etc.).
 */

import { Option } from "effect";

export interface EnvOptions {
  home: Option.Option<string>;
  hubUrl: Option.Option<string>;
  hubKey: Option.Option<string>;
  agent: Option.Option<string>;
}

export function applyEnv(opts: EnvOptions): void {
  if (Option.isSome(opts.home)) process.env.HELIOS_HOME = opts.home.value;
  if (Option.isSome(opts.hubUrl)) process.env.AGENTHUB_URL = opts.hubUrl.value;
  if (Option.isSome(opts.hubKey)) process.env.AGENTHUB_KEY = opts.hubKey.value;
  if (Option.isSome(opts.agent)) process.env.AGENTHUB_AGENT = opts.agent.value;
}
