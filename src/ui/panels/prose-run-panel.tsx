import { Box, Text } from "ink";
import { C } from "../theme.js";
import { statusGlyph, statusColor } from "../theme.js";
import { formatDuration } from "../format.js";
import type { ProseRun } from "../../prose/types.js";

interface ProseRunPanelProps {
  runs: ProseRun[];
  width?: number;
}

export function ProseRunPanel({ runs, width }: ProseRunPanelProps) {
  const panelWidth = width ?? (Math.floor((process.stdout.columns || 80) / 2) - 3);

  if (runs.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={C.dim} dimColor>
            no runs ╌ /prose run &lt;file&gt; to start
          </Text>
        </Box>
      </Box>
    );
  }

  const displayed = runs.slice(0, 5);
  // Compute widths: glyph(2) + id(16) + space(1) + status(8) + space(1) + elapsed(?) + space(1) + name(rest)
  const nameWidth = Math.max(6, panelWidth - 32);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {displayed.map((run) => {
        const elapsed = formatDuration(Date.now() - run.startedAt);
        const name = run.programName.length > nameWidth
          ? run.programName.slice(0, nameWidth - 1) + "…"
          : run.programName;
        return (
          <Box key={run.id} paddingLeft={1}>
            <Text color={statusColor(run.status)}>
              {statusGlyph(run.status)}{" "}
            </Text>
            <Text color={C.text}>
              {run.id.slice(0, 16).padEnd(16)}{" "}
            </Text>
            <Text color={statusColor(run.status)}>
              {run.status.padEnd(8)}{" "}
            </Text>
            <Text color={C.dim}>{elapsed} </Text>
            <Text color={C.dim}>{name}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
