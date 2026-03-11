import { Box, Text } from "ink";
import { C, G } from "../theme.js";
import { formatBytes } from "../format.js";
import type { TaskInfo } from "../types.js";
import type { MachineResources, GpuInfo } from "../../metrics/resources.js";

interface TaskListPanelProps {
  tasks?: TaskInfo[];
  resources?: Map<string, MachineResources>;
  width?: number;
}

export function TaskListPanel({ tasks = [], resources, width }: TaskListPanelProps) {
  const panelWidth = width ?? (Math.floor((process.stdout.columns || 80) * 0.4) - 4);
  const nameWidth = Math.max(10, panelWidth - 11);

  const hasResources = resources && resources.size > 0;
  const hasTasks = tasks.length > 0;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Running tasks */}
      {hasTasks && tasks.slice(0, 3).map((task) => {
        const name = task.name.length > nameWidth
          ? task.name.slice(0, nameWidth - 1) + "…"
          : task.name;
        return (
          <Box key={task.id} paddingLeft={1}>
            <Text color={statusColor(task.status)}>
              {statusIcon(task.status)}{" "}
            </Text>
            <Text color={C.dim}>{task.machineId} </Text>
            <Text color={C.text}>{name}</Text>
          </Box>
        );
      })}

      {/* Divider if both sections present */}
      {hasTasks && hasResources && (
        <Box paddingLeft={1}>
          <Text color={C.dim}>{G.dash.repeat(Math.min(panelWidth, 30))}</Text>
        </Box>
      )}

      {/* Resource usage per machine */}
      {hasResources && Array.from(resources.entries()).map(([id, res]) => (
        <Box key={id} flexDirection="column" paddingLeft={1}>
          <Text color={C.dim}>{id}</Text>
          {/* GPUs */}
          {res.gpus.map((gpu) => {
            const parts: string[] = [];
            if (gpu.utilization !== null) parts.push(`${gpu.utilization}%`);
            if (gpu.memoryTotal > 0) parts.push(`${formatBytes(gpu.memoryUsed * 1048576)}/${formatBytes(gpu.memoryTotal * 1048576)}`);
            if (gpu.temperature > 0) parts.push(`${gpu.temperature}°C`);
            if (parts.length === 0) return null;
            return (
              <Box key={gpu.index} paddingLeft={1}>
                <Text color={gpuColor(gpu.utilization)}>
                  {G.dot} GPU{gpu.index} {parts.join(" ")}
                </Text>
              </Box>
            );
          })}
          {/* CPU + Memory */}
          <Box paddingLeft={1} gap={1}>
            {res.cpuPercent !== null && (
              <Text color={C.dim}>CPU {Math.round(res.cpuPercent)}%</Text>
            )}
            {res.memoryUsed !== null && res.memoryTotal !== null && (
              <Text color={C.dim}>
                MEM {formatBytes(res.memoryUsed)}/{formatBytes(res.memoryTotal)}
              </Text>
            )}
          </Box>
          {/* Disk */}
          {res.diskUsed !== null && res.diskTotal !== null && (
            <Box paddingLeft={1}>
              <Text color={diskColor(res.diskUsed, res.diskTotal)}>
                DISK {formatBytes(res.diskUsed)}/{formatBytes(res.diskTotal)}
              </Text>
            </Box>
          )}
        </Box>
      ))}

      {/* Empty state */}
      {!hasTasks && !hasResources && (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={C.dim} dimColor>
            no tasks
          </Text>
        </Box>
      )}
    </Box>
  );
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return G.dot;
    case "completed":
      return G.dot;
    case "failed":
      return G.active;
    default:
      return G.bullet;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return C.primary;
    case "completed":
      return C.success;
    case "failed":
      return C.error;
    default:
      return C.dim;
  }
}

function gpuColor(utilization: number | null): string {
  if (utilization === null) return C.dim; // unavailable
  if (utilization > 80) return C.success;
  if (utilization > 30) return C.primary;
  if (utilization > 0) return C.dim;
  return C.error; // 0% = idle, possibly crashed
}

function diskColor(used: number, total: number): string {
  const pct = total > 0 ? used / total : 0;
  if (pct > 0.9) return C.error;
  if (pct > 0.75) return C.primary;
  return C.dim;
}

