import React from "react";
import { Box, Text } from "ink";
import { C, G } from "../theme.js";

const HINTS = [
  { key: "esc", label: "interrupt" },
  { key: "^t", label: "tasks" },
  { key: "^g", label: "metrics" },
  { key: "^r", label: "prose" },
  { key: "^d", label: "experiments" },
];

export function KeyHintRule() {
  const w = process.stdout.columns || 80;

  let hintsWidth = 0;
  for (const h of HINTS) {
    hintsWidth += 2 + h.key.length + 1 + h.label.length + 1;
  }
  const fill = Math.max(0, w - hintsWidth);

  return (
    <Box>
      <Text color={C.primary}>{G.rule.repeat(fill)}</Text>
      {HINTS.map((h, i) => (
        <React.Fragment key={i}>
          {i === 0 ? (
            <Text color={C.dim}> </Text>
          ) : (
            <Text color={C.dim}>{G.rule} </Text>
          )}
          <Text color={C.dim}>{h.key}</Text>
          <Text color={C.dim}> {h.label} </Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
