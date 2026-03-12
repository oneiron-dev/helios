import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { C, G, statusGlyph, statusColor } from "../theme.js";
import { OverlayHeader } from "../components/overlay-header.js";
import { sparkline } from "../panels/metrics-dashboard.js";
import type { ExperimentAdapter, Experiment, ColumnDef } from "../../experiments/types.js";

interface ExperimentsOverlayProps {
  adapter: ExperimentAdapter;
  width: number;
  height: number;
  onClose: () => void;
}

export function ExperimentsOverlay({ adapter, width, height, onClose }: ExperimentsOverlayProps) {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const scrollRef = useRef<ScrollViewRef>(null);

  const refresh = useCallback(async () => {
    const exps = await adapter.load();
    setExperiments(exps);
  }, [adapter]);

  useEffect(() => {
    refresh();
    const unsubscribe = adapter.onUpdate(() => { void refresh(); });
    return unsubscribe;
  }, [adapter, refresh]);

  useInput((input, key) => {
    if (key.escape) {
      if (showDetail) {
        setShowDetail(false);
        return;
      }
      onClose();
      return;
    }
    if (key.upArrow && experiments.length > 0) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    }
    if (key.downArrow && experiments.length > 0) {
      setSelectedIndex((i) => Math.min(experiments.length - 1, i + 1));
    }
    if (key.return) {
      setShowDetail((prev) => !prev);
    }
  });

  useEffect(() => {
    if (selectedIndex >= experiments.length && experiments.length > 0) {
      setSelectedIndex(experiments.length - 1);
    }
  }, [experiments.length, selectedIndex]);

  const selected = experiments[selectedIndex] ?? null;
  const summary = adapter.getSummary();
  const columns = adapter.getColumns(width - 4);
  const bodyHeight = height - 4; // header + summary + sparkline + pad

  return (
    <Box flexDirection="column" width={width} height={height}>
      <OverlayHeader
        width={width}
        title="EXPERIMENTS"
        hints="ESC close  ↑↓ select  Enter detail"
      />

      {/* Summary line */}
      <Box flexShrink={0} paddingX={1}>
        <Text color={C.primary} bold>{summary.label}</Text>
        {summary.stats.map((stat) => (
          <Text key={stat.key}>
            <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
            <Text color={C.dim}>{stat.key}: </Text>
            <Text color={C.text}>{stat.value}</Text>
          </Text>
        ))}
        {summary.bestScore !== null && (
          <>
            <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
            <Text color={C.success}>best: {summary.bestScore.toFixed(2)}</Text>
          </>
        )}
      </Box>

      {/* Score trajectory sparkline */}
      {experiments.length > 1 && (
        <Box flexShrink={0} paddingX={1}>
          <Text color={C.primary}>
            {sparkline(
              experiments
                .filter((e) => e.compositeScore !== null)
                .map((e) => e.compositeScore!),
              Math.min(width - 4, 50),
            )}
          </Text>
          <Text color={C.dim}> score trajectory</Text>
        </Box>
      )}

      {/* Main content */}
      <Box flexGrow={1} flexShrink={1} height={bodyHeight}>
        <ExperimentsBody
          experiments={experiments}
          showDetail={showDetail}
          selected={selected}
          adapter={adapter}
          columns={columns}
          selectedIndex={selectedIndex}
          scrollRef={scrollRef}
          width={width}
        />
      </Box>
    </Box>
  );
}

function ExperimentsBody({
  experiments,
  showDetail,
  selected,
  adapter,
  columns,
  selectedIndex,
  scrollRef,
  width,
}: {
  experiments: Experiment[];
  showDetail: boolean;
  selected: Experiment | null;
  adapter: ExperimentAdapter;
  columns: ColumnDef[];
  selectedIndex: number;
  scrollRef: React.RefObject<ScrollViewRef | null>;
  width: number;
}) {
  if (experiments.length === 0) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text color={C.dim}>no experiments found</Text>
      </Box>
    );
  }

  if (showDetail && selected) {
    return <DetailView adapter={adapter} experiment={selected} width={width} />;
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Column headers */}
      <Box flexShrink={0} paddingX={1}>
        <Text color={C.dim} bold>
          {" "}
          {columns.map((col) => formatColumnHeader(col)).join(" ")}
        </Text>
      </Box>

      {/* Experiment rows */}
      <ScrollView ref={scrollRef}>
        <Box flexDirection="column" paddingX={1}>
          {experiments.map((exp, i) => (
            <ExperimentRow
              key={exp.id}
              experiment={exp}
              columns={columns}
              isSelected={i === selectedIndex}
            />
          ))}
        </Box>
      </ScrollView>
    </Box>
  );
}

function ExperimentRow({
  experiment,
  columns,
  isSelected,
}: {
  experiment: Experiment;
  columns: ColumnDef[];
  isSelected: boolean;
}) {
  const glyph = statusGlyph(experiment.status);
  const color = statusColor(experiment.status);

  return (
    <Box>
      <Text color={isSelected ? C.bright : color} bold={isSelected} inverse={isSelected}>
        {glyph}
      </Text>
      <Text inverse={isSelected}>
        {columns.map((col) => {
          const raw = resolveColumnValue(col.key, experiment);
          const formatted = col.format ? col.format(raw) : formatValue(raw);
          const cellColor = col.color ? col.color(raw) : isSelected ? C.bright : C.text;
          const aligned = alignText(formatted, col.width, col.align);

          return (
            <Text key={col.key} color={cellColor}>
              {" "}{aligned}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}

function DetailView({
  adapter,
  experiment,
  width,
}: {
  adapter: ExperimentAdapter;
  experiment: Experiment;
  width: number;
}) {
  const detail = adapter.getDetail(experiment.id);

  return (
    <ScrollView>
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text color={C.primary} bold>
            {G.brand} {experiment.id}
          </Text>
          <Text color={statusColor(experiment.status)}>
            {" "}{statusGlyph(experiment.status)} {experiment.status}
          </Text>
          {experiment.compositeScore !== null && (
            <Text color={C.text}> score: {experiment.compositeScore.toFixed(4)}</Text>
          )}
        </Box>

        {detail.sections.map((section, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text color={C.primary} bold>{section.title}</Text>
            <Text color={C.text} wrap="wrap">{section.content}</Text>
          </Box>
        ))}
      </Box>
    </ScrollView>
  );
}

// ─── Helpers ─────────────────────────────────────────

function resolveColumnValue(key: string, experiment: Experiment): unknown {
  if (key === "status") return experiment.status;
  if (key === "compositeScore") return experiment.compositeScore;
  if (key in experiment.metrics) return experiment.metrics[key];
  return (experiment.metadata[key] as unknown) ?? null;
}

function formatColumnHeader(col: ColumnDef): string {
  return alignText(col.label, col.width, col.align);
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toFixed(2);
  return String(v);
}

function alignText(text: string, width: number, align: "left" | "right" | "center"): string {
  const truncated = text.length > width ? text.slice(0, width - 1) + "…" : text;
  if (align === "right") return truncated.padStart(width);
  if (align === "center") {
    const pad = Math.max(0, width - truncated.length);
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + truncated + " ".repeat(pad - left);
  }
  return truncated.padEnd(width);
}
