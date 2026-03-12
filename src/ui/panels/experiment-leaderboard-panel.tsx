import { Box, Text } from "ink";
import { C, statusGlyph, statusColor } from "../theme.js";
import { sparkline } from "./metrics-dashboard.js";
import type { Experiment } from "../../experiments/types.js";

interface ExperimentLeaderboardPanelProps {
  experiments: Experiment[];
  width?: number;
}

export function ExperimentLeaderboardPanel({ experiments, width }: ExperimentLeaderboardPanelProps) {
  const panelWidth = width ?? (Math.floor((process.stdout.columns || 80) / 2) - 3);

  if (experiments.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={C.dim} dimColor>
            no experiments
          </Text>
        </Box>
      </Box>
    );
  }

  // Sort by compositeScore descending, nulls last
  const sorted = [...experiments].sort((a, b) => {
    if (a.compositeScore === null && b.compositeScore === null) return 0;
    if (a.compositeScore === null) return 1;
    if (b.compositeScore === null) return -1;
    return b.compositeScore - a.compositeScore;
  });

  const top5 = sorted.slice(0, 5);
  const idWidth = Math.min(20, Math.max(8, panelWidth - 16));

  // Sparkline of ALL scores at bottom
  const allScores = sorted
    .map((e) => e.compositeScore)
    .filter((s): s is number => s !== null);
  const sparkWidth = Math.max(10, panelWidth - 2);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {top5.map((exp, i) => {
        const id = exp.id.length > idWidth
          ? exp.id.slice(0, idWidth - 1) + "…"
          : exp.id.padEnd(idWidth);
        const score = exp.compositeScore !== null
          ? exp.compositeScore.toPrecision(4)
          : "—";
        return (
          <Box key={exp.id} paddingLeft={1}>
            <Text color={C.dim}>{String(i + 1)}. </Text>
            <Text color={statusColor(exp.status)}>
              {statusGlyph(exp.status)}{" "}
            </Text>
            <Text color={C.text}>{id} </Text>
            <Text color={C.primary}>{score}</Text>
          </Box>
        );
      })}
      {allScores.length > 1 && (
        <Box paddingLeft={1}>
          <Text color={C.dim}>{sparkline(allScores, sparkWidth)}</Text>
        </Box>
      )}
    </Box>
  );
}
