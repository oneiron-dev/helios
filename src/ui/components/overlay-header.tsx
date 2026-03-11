import { Box, Text } from "ink";
import { C, G } from "../theme.js";

export function OverlayHeader({ width, title, hints }: { width: number; title: string; hints: string }) {
  const label = ` ${G.brand} ${title} `;
  const hintLabel = ` ${hints} `;
  const fill = Math.max(0, width - label.length - hintLabel.length);
  return (
    <Box flexShrink={0}>
      <Text color={C.primary} bold>{label}</Text>
      <Text color={C.primary}>{G.rule.repeat(fill)}</Text>
      <Text color={C.primary} dimColor>{hintLabel}</Text>
    </Box>
  );
}
