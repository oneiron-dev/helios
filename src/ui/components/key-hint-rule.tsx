import React, { memo } from "react";
import { Box, Text } from "ink";
import { C, G } from "../theme.js";

const BASE_HINTS = [
  { key: "esc", label: "interrupt" },
  { key: "^t", label: "tasks" },
  { key: "^g", label: "graphs" },
  { key: "^p", label: "prose" },
  { key: "^e", label: "experiments" },
];

interface KeyHintRuleProps {
  hasMultipleGroups?: boolean;
}

export const KeyHintRule = memo(function KeyHintRule({ hasMultipleGroups }: KeyHintRuleProps) {
  const w = process.stdout.columns || 80;

  const hints = hasMultipleGroups
    ? [...BASE_HINTS, { key: "^p", label: "panels" }]
    : BASE_HINTS;

  const hintsWidth = hints.reduce(
    (sum, h) => sum + 2 + h.key.length + 1 + h.label.length + 1,
    0,
  );
  const fill = Math.max(0, w - hintsWidth);

  return (
    <Box>
      <Text color={C.primary}>{G.rule.repeat(fill)}</Text>
      {hints.map((h, i) => (
        <React.Fragment key={i}>
          <Text color={C.dim}>{i === 0 ? " " : `${G.rule} `}</Text>
          <Text color={C.dim}>{h.key} {h.label} </Text>
        </React.Fragment>
      ))}
    </Box>
  );
});
