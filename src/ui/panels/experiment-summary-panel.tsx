import { Box, Text } from "ink";
import { C } from "../theme.js";
import type { ExperimentSummary } from "../../experiments/types.js";

interface ExperimentSummaryPanelProps {
  summary: ExperimentSummary | null;
  width?: number;
}

export function ExperimentSummaryPanel({ summary }: ExperimentSummaryPanelProps) {
  if (!summary) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={C.dim} dimColor>
            no experiments ╌ configure in helios.json
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box paddingLeft={1}>
        <Text color={C.primary} bold>{summary.label}</Text>
      </Box>
      {summary.stats.map((stat) => (
        <Box key={stat.key} paddingLeft={1}>
          <Text color={C.dim}>{stat.key}: </Text>
          <Text color={C.text}>{stat.value}</Text>
        </Box>
      ))}
      {summary.bestScore !== null && (
        <Box paddingLeft={1}>
          <Text color={C.success}>best: {summary.bestScore.toPrecision(4)}</Text>
        </Box>
      )}
    </Box>
  );
}
