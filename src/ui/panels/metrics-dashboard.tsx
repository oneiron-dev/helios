import { Box, Text } from "ink";
import { C, METRIC_COLORS, nameHash } from "../theme.js";
import { formatMetricValue } from "../format.js";

interface MetricsDashboardProps {
  metricData?: Map<string, number[]>;
  width?: number;
}

export function MetricsDashboard({
  metricData,
  width,
}: MetricsDashboardProps) {
  const panelWidth = width ?? (Math.floor((process.stdout.columns || 80) / 2) - 3);
  // label(12) + space(1) + value(10) + space(1) + padding(2) = 26 overhead
  const sparkWidth = Math.max(10, panelWidth - 26);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {!metricData || metricData.size === 0 ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={C.dim} dimColor>
            no active metrics
          </Text>
        </Box>
      ) : (
        (() => {
          const entries = Array.from(metricData.entries());
          const maxNameLen = Math.max(...entries.map(([n]) => n.length));
          const labelWidth = maxNameLen + 1;
          const adjSparkWidth = Math.max(10, panelWidth - labelWidth - 14);
          return entries.map(([name, values]) => {
            const color = METRIC_COLORS[nameHash(name) % METRIC_COLORS.length];
            const latest = values.length > 0
              ? values[values.length - 1]
              : null;
            const formatted = latest !== null
              ? formatMetricValue(latest)
              : "—";

            return (
              <Box key={name} paddingLeft={1}>
                <Text color={color}>
                  {name.padEnd(labelWidth)}
                </Text>
                <Text color={color}>{sparkline(values, adjSparkWidth)}</Text>
                <Text color={C.text}>
                  {" "}{formatted}
                </Text>
              </Box>
            );
          });
        })()
      )}
    </Box>
  );
}

export function sparkline(values: number[], width = 40): string {
  if (values.length === 0) return "";

  const blocks = [
    "\u2581",
    "\u2582",
    "\u2583",
    "\u2584",
    "\u2585",
    "\u2586",
    "\u2587",
    "\u2588",
  ];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const step = Math.max(1, Math.floor(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    sampled.push(values[i]);
    if (sampled.length >= width) break;
  }

  return sampled
    .map((v) => {
      const idx = Math.round(
        ((v - min) / range) * (blocks.length - 1),
      );
      return blocks[idx];
    })
    .join("");
}

