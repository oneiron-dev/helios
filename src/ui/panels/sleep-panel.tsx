import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { C, G } from "../theme.js";
import { formatDuration } from "../format.js";
import type { SleepManager } from "../../scheduler/sleep-manager.js";
import type { TriggerExpression } from "../../scheduler/triggers/types.js";

interface SleepPanelProps {
  sleepManager: SleepManager;
}

export function SleepPanel({ sleepManager }: SleepPanelProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const session = sleepManager.currentSleep;
  if (!session) return null;

  const elapsed = now - session.createdAt;
  const elapsedStr = formatDuration(elapsed);
  const deadline = session.trigger.deadline;
  const remaining = deadline ? deadline - now : null;

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
      paddingX={2}
    >
      <Text color={C.primary} bold>
        {G.brand} SLEEPING
      </Text>
      <Text color={C.dim}>
        {session.trigger.sleepReason}
      </Text>
      <Text color={C.primary}>
        elapsed {elapsedStr}
      </Text>
      {remaining !== null && remaining > 0 && (
        <Text color={C.primary}>
          wake in {formatDuration(remaining)}
        </Text>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={C.primary} bold>triggers:</Text>
        <TriggerDisplay
          expression={session.trigger.expression}
          satisfiedLeaves={session.trigger.satisfiedLeaves}
          path="root"
        />
      </Box>

      <Box marginTop={1}>
        <Text color={C.dim} dimColor>
          type to wake manually
        </Text>
      </Box>
    </Box>
  );
}

function TriggerDisplay({
  expression,
  satisfiedLeaves,
  path,
}: {
  expression: TriggerExpression;
  satisfiedLeaves: Set<string>;
  path: string;
}) {
  if ("op" in expression) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color={C.dim}>
          {expression.op.toUpperCase()}:
        </Text>
        {expression.children.map((child, i) => (
          <TriggerDisplay
            key={i}
            expression={child}
            satisfiedLeaves={satisfiedLeaves}
            path={`${path}.${i}`}
          />
        ))}
      </Box>
    );
  }

  const satisfied = satisfiedLeaves.has(path);
  const icon = satisfied ? G.dot : G.dotDim;
  const color = satisfied ? C.success : C.dim;

  return (
    <Box paddingLeft={2}>
      <Text color={color}>
        {icon} {describeCondition(expression)}
      </Text>
    </Box>
  );
}

function describeCondition(expr: TriggerExpression): string {
  if ("op" in expr) return `${expr.op}(...)`;

  switch (expr.kind) {
    case "timer":
      return `timer: ${new Date(expr.wakeAt).toLocaleTimeString()}`;
    case "process_exit":
      return `process: ${expr.processPattern ?? `PID ${expr.pid}`} on ${expr.machineId}`;
    case "metric":
      return `metric: ${expr.field} ${expr.comparator} ${expr.threshold}`;
    case "file":
      return `file ${expr.mode}: ${expr.path} on ${expr.machineId}`;
    case "resource":
      return `resource: ${expr.resource} ${expr.comparator} ${expr.threshold}%`;
    case "user_message":
      return "user message";
  }
}

