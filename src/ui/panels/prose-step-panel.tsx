import { Box, Text } from "ink";
import { C, statusGlyph, statusColor } from "../theme.js";
import type { ProseRun } from "../../prose/types.js";

interface ProseStepPanelProps {
  run: ProseRun | null;
  width?: number;
}

export function ProseStepPanel({ run, width }: ProseStepPanelProps) {
  if (!run || run.steps.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={C.dim} dimColor>
            no active run
          </Text>
        </Box>
      </Box>
    );
  }

  const panelWidth = width ?? (Math.floor((process.stdout.columns || 80) / 2) - 3);
  const displayed = run.steps.slice(0, 5);
  const labelWidth = Math.max(10, panelWidth - 8);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {displayed.map((step) => {
        const label = step.label.length > labelWidth
          ? step.label.slice(0, labelWidth - 1) + "…"
          : step.label;
        return (
          <Box key={step.number} paddingLeft={1}>
            <Text color={statusColor(step.status)}>
              {statusGlyph(step.status)}{" "}
            </Text>
            <Text color={C.dim}>{String(step.number).padStart(2)}{" "}</Text>
            <Text color={C.text}>{label}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
