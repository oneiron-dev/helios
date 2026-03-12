import { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { C, G } from "../theme.js";
import { formatDuration, truncate, formatError } from "../format.js";
import { OverlayHeader } from "../components/overlay-header.js";
import type { TaskInfo } from "../types.js";
import type { RemoteExecutor } from "../../remote/executor.js";

// ─── Task grouping ──────────────────────────────────

export interface TaskGroup {
  groupId: string | null;
  label: string;
  tasks: TaskInfo[];
}

export function groupTasks(tasks: TaskInfo[]): TaskGroup[] {
  const groups = new Map<string | null, TaskInfo[]>();
  for (const task of tasks) {
    const key = task.groupId ?? null;
    const arr = groups.get(key) ?? [];
    arr.push(task);
    groups.set(key, arr);
  }
  return Array.from(groups.entries()).map(([id, items]) => ({
    groupId: id,
    label: items[0]?.groupLabel ?? (id ?? "ungrouped"),
    tasks: items,
  }));
}

interface TaskOverlayProps {
  tasks: TaskInfo[];
  executor?: RemoteExecutor;
  width: number;
  height: number;
  onClose: () => void;
}

export function TaskOverlay({ tasks, executor, width, height, onClose }: TaskOverlayProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [output, setOutput] = useState("");
  const [outputError, setOutputError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollViewRef>(null);

  // Build grouped structure and flat task list for selection
  const groups = groupTasks(tasks);
  const flatTasks = groups.flatMap((g) => g.tasks);
  const selected = flatTasks[selectedIndex] ?? null;

  // Fetch output for the selected task
  const fetchOutput = useCallback(async () => {
    if (!selected || !executor) {
      setOutput("");
      return;
    }

    const proc = executor.getBackgroundProcess(selected.machineId, selected.pid ?? 0);
    if (!proc?.logPath) {
      setOutput("(no log path available)");
      return;
    }

    try {
      const text = await executor.tail(selected.machineId, proc.logPath, 500);
      setOutput(text);
      setOutputError(null);
    } catch (err) {
      setOutputError(formatError(err));
    }
  }, [selected?.id, executor]);

  useEffect(() => {
    fetchOutput();
    const timer = setInterval(fetchOutput, 3000);
    return () => clearInterval(timer);
  }, [fetchOutput]);

  // Scroll to bottom when output changes
  useEffect(() => {
    scrollRef.current?.scrollToBottom();
  }, [output]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow && flatTasks.length > 0) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    }
    if (key.downArrow && flatTasks.length > 0) {
      setSelectedIndex((i) => Math.min(flatTasks.length - 1, i + 1));
    }
  });

  // Clamp selection
  useEffect(() => {
    if (selectedIndex >= flatTasks.length && flatTasks.length > 0) {
      setSelectedIndex(flatTasks.length - 1);
    }
  }, [flatTasks.length]);

  const listWidth = Math.min(35, Math.floor(width * 0.3));
  const outputWidth = width - listWidth - 1; // 1 for separator
  const bodyHeight = height - 2; // header + hint

  // Track the flat index across groups for selection
  let flatIdx = 0;
  const showGroupHeaders = groups.length > 1 || groups[0]?.groupId !== null;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header */}
      <OverlayHeader width={width} title="TASK OUTPUT" hints="ESC close  ↑↓ select" />

      {/* Body */}
      <Box flexGrow={1} flexShrink={1} height={bodyHeight}>
        {/* Task list */}
        <Box width={listWidth} flexDirection="column" flexShrink={0}>
          {tasks.length === 0 ? (
            <Box flexGrow={1} alignItems="center" justifyContent="center">
              <Text color={C.dim}>no tasks</Text>
            </Box>
          ) : (
            groups.map((group) => {
              const groupNodes: React.ReactNode[] = [];

              // Group header
              if (showGroupHeaders) {
                groupNodes.push(
                  <Box key={`gh-${group.groupId}`} paddingLeft={1}>
                    <Text color={C.primary} bold>
                      {G.section} {truncate(group.label, listWidth - 4)}
                    </Text>
                  </Box>
                );
              }

              // Tasks in this group
              group.tasks.forEach((task, ti) => {
                const isSelected = flatIdx === selectedIndex;
                const icon = task.status === "running" ? G.dot
                  : task.status === "completed" ? G.dotDim
                  : G.active;
                const color = task.status === "running" ? C.primary
                  : task.status === "completed" ? C.success
                  : C.error;
                const elapsed = formatDuration(Date.now() - task.startedAt);
                const isLast = ti === group.tasks.length - 1;
                const prefix = showGroupHeaders ? (isLast ? G.branchEnd : G.branch) + " " : "";

                groupNodes.push(
                  <Box key={task.id} paddingLeft={1}>
                    <Text color={isSelected ? C.bright : C.dim}>{prefix}</Text>
                    <Text color={isSelected ? C.bright : color} bold={isSelected} inverse={isSelected}>
                      {icon} {truncate(task.machineId, 8)}
                    </Text>
                    <Text color={isSelected ? C.bright : C.dim} inverse={isSelected}>
                      {" "}{elapsed}
                    </Text>
                  </Box>
                );
                flatIdx++;
              });

              return groupNodes;
            })
          )}
        </Box>

        {/* Separator */}
        <Box width={1} flexDirection="column" flexShrink={0}>
          <Text color={C.primary}>
            {Array.from({ length: bodyHeight }, () => "│").join("\n")}
          </Text>
        </Box>

        {/* Output pane */}
        <Box flexGrow={1} flexShrink={1} flexDirection="column">
          {selected && (
            <Box flexShrink={0} paddingX={1}>
              <Text color={C.primary} bold>{selected.machineId}:{selected.pid}</Text>
              <Text color={C.dim}> {truncate(selected.name, outputWidth - 20)}</Text>
            </Box>
          )}
          <Box flexGrow={1} flexShrink={1}>
            <ScrollView ref={scrollRef}>
              <Box paddingX={1}>
                {outputError ? (
                  <Text color={C.error} wrap="wrap">{outputError}</Text>
                ) : output ? (
                  <Text color={C.text} wrap="wrap">{output}</Text>
                ) : (
                  <Text color={C.dim}>
                    {tasks.length === 0 ? "no tasks to display" : "loading output..."}
                  </Text>
                )}
              </Box>
            </ScrollView>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

