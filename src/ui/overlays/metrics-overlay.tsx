import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { ScrollView } from "ink-scroll-view";
import asciichart from "asciichart";
import { C, G, METRIC_COLORS, nameHash } from "../theme.js";
import { formatMetricValue } from "../format.js";
import { sparkline } from "../panels/metrics-dashboard.js";
import { OverlayHeader } from "../components/overlay-header.js";
import { analyzeMetric } from "../../metrics/analyzer.js";
import type { MetricStore } from "../../metrics/store.js";

const TREND_ICONS: Record<string, string> = {
  decreasing: "↓",
  increasing: "↑",
  plateau: "→",
  unstable: "~",
  insufficient_data: "?",
};

interface MetricsOverlayProps {
  metricData: Map<string, number[]>;
  metricStore?: MetricStore;
  width: number;
  height: number;
  onClose: () => void;
}

export function MetricsOverlay({ metricData, metricStore, width, height, onClose }: MetricsOverlayProps) {
  const entries = Array.from(metricData.entries());
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow && entries.length > 0) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    }
    if (key.downArrow && entries.length > 0) {
      setSelectedIndex((i) => Math.min(entries.length - 1, i + 1));
    }
  });

  useEffect(() => {
    if (selectedIndex >= entries.length && entries.length > 0) {
      setSelectedIndex(entries.length - 1);
    }
  }, [entries.length]);

  const bodyHeight = height - 1;
  const chartWidth = Math.max(20, width - 16); // 16 for y-axis labels + padding

  return (
    <Box flexDirection="column" width={width} height={height}>
      <OverlayHeader width={width} title="METRICS" hints="ESC close  ↑↓ select" />

      <Box flexGrow={1} flexShrink={1}>
        {entries.length === 0 ? (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text color={C.dim}>no metrics recorded</Text>
          </Box>
        ) : (
          <ScrollView>
            <Box flexDirection="column" paddingX={1}>
              {entries.map(([name, values], i) => {
                const isSelected = i === selectedIndex;
                const color = METRIC_COLORS[nameHash(name) % METRIC_COLORS.length] as string;

                // Get richer data from store if available
                const series = metricStore
                  ? metricStore.getSeriesAcrossTasks(name, 300)
                  : values.map((v, j) => ({ metricName: name, value: v, timestamp: j }));
                const analysis = analyzeMetric(series);
                const richValues = series.map((p) => p.value);

                const latest = richValues.length > 0 ? richValues[richValues.length - 1] : null;
                const min = richValues.length > 0 ? Math.min(...richValues) : null;
                const max = richValues.length > 0 ? Math.max(...richValues) : null;
                const trendIcon = TREND_ICONS[analysis.trend] ?? "?";

                const sparkWidth = Math.max(10, width - name.length - 4);

                return (
                  <Box key={name} flexDirection="column" marginBottom={isSelected ? 1 : 0}>
                    {/* Name + sparkline */}
                    <Box paddingLeft={1}>
                      <Text color={color} bold={isSelected}>
                        {isSelected ? G.active : " "} {name}
                      </Text>
                      <Text color={color}> {sparkline(richValues, Math.min(sparkWidth, 60))}</Text>
                    </Box>

                    {/* Stats line */}
                    <Box paddingLeft={3}>
                      <Text color={C.text}>
                        {latest !== null ? formatMetricValue(latest) : "—"}
                      </Text>
                      <Text color={C.dim}>
                        {"  "}min {min !== null ? formatMetricValue(min) : "—"}
                        {"  "}max {max !== null ? formatMetricValue(max) : "—"}
                        {"  "}σ {formatMetricValue(analysis.stdDev)}
                      </Text>
                      <Text color={C.primary}>
                        {"  "}{trendIcon} {analysis.trend}
                      </Text>
                    </Box>

                    {/* Expanded chart for selected metric */}
                    {isSelected && richValues.length >= 2 && (
                      <Box paddingLeft={3} marginTop={0}>
                        <Text color={color}>
                          {renderChart(richValues, chartWidth, 8)}
                        </Text>
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          </ScrollView>
        )}
      </Box>
    </Box>
  );
}

function renderChart(values: number[], width: number, chartHeight: number): string {
  // Downsample if we have more points than chart width
  let sampled = values;
  if (values.length > width) {
    const step = values.length / width;
    sampled = [];
    for (let i = 0; i < width; i++) {
      sampled.push(values[Math.floor(i * step)]);
    }
  }

  try {
    // Pre-compute label width from the data range so all rows align
    const min = Math.min(...sampled);
    const max = Math.max(...sampled);
    const step = (max - min) / chartHeight;
    let maxLen = 0;
    for (let i = 0; i <= chartHeight; i++) {
      maxLen = Math.max(maxLen, formatMetricValue(min + step * i).length);
    }
    const pad = Math.max(maxLen, 6);

    return asciichart.plot(sampled, {
      height: chartHeight,
      format: (v: number) => formatMetricValue(v).padStart(pad),
    });
  } catch {
    return "(chart unavailable)";
  }
}

