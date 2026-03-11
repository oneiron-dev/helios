/**
 * Shared formatting functions used across the UI, tools, and scheduler.
 */

/** Format a metric value for display (compact, appropriate precision). */
export function formatMetricValue(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toPrecision(4);
  if (Math.abs(v) >= 0.001) return v.toPrecision(3);
  return v.toExponential(2);
}

/** Format a duration in ms to a human-readable string (e.g. "2h 15m", "3m 42s", "8s"). */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Truncate a string with ellipsis. Optionally flattens whitespace for previews. */
export function truncate(s: string, max: number, flatten = false): string {
  const text = flatten ? s.replace(/\s+/g, " ").trim() : s;
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

/** Format an unknown error value to a string. */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Format bytes to a compact human-readable string (e.g. "1.5G", "128M"). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)}T`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}G`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}M`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)}K`;
  return `${bytes}B`;
}

/** Shell-escape a string using single quotes. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
