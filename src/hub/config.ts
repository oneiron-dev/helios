import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HELIOS_DIR } from "../paths.js";

const CONFIG_DIR = HELIOS_DIR;
const HUB_FILE = join(CONFIG_DIR, "hub.json");

export interface HubConfig {
  url: string;
  apiKey: string;
  agentName?: string;
}

export function loadHubConfig(): HubConfig | null {
  // Env vars take priority
  const envUrl = process.env.AGENTHUB_URL;
  const envKey = process.env.AGENTHUB_KEY;
  if (envUrl && envKey) {
    return { url: envUrl.replace(/\/+$/, ""), apiKey: envKey, agentName: process.env.AGENTHUB_AGENT };
  }

  try {
    const data = readFileSync(HUB_FILE, "utf-8");
    const parsed = JSON.parse(data) as HubConfig;
    if (parsed.url && parsed.apiKey) {
      return { ...parsed, url: parsed.url.replace(/\/+$/, "") };
    }
  } catch {
    // No config file
  }

  return null;
}

export function saveHubConfig(config: HubConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(HUB_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function removeHubConfig(): boolean {
  try {
    unlinkSync(HUB_FILE);
    return true;
  } catch {
    return false;
  }
}
