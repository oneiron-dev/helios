import { Box, Text } from "ink";

import { execSync } from "node:child_process";

// ─── Light-theme detection ──────────────────────────
function detectLightTerminal(): boolean {
  // 1. COLORFGBG is "fg;bg" — bg > 8 means light background
  const cfg = process.env.COLORFGBG;
  if (cfg) {
    const bg = Number(cfg.split(";").pop());
    if (!Number.isNaN(bg) && bg > 8) return true;
  }
  // 2. macOS system appearance — "Dark" means dark mode, error/empty means light
  if (process.platform === "darwin") {
    try {
      const result = execSync("defaults read -g AppleInterfaceStyle", { encoding: "utf8", timeout: 500 }).trim();
      return result !== "Dark";
    } catch {
      // Command fails when system is in light mode (key doesn't exist)
      return true;
    }
  }
  return false;
}

export type ThemeMode = "light" | "dark" | "auto";

function resolveLight(mode: ThemeMode): boolean {
  if (mode === "light") return true;
  if (mode === "dark") return false;
  // auto
  if (process.env.HELIOS_LIGHT === "1") return true;
  if (process.env.HELIOS_LIGHT === "0") return false;
  return detectLightTerminal();
}

const LIGHT_COLORS = {
  primary: "#cc3300" as string,
  bright: "#ff8800" as string,
  text: "black" as string,
  dim: "blackBright" as string,
  error: "red" as string,
  success: "green" as string,
};

const DARK_COLORS = {
  primary: "yellow" as string,
  bright: "yellowBright" as string,
  text: "white" as string,
  dim: "gray" as string,
  error: "red" as string,
  success: "green" as string,
};

let _themeMode: ThemeMode = "auto";
export let IS_LIGHT = resolveLight(_themeMode);

// ─── Metric Colors ───────────────────────────────────
const LIGHT_METRIC_COLORS = [
  "blue", "cyan", "green", "magenta", "red",
  "blueBright", "black", "yellow", "cyan", "green",
];
const DARK_METRIC_COLORS = [
  "yellowBright", "cyanBright", "greenBright", "magentaBright", "redBright",
  "blueBright", "whiteBright", "yellow", "cyan", "green",
];
export const METRIC_COLORS: string[] = IS_LIGHT
  ? [...LIGHT_METRIC_COLORS]
  : [...DARK_METRIC_COLORS];

// ─── Colors (mutable for runtime theme switching) ────
export let C = IS_LIGHT ? { ...LIGHT_COLORS } : { ...DARK_COLORS };

// ─── Theme change listeners (for React re-render) ───
type ThemeListener = () => void;
const _listeners: ThemeListener[] = [];

export function onThemeChange(fn: ThemeListener): () => void {
  _listeners.push(fn);
  return () => {
    const idx = _listeners.indexOf(fn);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

/** Switch theme at runtime. */
export function setTheme(mode: ThemeMode): void {
  _themeMode = mode;
  IS_LIGHT = resolveLight(mode);
  const src = IS_LIGHT ? LIGHT_COLORS : DARK_COLORS;
  Object.assign(C, src);
  Object.assign(METRIC_COLORS, IS_LIGHT ? LIGHT_METRIC_COLORS : DARK_METRIC_COLORS);
  // Update STATUS_STYLE colors that reference C
  STATUS_STYLE.accepted.color = C.success;
  STATUS_STYLE.screening.color = C.dim;
  STATUS_STYLE.running.color = C.primary;
  STATUS_STYLE.pending.color = C.dim;
  STATUS_STYLE.done.color = C.success;
  STATUS_STYLE.complete.color = C.success;
  STATUS_STYLE.error.color = C.error;
  STATUS_STYLE.rejected.color = C.error;
  STATUS_STYLE.keep.color = C.success;
  STATUS_STYLE.revert.color = C.error;
  // Notify listeners to trigger re-render
  for (const fn of _listeners) fn();
}

export function currentThemeMode(): ThemeMode {
  return _themeMode;
}

// ─── Glyphs ──────────────────────────────────────────
export const G = {
  brand: "◈",
  section: "◈",
  bullet: "▹",
  active: "▸",
  dot: "◆",
  dotDim: "◇",
  rule: "━",
  dash: "╌",
  check: "✓",
  cross: "✗",
  progress: "█",
  progressEmpty: "░",
  branch: "├",
  branchEnd: "└",
  pipe: "│",
  pause: "⏸",
  arrowUp: "↑",
  arrowDown: "↓",
};

// ─── Status Styling (Single Source of Truth) ─────────
export const STATUS_STYLE: Record<string, { color: string; glyph: string; fallback: string }> = {
  accepted:  { color: C.success, glyph: "✓", fallback: "[OK]" },
  rejected:  { color: C.error,   glyph: "✗", fallback: "[X]"  },
  screening: { color: C.dim,     glyph: "◇", fallback: "[~]"  },
  running:   { color: C.primary, glyph: "▸", fallback: "[>]"  },
  pending:   { color: C.dim,     glyph: "╌", fallback: "[-]"  },
  done:      { color: C.success, glyph: "✓", fallback: "[OK]" },
  complete:  { color: C.success, glyph: "✓", fallback: "[OK]" },
  error:     { color: C.error,   glyph: "!", fallback: "[!]"  },
  stalled:   { color: "magenta", glyph: "⏸", fallback: "[||]" },
  keep:      { color: C.success, glyph: "↑", fallback: "[^]"  },
  revert:    { color: C.error,   glyph: "↓", fallback: "[v]"  },
};

let _unicodeFallback = false;

export function setUnicodeFallback(v: boolean): void {
  _unicodeFallback = v;
}

function isAsciiMode(): boolean {
  return _unicodeFallback || process.env.HELIOS_ASCII === "1";
}

/** General-purpose fallback: returns ascii when fallback mode is active. */
export function glyph(unicode: string, ascii: string): string {
  return isAsciiMode() ? ascii : unicode;
}

/** Resolve glyph based on fallback mode (HELIOS_ASCII=1 or config) */
export function statusGlyph(status: string): string {
  const s = STATUS_STYLE[status];
  if (!s) return "?";
  return isAsciiMode() ? s.fallback : s.glyph;
}

/** Get the color for a status */
export function statusColor(status: string): string {
  return STATUS_STYLE[status]?.color ?? C.dim;
}

export function nameHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function cols(): number {
  return process.stdout.columns || 80;
}

/** Heavy horizontal rule spanning the terminal */
export function HRule({ dim = false }: { dim?: boolean }) {
  return (
    <Box>
      <Text color={C.primary} dimColor={dim}>
        {G.rule.repeat(cols())}
      </Text>
    </Box>
  );
}
