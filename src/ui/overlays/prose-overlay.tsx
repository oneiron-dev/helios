import { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { C, G, statusGlyph, statusColor } from "../theme.js";
import { formatDuration } from "../format.js";
import { OverlayHeader } from "../components/overlay-header.js";
import type { ProseWatcher } from "../../prose/watcher.js";
import type { ProseRun } from "../../prose/types.js";

interface ProseOverlayProps {
  proseWatcher: ProseWatcher;
  width: number;
  height: number;
  onClose: () => void;
  focusRunId?: string;
}

type SubPane = "state" | "bindings" | "artifacts";

export function ProseOverlay({ proseWatcher, width, height, onClose, focusRunId }: ProseOverlayProps) {
  const [runs, setRuns] = useState<ProseRun[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [subPane, setSubPane] = useState<SubPane>("state");
  const scrollRef = useRef<ScrollViewRef>(null);

  const refresh = useCallback(() => {
    setRuns(proseWatcher.getRuns());
  }, [proseWatcher]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    proseWatcher.on("update", refresh);
    return () => {
      clearInterval(timer);
      proseWatcher.removeListener("update", refresh);
    };
  }, [proseWatcher, refresh]);

  // Focus on a specific run if requested
  useEffect(() => {
    if (focusRunId && runs.length > 0) {
      const idx = runs.findIndex((r) => r.id === focusRunId);
      if (idx >= 0) setSelectedIndex(idx);
    }
  }, [focusRunId, runs]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow && runs.length > 0) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    }
    if (key.downArrow && runs.length > 0) {
      setSelectedIndex((i) => Math.min(runs.length - 1, i + 1));
    }
    if (key.tab) {
      setSubPane((prev) => {
        const panes: SubPane[] = ["state", "bindings", "artifacts"];
        const idx = panes.indexOf(prev);
        return panes[(idx + 1) % panes.length];
      });
    }
  });

  // Clamp selection
  useEffect(() => {
    if (selectedIndex >= runs.length && runs.length > 0) {
      setSelectedIndex(runs.length - 1);
    }
  }, [runs.length, selectedIndex]);

  // Scroll to bottom on content change
  useEffect(() => {
    scrollRef.current?.scrollToBottom();
  }, [selectedIndex, subPane, runs]);

  const selected = runs[selectedIndex] ?? null;
  const listWidth = Math.min(30, Math.floor(width * 0.3));
  const bodyHeight = height - 1;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <OverlayHeader
        width={width}
        title="PROSE RUNS"
        hints="ESC close  ↑↓ select  Tab switch"
      />

      <Box flexGrow={1} flexShrink={1} height={bodyHeight}>
        {/* Run list */}
        <Box width={listWidth} flexDirection="column" flexShrink={0}>
          {runs.length === 0 ? (
            <Box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
              <Text color={C.dim}>no runs</Text>
              <Text color={C.dim} dimColor>prose run {"<file>"} to start</Text>
            </Box>
          ) : (
            runs.map((run, i) => {
              const isSelected = i === selectedIndex;
              const glyph = statusGlyph(run.status);
              const color = statusColor(run.status);
              const elapsed = formatDuration(Date.now() - run.startedAt);
              return (
                <Box key={run.id} paddingLeft={1} flexDirection="column">
                  <Box>
                    <Text color={isSelected ? C.bright : color} bold={isSelected} inverse={isSelected}>
                      {glyph} {run.id.slice(0, listWidth - 10)}
                    </Text>
                    <Text color={isSelected ? C.bright : C.dim} inverse={isSelected}>
                      {" "}{elapsed}
                    </Text>
                  </Box>
                  <Box paddingLeft={2}>
                    <Text color={C.dim} dimColor>{run.programName}</Text>
                  </Box>
                </Box>
              );
            })
          )}
        </Box>

        {/* Separator */}
        <Box width={1} flexDirection="column" flexShrink={0}>
          <Text color={C.primary}>
            {Array.from({ length: bodyHeight }, () => G.pipe).join("\n")}
          </Text>
        </Box>

        {/* Detail pane */}
        <Box flexGrow={1} flexShrink={1} flexDirection="column">
          {selected ? (
            <>
              {/* Detail header */}
              <Box flexShrink={0} paddingX={1}>
                <Text color={C.primary} bold>
                  {G.brand} run:{selected.id}
                </Text>
                <Text color={C.dim}>
                  {" "}{G.dash} {subPane}
                </Text>
              </Box>

              {/* Detail content */}
              <Box flexGrow={1} flexShrink={1}>
                <ScrollView ref={scrollRef}>
                  <Box paddingX={1} flexDirection="column">
                    {subPane === "state" && <StateView run={selected} />}
                    {subPane === "bindings" && <BindingsView run={selected} />}
                    {subPane === "artifacts" && <ArtifactsView run={selected} />}
                  </Box>
                </ScrollView>
              </Box>
            </>
          ) : (
            <Box flexGrow={1} alignItems="center" justifyContent="center">
              <Text color={C.dim}>select a run</Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function StateView({ run }: { run: ProseRun }) {
  return (
    <>
      {run.steps.map((step) => {
        const glyph = statusGlyph(step.status);
        const color = statusColor(step.status);
        return (
          <Box key={step.number} flexDirection="column">
            <Text>
              <Text color={color}>{glyph}</Text>
              <Text color={C.dim}> {String(step.number).padStart(2)}{G.dash}{">"} </Text>
              <Text color={stepLabelColor(step.status)}>
                {step.label}
              </Text>
              {step.status === "complete" && <Text color={C.success}> {G.check}</Text>}
            </Text>
            {step.substeps && (
              <Box paddingLeft={5} flexDirection="column">
                {step.substeps.map((sub) => (
                  <Text key={sub} color={C.dim}>
                    {G.branch} {sub}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        );
      })}
      <RunStatusFooter run={run} />
    </>
  );
}

function stepLabelColor(status: string): string {
  if (status === "running") return C.primary;
  if (status === "complete") return C.success;
  return C.text;
}

function RunStatusFooter({ run }: { run: ProseRun }) {
  if (run.status === "running") return null;

  const FOOTER: Record<string, { color: string; text: string }> = {
    error: { color: C.error, text: run.lastLine },
    done: { color: C.success, text: run.lastLine },
    stalled: { color: "magenta", text: "stalled — no update for 5+ minutes" },
  };

  const entry = FOOTER[run.status];
  if (!entry) return null;

  return (
    <Box marginTop={1}>
      <Text color={entry.color}>{statusGlyph(run.status)} {entry.text}</Text>
    </Box>
  );
}

function BindingsView({ run }: { run: ProseRun }) {
  if (run.candidateCount === 0) {
    return <Text color={C.dim}>no bindings</Text>;
  }
  return (
    <Text color={C.text}>
      {run.candidateCount} candidate{run.candidateCount !== 1 ? "s" : ""} bound
    </Text>
  );
}

function ArtifactsView({ run }: { run: ProseRun }) {
  return (
    <>
      <Text color={C.dim}>Program: {run.programPath || "—"}</Text>
      <Text color={C.dim}>Started: {new Date(run.startedAt).toLocaleString()}</Text>
      <Text color={C.dim}>Updated: {new Date(run.updatedAt).toLocaleString()}</Text>
      {run.pid && <Text color={C.dim}>PID: {run.pid}</Text>}
    </>
  );
}
