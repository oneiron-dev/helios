import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { C, G, METRIC_COLORS, nameHash } from "../theme.js";
import { renderMarkdown } from "../markdown.js";
import { sparkline } from "./metrics-dashboard.js";
import { truncate, formatMetricValue } from "../format.js";
import type { Message, ToolData } from "../types.js";

interface ConversationPanelProps {
  messages: Message[];
  isStreaming: boolean;
}

export function ConversationPanel({
  messages,
  isStreaming,
}: ConversationPanelProps) {
  if (messages.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} paddingBottom={1}>
      {messages.map((msg) => (
        <MessageLine key={msg.id} message={msg} />
      ))}
      {isStreaming && (
        <Box paddingLeft={2}>
          <PulsingIndicator />
        </Box>
      )}
    </Box>
  );
}

function MessageLine({ message }: { message: Message }) {
  const { role, content, tool } = message;

  switch (role) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text wrap="wrap">
            <Text color={C.primary} bold>{G.active} </Text>
            <Text color={C.text}>{content}</Text>
          </Text>
        </Box>
      );

    case "assistant":
      return (
        <Box paddingLeft={2}>
          <Text wrap="wrap">{renderMarkdown(content)}</Text>
        </Box>
      );

    case "tool":
      return tool ? <ToolCallBlock tool={tool} /> : null;

    case "error":
      return (
        <Box paddingLeft={2}>
          <Text wrap="wrap" color={C.error}>{G.active} {content}</Text>
        </Box>
      );

    case "system":
      return (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={C.primary} dimColor wrap="wrap">{content}</Text>
        </Box>
      );

    default:
      return (
        <Box paddingLeft={2}>
          <Text wrap="wrap">{content}</Text>
        </Box>
      );
  }
}

const PULSE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function PulsingIndicator() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % PULSE_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);
  return <Text color={C.primary}>{PULSE_FRAMES[frame]}</Text>;
}

// ── Tool call routing ────────────────────────────────────────────────

function ToolCallBlock({ tool }: { tool: ToolData }) {
  switch (tool.name) {
    case "remote_exec":
      return <ExecDisplay tool={tool} />;
    case "remote_exec_background":
      return <ExecBackgroundDisplay tool={tool} />;
    case "remote_upload":
    case "remote_download":
      return <FileSyncDisplay tool={tool} />;
    case "sleep":
      return <SleepDisplay tool={tool} />;
    case "start_monitor":
      return <MonitorDisplay tool={tool} />;
    case "stop_monitor":
      return <MonitorStopDisplay tool={tool} />;
    case "task_output":
      return <TaskOutputDisplay tool={tool} />;
    case "list_machines":
      return <ListMachinesDisplay tool={tool} />;
    case "show_metrics":
      return <ShowMetricsDisplay tool={tool} />;
    case "compare_runs":
      return <CompareRunsDisplay tool={tool} />;
    default:
      return <GenericToolDisplay tool={tool} />;
  }
}

// ── Shared helpers ───────────────────────────────────────────────────

function ToolHeader({ icon, label, detail }: { icon: string; label: string; detail?: string }) {
  return (
    <Box>
      <Text wrap="wrap">
        <Text color={C.primary} dimColor>{"┃ "}</Text>
        <Text color={C.bright} bold>{icon} {label}</Text>
        {detail ? <Text color={C.dim}> {detail}</Text> : null}
      </Text>
    </Box>
  );
}

function parseResult(tool: ToolData): Record<string, unknown> | null {
  if (!tool.result) return null;
  try {
    return JSON.parse(tool.result);
  } catch {
    return null;
  }
}

// ── remote_exec ──────────────────────────────────────────────────────

function ExecDisplay({ tool }: { tool: ToolData }) {
  const machine = (tool.args.machine_id as string) ?? "?";
  const command = (tool.args.command as string) ?? "";
  const result = parseResult(tool);
  const stdout = result?.stdout as string | undefined;
  const stderr = result?.stderr as string | undefined;
  const exitCode = result?.exit_code as number | undefined;
  const hasOutput = stdout || stderr;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon="$" label={machine} detail={command} />
      {tool.result && (
        <Box flexDirection="column" paddingLeft={2}>
          {stdout ? (
            <Box>
              <Text color={C.dim} dimColor>{"┃ "}</Text>
              <Text color={C.text} wrap="wrap">{trimOutput(stdout, 20)}</Text>
            </Box>
          ) : null}
          {stderr ? (
            <Box>
              <Text color={C.dim} dimColor>{"┃ "}</Text>
              <Text color={C.error} wrap="wrap">{trimOutput(stderr, 5)}</Text>
            </Box>
          ) : null}
          {exitCode !== undefined && exitCode !== 0 ? (
            <Box>
              <Text color={C.dim} dimColor>{"┃ "}</Text>
              <Text color={C.error}>exit {exitCode}</Text>
            </Box>
          ) : null}
          {!hasOutput && exitCode === 0 ? (
            <Box>
              <Text color={C.dim} dimColor>{"┃ "}</Text>
              <Text color={C.dim}>ok</Text>
            </Box>
          ) : null}
        </Box>
      )}
      {!tool.result && (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.dim}>running…</Text>
        </Box>
      )}
    </Box>
  );
}

function trimOutput(text: string, maxLines: number): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= maxLines) return text.trimEnd();
  const kept = lines.slice(-maxLines);
  return `… ${lines.length - maxLines} lines hidden …\n${kept.join("\n")}`;
}

// ── remote_exec_background ───────────────────────────────────────────

function ExecBackgroundDisplay({ tool }: { tool: ToolData }) {
  const machine = (tool.args.machine_id as string) ?? "?";
  const command = (tool.args.command as string) ?? "";
  const result = parseResult(tool);
  const pid = result?.pid as number | undefined;
  const logPath = result?.log_path as string | undefined;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon="&" label={machine} detail={command} />
      {result && (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.dim}>pid </Text>
          <Text color={C.text}>{pid}</Text>
          {logPath ? (
            <Text color={C.dim}> → {logPath}</Text>
          ) : null}
        </Box>
      )}
      {!tool.result && (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.dim}>launching…</Text>
        </Box>
      )}
    </Box>
  );
}

// ── remote_upload / remote_download ──────────────────────────────────

function FileSyncDisplay({ tool }: { tool: ToolData }) {
  const isUpload = tool.name === "remote_upload";
  const icon = isUpload ? "↑" : "↓";
  const machine = (tool.args.machine_id as string) ?? "?";
  const local = (tool.args.local_path as string) ?? "";
  const remote = (tool.args.remote_path as string) ?? "";
  const label = isUpload ? `${local} → ${machine}:${remote}` : `${machine}:${remote} → ${local}`;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon={icon} label={tool.name.replace("remote_", "")} detail={label} />
      {tool.result && (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={tool.isError ? C.error : C.dim}>{truncate(tool.result, 80)}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── sleep ────────────────────────────────────────────────────────────

function SleepDisplay({ tool }: { tool: ToolData }) {
  const reason = (tool.args.reason as string) ?? "";
  const result = parseResult(tool);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon="◇" label="sleep" detail={truncate(reason, 60)} />
      {result && !tool.isError && (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.dim}>
            session {String(result.session_id ?? "?").slice(0, 8)}
            {result.deadline ? ` deadline ${String(result.deadline)}` : ""}
          </Text>
        </Box>
      )}
      {tool.isError && tool.result && (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.error}>{truncate(tool.result, 80)}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── task_output ─────────────────────────────────────────────────────

function TaskOutputDisplay({ tool }: { tool: ToolData }) {
  const machine = (tool.args.machine_id as string) ?? "?";
  const pid = tool.args.pid as number;
  const result = parseResult(tool);
  const output = result?.output as string | undefined;
  const running = result?.running as boolean | undefined;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader
        icon="⊳"
        label={`${machine}:${pid}`}
        detail={running !== undefined ? (running ? "running" : "stopped") : undefined}
      />
      {output ? (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.text} wrap="wrap">{trimOutput(output, 20)}</Text>
        </Box>
      ) : !tool.result ? (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.dim}>fetching…</Text>
        </Box>
      ) : result?.error ? (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.error}>{String(result.error)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── list_machines ────────────────────────────────────────────────────

function ListMachinesDisplay({ tool }: { tool: ToolData }) {
  const result = parseResult(tool);
  const machines = (result?.machines ?? []) as Array<{
    id: string;
    connected: boolean;
    error?: string;
  }>;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon="⊞" label="list_machines" />
      {machines.length > 0 ? (
        machines.map((m) => (
          <Box key={m.id} paddingLeft={2}>
            <Text color={C.dim} dimColor>{"┃ "}</Text>
            <Text color={m.connected ? C.primary : C.dim}>
              {m.connected ? "◆" : "◇"} {m.id}
            </Text>
            {m.error ? <Text color={C.error}> {m.error}</Text> : null}
          </Box>
        ))
      ) : !tool.result ? (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.dim}>fetching…</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── show_metrics ────────────────────────────────────────────────────

function ShowMetricsDisplay({ tool }: { tool: ToolData }) {
  const result = parseResult(tool);
  const metrics = (result?.metrics ?? []) as Array<{
    name: string;
    values: number[];
    latest: number | null;
    min: number | null;
    max: number | null;
    trend: string;
  }>;

  const trendIcon = (trend: string): string => {
    switch (trend) {
      case "decreasing": return "\u2193"; // ↓
      case "increasing": return "\u2191"; // ↑
      case "plateau": return "\u2192";   // →
      case "unstable": return "~";
      default: return "?";
    }
  };

  const trendColor = (trend: string): string => {
    switch (trend) {
      case "decreasing": return C.primary;
      case "increasing": return C.primary;
      case "plateau": return C.dim;
      default: return C.dim;
    }
  };

  const formatValue = (v: number | null): string =>
    v === null ? "\u2014" : formatMetricValue(v);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon="◈" label="show_metrics" />
      {metrics.length > 0 ? (
        metrics.map((m) => {
          const color = METRIC_COLORS[nameHash(m.name) % METRIC_COLORS.length];
          return (
            <Box key={m.name} flexDirection="column" paddingLeft={2}>
              <Box>
                <Text color={C.dim} dimColor>{"\u2503 "}</Text>
                <Text color={color} bold>{m.name}</Text>
                {m.values.length > 0 ? (
                  <Text color={color}>{" "}{sparkline(m.values, 30)}</Text>
                ) : null}
              </Box>
              {m.latest !== null ? (
                <Box>
                  <Text color={C.dim} dimColor>{"\u2503 "}</Text>
                  <Text color={C.text}>
                    {formatValue(m.latest)}
                  </Text>
                  <Text color={C.dim}>
                    {" "}min {formatValue(m.min)} max {formatValue(m.max)}
                  </Text>
                  <Text color={trendColor(m.trend)}>
                    {" "}{trendIcon(m.trend)} {m.trend}
                  </Text>
                </Box>
              ) : (
                <Box>
                  <Text color={C.dim} dimColor>{"\u2503 "}</Text>
                  <Text color={C.dim}>no data</Text>
                </Box>
              )}
            </Box>
          );
        })
      ) : !tool.result ? (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"\u2503 "}</Text>
          <Text color={C.dim}>loading...</Text>
        </Box>
      ) : (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"\u2503 "}</Text>
          <Text color={C.dim}>no metrics found</Text>
        </Box>
      )}
    </Box>
  );
}

// ── start_monitor / stop_monitor ─────────────────────────────────────

function MonitorDisplay({ tool }: { tool: ToolData }) {
  const goal = (tool.args.goal as string) ?? "";
  const interval = (tool.args.interval_minutes as number) ?? 2;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon="⟳" label="monitor" detail={`every ${interval}m`} />
      <Box paddingLeft={2}>
        <Text color={C.dim} dimColor>{"┃ "}</Text>
        <Text color={C.dim}>{goal}</Text>
      </Box>
    </Box>
  );
}

function MonitorStopDisplay(_props: { tool: ToolData }) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon="⟳" label="monitor stopped" />
    </Box>
  );
}

// ── compare_runs ────────────────────────────────────────────────────

function CompareRunsDisplay({ tool }: { tool: ToolData }) {
  const taskA = (tool.args.task_a as string) ?? "?";
  const taskB = (tool.args.task_b as string) ?? "?";
  const result = parseResult(tool);
  const comparisons = (result?.comparisons ?? []) as Array<{
    metric: string;
    baseline: { latest: number; min: number; max: number } | null;
    experiment: { latest: number; min: number; max: number } | null;
    delta: number | null;
    direction: string;
  }>;

  const dirIcon = (d: string): string => {
    switch (d) {
      case "decreased": return "↓";
      case "increased": return "↑";
      case "unchanged": return "→";
      default: return "?";
    }
  };

  const dirColor = (d: string): string => {
    switch (d) {
      case "decreased": return C.primary;
      case "increased": return C.primary;
      case "unchanged": return C.dim;
      default: return C.dim;
    }
  };

  const fmtVal = (v: number | null): string =>
    v === null ? "—" : formatMetricValue(v);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon="⇄" label="compare" detail={`${taskA} vs ${taskB}`} />
      {comparisons.length > 0 ? (
        comparisons.map((c) => {
          const color = METRIC_COLORS[nameHash(c.metric) % METRIC_COLORS.length];
          return (
            <Box key={c.metric} paddingLeft={2}>
              <Text color={C.dim} dimColor>{"┃ "}</Text>
              <Text color={color}>{c.metric.padEnd(12)}</Text>
              <Text color={C.dim}>{fmtVal(c.baseline?.latest ?? null)}</Text>
              <Text color={C.dim}>{" → "}</Text>
              <Text color={dirColor(c.direction)}>{fmtVal(c.experiment?.latest ?? null)}</Text>
              {c.delta !== null ? (
                <Text color={dirColor(c.direction)}>
                  {" "}{dirIcon(c.direction)} {c.delta > 0 ? "+" : ""}{fmtVal(c.delta)}
                </Text>
              ) : null}
            </Box>
          );
        })
      ) : !tool.result ? (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.dim}>comparing…</Text>
        </Box>
      ) : result?.error ? (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={C.error}>{String(result.error)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── Generic fallback ─────────────────────────────────────────────────

function GenericToolDisplay({ tool }: { tool: ToolData }) {
  const argStr = Object.entries(tool.args)
    .map(([k, v]) => {
      const val = typeof v === "string" ? truncate(v, 50) : JSON.stringify(v);
      return `${k}: ${val}`;
    })
    .join("  ");

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ToolHeader icon="⚙" label={tool.name} detail={argStr} />
      {tool.result && (
        <Box paddingLeft={2}>
          <Text color={C.dim} dimColor>{"┃ "}</Text>
          <Text color={tool.isError ? C.error : C.dim} wrap="wrap">
            {truncate(tool.result, 120)}
          </Text>
        </Box>
      )}
    </Box>
  );
}
