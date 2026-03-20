import { useState, useEffect, memo } from "react";
import { Box, Text } from "ink";
import { C, G } from "../theme.js";
import { formatDuration, truncate } from "../format.js";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { SleepManager } from "../../scheduler/sleep-manager.js";
import type { MonitorManager } from "../../core/monitor.js";
import type { ProseRun } from "../../prose/types.js";
import type { ExperimentSummary } from "../../experiments/types.js";

interface StatusBarProps {
  orchestrator: Orchestrator;
  sleepManager?: SleepManager;
  monitorManager?: MonitorManager;
  isStreaming?: boolean;
  streamingStartedAt?: number | null;
  proseRuns?: ProseRun[];
  experimentSummary?: ExperimentSummary | null;
}

const SLEEP_FRAMES = ["◇", "◆", "◇", "◇"];

const STATE_COLOR: Record<string, string> = {
  idle: C.dim,
  active: C.primary,
  sleeping: C.primary,
  waiting: C.dim,
  error: C.error,
};

export const StatusBar = memo(function StatusBar({ orchestrator, sleepManager, monitorManager, isStreaming, streamingStartedAt, proseRuns, experimentSummary }: StatusBarProps) {
  const state = orchestrator.currentState;
  const provider = orchestrator.currentProvider;
  const model = orchestrator.currentModel;
  const reasoning = orchestrator.reasoningEffort;
  const cost = orchestrator.totalCostUsd;

  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const sleeping = sleepManager?.isSleeping;
  const sleepSession = sleepManager?.currentSleep;

  const [workElapsed, setWorkElapsed] = useState(0);

  useEffect(() => {
    if (!sleeping) return;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SLEEP_FRAMES.length);
      if (sleepSession) {
        setElapsed(Date.now() - sleepSession.createdAt);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [sleeping, sleepSession]);

  useEffect(() => {
    if (!isStreaming || !streamingStartedAt) {
      setWorkElapsed(0);
      return;
    }
    setWorkElapsed(Date.now() - streamingStartedAt);
    const timer = setInterval(() => {
      setWorkElapsed(Date.now() - streamingStartedAt);
    }, 1000);
    return () => clearInterval(timer);
  }, [isStreaming, streamingStartedAt]);

  const stateColor = STATE_COLOR[state] ?? C.dim;

  return (
    <Box paddingX={1}>
      <Text color={C.primary}>{G.dot} </Text>
      <Text color={C.text}>
        {provider?.displayName ?? "—"}
      </Text>

      <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
      <Text color={C.text}>
        {model ?? "—"}
      </Text>

      <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
      <Text color={C.text}>
        {reasoning ?? "medium"}
      </Text>

      <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
      <Text color={stateColor}>
        {state}
      </Text>

      {isStreaming && workElapsed > 0 && (
        <>
          <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
          <Text color={C.primary}>⟡ </Text>
          <Text color={C.dim}>{formatDuration(workElapsed)}</Text>
        </>
      )}

      {sleeping && sleepSession && <SleepSegment
        provider={provider}
        model={model}
        reasoning={reasoning}
        state={state}
        frame={frame}
        elapsed={elapsed}
        sleepSession={sleepSession}
      />}

      {monitorManager?.isActive && monitorManager.currentConfig && (
        <>
          <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
          <Text color={C.success}>⟳ </Text>
          <Text color={C.dim}>
            monitoring ({Math.round(monitorManager.currentConfig.intervalMs / 60_000)}m)
          </Text>
        </>
      )}

      {proseRuns && proseRuns.length > 0 && <ProseSegment proseRuns={proseRuns} />}

      {experimentSummary && experimentSummary.totalCount > 0 && (
        <>
          <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
          <Text color={experimentSummary.activeCount > 0 ? C.primary : C.dim}>
            {G.dot} exp {experimentSummary.activeCount}/{experimentSummary.totalCount}
            {experimentSummary.bestScore !== null ? ` best:${experimentSummary.bestScore.toPrecision(4)}` : ""}
          </Text>
        </>
      )}

      {cost > 0 && (
        <>
          <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
          <Text color={C.dim}>${cost.toFixed(4)}</Text>
        </>
      )}
    </Box>
  );
});

interface SleepSegmentProps {
  provider: { displayName: string } | null | undefined;
  model: string | null | undefined;
  reasoning: string | null | undefined;
  state: string;
  frame: number;
  elapsed: number;
  sleepSession: { createdAt: number; trigger: { sleepReason: string } };
}

function SleepSegment({ provider, model, reasoning, state, frame, elapsed, sleepSession }: SleepSegmentProps) {
  const usedWidth = 2 /* paddingX */
    + 2 /* dot+space */
    + (provider?.displayName ?? "—").length
    + 3 /* dash */
    + (model ?? "—").length
    + 3 /* dash */
    + (reasoning ?? "medium").length
    + 3 /* dash */
    + state.length
    + 3 /* dash */
    + 2 /* frame+space */
    + formatDuration(elapsed).length
    + 1; /* leading space before reason */
  const termWidth = process.stdout.columns ?? 80;
  const maxReason = Math.max(10, termWidth - usedWidth - 12 /* cost/monitor slack */);

  return (
    <>
      <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
      <Text color={C.primary}>{SLEEP_FRAMES[frame]} </Text>
      <Text color={C.dim}>{formatDuration(elapsed)}</Text>
      <Text color={C.dim}> {truncate(sleepSession.trigger.sleepReason, maxReason, true)}</Text>
    </>
  );
}

function ProseSegment({ proseRuns }: { proseRuns: ProseRun[] }) {
  const active = proseRuns.filter(r => r.status === "running").length;
  return (
    <>
      <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
      <Text color={active > 0 ? C.primary : C.dim}>
        {G.active} prose {active}/{proseRuns.length}
      </Text>
    </>
  );
}
