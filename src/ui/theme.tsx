import { Box, Text } from "ink";

// ─── Light-theme detection ──────────────────────────
function isLightTerminal(): boolean {
  if (process.env.HELIOS_LIGHT === "1") return true;
  if (process.env.HELIOS_LIGHT === "0") return false;
  // COLORFGBG is "fg;bg" — bg > 8 means light background
  const cfg = process.env.COLORFGBG;
  if (cfg) {
    const bg = Number(cfg.split(";").pop());
    if (!Number.isNaN(bg) && bg > 8) return true;
  }
  return false;
}

export const IS_LIGHT = isLightTerminal();

// ─── Colors ──────────────────────────────────────────
export const C = IS_LIGHT
  ? {
      primary: "#cc3300",
      bright: "#ff8800",
      text: "black" as const,
      dim: "blackBright" as const,   // ANSI "bright black" = dark gray
      error: "red" as const,
      success: "green" as const,
    }
  : {
      primary: "yellow" as const,
      bright: "yellowBright" as const,
      text: "white" as const,
      dim: "gray" as const,
      error: "red" as const,
      success: "green" as const,
    };

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

// ─── Metric Colors ───────────────────────────────────
export const METRIC_COLORS = IS_LIGHT
  ? ([
      "blue",
      "cyan",
      "green",
      "magenta",
      "red",
      "blueBright",
      "black",
      "yellow",
      "cyan",
      "green",
    ] as const)
  : ([
      "yellowBright",
      "cyanBright",
      "greenBright",
      "magentaBright",
      "redBright",
      "blueBright",
      "whiteBright",
      "yellow",
      "cyan",
      "green",
    ] as const);

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
