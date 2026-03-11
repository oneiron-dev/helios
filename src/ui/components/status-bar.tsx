import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { C, G } from "../theme.js";
import { formatDuration, truncate } from "../format.js";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { SleepManager } from "../../scheduler/sleep-manager.js";
import type { MonitorManager } from "../../core/monitor.js";

interface StatusBarProps {
  orchestrator: Orchestrator;
  sleepManager?: SleepManager;
  monitorManager?: MonitorManager;
}

const SLEEP_FRAMES = ["◇", "◆", "◇", "◇"];

export function StatusBar({ orchestrator, sleepManager, monitorManager }: StatusBarProps) {
  const state = orchestrator.currentState;
  const provider = orchestrator.currentProvider;
  const model = orchestrator.currentModel;
  const reasoning = orchestrator.reasoningEffort;
  const cost = orchestrator.totalCostUsd;

  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const sleeping = sleepManager?.isSleeping;
  const sleepSession = sleepManager?.currentSleep;

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

  const stateColor = {
    idle: C.dim,
    active: C.primary,
    sleeping: C.primary,
    waiting: C.dim,
    error: C.error,
  }[state] ?? C.dim;

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

      {sleeping && sleepSession && (() => {
        // Calculate how many chars are left for the sleep reason
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
      })()}

      {monitorManager?.isActive && monitorManager.currentConfig && (
        <>
          <Text color={C.dim}>{" "}{G.dash}{" "}</Text>
          <Text color={C.success}>⟳ </Text>
          <Text color={C.dim}>
            monitoring ({Math.round(monitorManager.currentConfig.intervalMs / 60_000)}m)
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
}
