import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { C, G, statusGlyph, statusColor } from "../theme.js";
import { OverlayHeader } from "../components/overlay-header.js";
import { sparkline } from "../panels/metrics-dashboard.js";
import { executeAction } from "../../experiments/action-executor.js";
import { formatError } from "../format.js";
import { buildForest, flattenForest, type FlatTreeRow } from "../../experiments/lineage.js";
import type { ExperimentAdapter, Experiment, ColumnDef, OperatorAction } from "../../experiments/types.js";
import type { RemoteExecutor } from "../../remote/executor.js";

interface ExperimentsOverlayProps {
  adapter: ExperimentAdapter;
  executor?: RemoteExecutor;
  width: number;
  height: number;
  onClose: () => void;
}

type ViewMode = "table" | "loom";

export function ExperimentsOverlay({ adapter, executor, width, height, onClose }: ExperimentsOverlayProps) {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [showDetail, setShowDetail] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    action: OperatorAction;
    experiment: Experiment;
  } | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const scrollRef = useRef<ScrollViewRef>(null);

  const refresh = useCallback(async () => {
    const exps = await adapter.load();
    setExperiments(exps);
  }, [adapter]);

  useEffect(() => {
    refresh();
    adapter.onUpdate(() => refresh());
    adapter.startPolling(5000);
    return () => adapter.stopPolling();
  }, [adapter, refresh]);

  // Compute loom tree
  const lineage = useMemo(() => adapter.getLineage?.() ?? [], [adapter, experiments]);
  const flatRows = useMemo(() => {
    const roots = buildForest(experiments, lineage.length > 0 ? lineage : undefined);
    return flattenForest(roots);
  }, [experiments, lineage]);

  // Derive display list and selection index from selectedId
  const displayList = viewMode === "loom" ? flatRows.map((r) => r.experiment) : experiments;
  const selectedIndex = selectedId ? displayList.findIndex((e) => e.id === selectedId) : 0;
  const clampedIndex = Math.max(0, Math.min(selectedIndex >= 0 ? selectedIndex : 0, displayList.length - 1));
  const selected = displayList[clampedIndex] ?? null;

  useInput((input, key) => {
    // Confirmation mode: consume all input
    if (pendingAction) {
      if (input === "y") {
        const { action, experiment } = pendingAction;
        setPendingAction(null);
        if (executor) {
          executeAction(action, experiment, executor)
            .then(() => setActionMessage(`${action.label} started for "${experiment.id}"`))
            .catch((err) => setActionMessage(`error: ${formatError(err)}`));
        }
        return;
      }
      if (input === "n" || key.escape) {
        setPendingAction(null);
        return;
      }
      return;
    }

    if (key.tab) {
      setViewMode((prev) => (prev === "table" ? "loom" : "table"));
      return;
    }
    if (key.escape) {
      if (showDetail) {
        setShowDetail(false);
        return;
      }
      onClose();
      return;
    }
    if (key.upArrow && displayList.length > 0) {
      const newIndex = Math.max(0, clampedIndex - 1);
      setSelectedId(displayList[newIndex]?.id ?? null);
    }
    if (key.downArrow && displayList.length > 0) {
      const newIndex = Math.min(displayList.length - 1, clampedIndex + 1);
      setSelectedId(displayList[newIndex]?.id ?? null);
    }
    if (key.return) {
      setShowDetail((prev) => !prev);
    }
    if (input === "a" && selected && executor) {
      const actions = adapter.getActions().filter(
        (act) => !act.appliesTo || act.appliesTo(selected),
      );
      if (actions.length === 0) return;
      const action = actions[0];
      if (action.confirmRequired) {
        setPendingAction({ action, experiment: selected });
      } else {
        executeAction(action, selected, executor)
          .then(() => setActionMessage(`${action.label} started for "${selected.id}"`))
          .catch((err) => setActionMessage(`error: ${formatError(err)}`));
      }
    }
  });

  // Clamp selection when list changes
  useEffect(() => {
    if (displayList.length > 0 && clampedIndex >= displayList.length) {
      setSelectedId(displayList[displayList.length - 1]?.id ?? null);
    }
  }, [displayList.length, clampedIndex]);

  // Clear action message after 5 seconds
  useEffect(() => {
    if (!actionMessage) return;
    const timer = setTimeout(() => setActionMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [actionMessage]);

  const summary = adapter.getSummary();
  const columns = adapter.getColumns(width - 4);
  const bodyHeight = height - 4; // header + summary + sparkline + pad

  return (
    <Box flexDirection="column" width={width} height={height}>
      <OverlayHeader
        width={width}
        title="EXPERIMENTS"
        hints="ESC close  ↑↓ select  Enter detail  a action  Tab table/loom"
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
        {viewMode === "table" ? (
          <ExperimentsBody
            experiments={experiments}
            showDetail={showDetail}
            selected={selected}
            adapter={adapter}
            columns={columns}
            selectedIndex={clampedIndex}
            scrollRef={scrollRef}
            width={width}
          />
        ) : (
          <LoomBody
            flatRows={flatRows}
            showDetail={showDetail}
            selected={selected}
            adapter={adapter}
            selectedIndex={clampedIndex}
            scrollRef={scrollRef}
            width={width}
          />
        )}
      </Box>

      {/* Confirmation bar / action message */}
      {pendingAction && (
        <Box flexShrink={0} paddingX={1}>
          <Text color={C.bright} bold>
            {pendingAction.action.label} &quot;{pendingAction.experiment.id}&quot;? [y]es / [n]o
          </Text>
        </Box>
      )}
      {actionMessage && !pendingAction && (
        <Box flexShrink={0} paddingX={1}>
          <Text color={C.dim}>{actionMessage}</Text>
        </Box>
      )}
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

function LoomBody({
  flatRows,
  showDetail,
  selected,
  adapter,
  selectedIndex,
  scrollRef,
  width,
}: {
  flatRows: FlatTreeRow[];
  showDetail: boolean;
  selected: Experiment | null;
  adapter: ExperimentAdapter;
  selectedIndex: number;
  scrollRef: React.RefObject<ScrollViewRef | null>;
  width: number;
}) {
  if (flatRows.length === 0) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text color={C.dim}>no lineage data</Text>
      </Box>
    );
  }

  if (showDetail && selected) {
    return <DetailView adapter={adapter} experiment={selected} width={width} />;
  }

  return (
    <ScrollView ref={scrollRef}>
      <Box flexDirection="column" paddingX={1}>
        {flatRows.map((row, i) => (
          <LoomRow key={row.experiment.id} row={row} isSelected={i === selectedIndex} width={width} />
        ))}
      </Box>
    </ScrollView>
  );
}

function LoomRow({ row, isSelected, width }: {
  row: FlatTreeRow;
  isSelected: boolean;
  width: number;
}) {
  const { experiment: exp, connectors } = row;
  const glyph = statusGlyph(exp.status);
  const color = statusColor(exp.status);
  const score = exp.compositeScore !== null ? exp.compositeScore.toFixed(2) : "";
  const label = exp.branchLabel ?? exp.description;
  const idWidth = Math.min(24, Math.max(12, Math.floor(width * 0.25)));
  const id = exp.id.length > idWidth ? exp.id.slice(0, idWidth - 1) + "\u2026" : exp.id.padEnd(idWidth);

  return (
    <Box>
      <Text color={C.dim}>{connectors}</Text>
      <Text color={isSelected ? C.bright : color} bold={isSelected} inverse={isSelected}>
        {glyph} {id}
      </Text>
      {score && <Text color={isSelected ? C.bright : C.primary}> {score}</Text>}
      <Text color={C.dim}> {label}</Text>
    </Box>
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
