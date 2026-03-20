import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export const VERSION = loadVersion();

const NPM_PACKAGE = "helios-ai";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cachedLatest: string | null = null;
let lastCheckAt = 0;

/**
 * Check the npm registry for the latest published version.
 * Returns the newer version string if an update is available,
 * or null if current is up to date (or the check fails).
 * Results are cached for 6 hours.
 */
export async function checkForUpdate(): Promise<string | null> {
  const now = Date.now();
  if (cachedLatest !== null && now - lastCheckAt < CHECK_INTERVAL_MS) {
    return compareVersions(cachedLatest, VERSION) > 0 ? cachedLatest : null;
  }

  try {
    const resp = await fetch(
      `https://registry.npmjs.org/${NPM_PACKAGE}/latest`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!resp.ok) return null;

    const data = (await resp.json()) as { version?: string };
    const latest = data.version ?? null;
    if (latest) {
      cachedLatest = latest;
      lastCheckAt = now;
      return compareVersions(latest, VERSION) > 0 ? latest : null;
    }
  } catch {
    // Network error, timeout, etc. — silently ignore
  }

  return null;
}

/** Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
