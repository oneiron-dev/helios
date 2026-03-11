import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RemoteMachine } from "./types.js";
import { HELIOS_DIR } from "../paths.js";

const CONFIG_DIR = HELIOS_DIR;
const MACHINES_FILE = join(CONFIG_DIR, "machines.json");

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadMachines(): RemoteMachine[] {
  try {
    const data = readFileSync(MACHINES_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed as RemoteMachine[];
  } catch {
    return [];
  }
}

export function saveMachines(machines: RemoteMachine[]): void {
  ensureConfigDir();
  writeFileSync(MACHINES_FILE, JSON.stringify(machines, null, 2), "utf-8");
}

export function addMachine(machine: RemoteMachine): void {
  const machines = loadMachines();
  const existing = machines.findIndex((m) => m.id === machine.id);
  if (existing >= 0) {
    machines[existing] = machine;
  } else {
    machines.push(machine);
  }
  saveMachines(machines);
}

export function removeMachine(id: string): boolean {
  const machines = loadMachines();
  const filtered = machines.filter((m) => m.id !== id);
  if (filtered.length === machines.length) return false;
  saveMachines(filtered);
  return true;
}

/**
 * Parse a machine spec string into a RemoteMachine.
 * Format: user@host[:port] [--key path] [--auth agent|key|password]
 */
export function parseMachineSpec(
  id: string,
  spec: string,
  options: { key?: string; auth?: string } = {},
): RemoteMachine {
  // Parse user@host[:port]
  const atIdx = spec.indexOf("@");
  if (atIdx < 0) throw new Error("Format: user@host[:port]");

  const username = spec.slice(0, atIdx);
  const hostPart = spec.slice(atIdx + 1);

  let host: string;
  let port = 22;
  const colonIdx = hostPart.lastIndexOf(":");
  if (colonIdx >= 0) {
    host = hostPart.slice(0, colonIdx);
    port = parseInt(hostPart.slice(colonIdx + 1), 10);
    if (isNaN(port)) throw new Error("Invalid port number");
  } else {
    host = hostPart;
  }

  const authMethod = (options.auth as "key" | "agent" | "password") ?? (options.key ? "key" : "agent");

  return {
    id,
    host,
    port,
    username,
    authMethod,
    keyPath: options.key,
  };
}
