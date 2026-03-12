import { useState, useCallback, useRef, useEffect, useMemo, memo } from "react";
import { Box, Text, useInput, useApp, measureElement } from "ink";
import type { EventEmitter } from "node:events";
import { useScreenSize } from "fullscreen-ink";
import { MessageLine, PulsingIndicator } from "./panels/conversation.js";
import { TaskListPanel } from "./panels/task-list.js";
import { MetricsDashboard } from "./panels/metrics-dashboard.js";
import { ProseRunPanel } from "./panels/prose-run-panel.js";
import { ProseStepPanel } from "./panels/prose-step-panel.js";
import { ExperimentSummaryPanel } from "./panels/experiment-summary-panel.js";
import { ExperimentLeaderboardPanel } from "./panels/experiment-leaderboard-panel.js";
import { StatusBar } from "./components/status-bar.js";
import { InputBar } from "./components/input-bar.js";
import { C, G, HRule, setUnicodeFallback } from "./theme.js";
import { KeyHintRule } from "./components/key-hint-rule.js";
import { TaskOverlay } from "./overlays/task-overlay.js";
import { MetricsOverlay } from "./overlays/metrics-overlay.js";
import { ProseOverlay } from "./overlays/prose-overlay.js";
import { ExperimentsOverlay } from "./overlays/experiments-overlay.js";
import type { MonitorConfig } from "../core/monitor.js";
import type { MouseEvent } from "./mouse-filter.js";
import type { StickyNote } from "../core/stickies.js";
import type { HeliosRuntime } from "../init.js";
import type { Attachment } from "../providers/types.js";
import { StickyNotesPanel } from "./panels/sticky-notes.js";
import { VERSION, checkForUpdate } from "../version.js";
import { COMMANDS, handleSlashCommand } from "./commands.js";
import { pollTaskStatuses, handleFinishedTasks, buildMonitorMessage } from "../core/task-poller.js";
import { parseToolCalls, parseToolResultMeta } from "../store/session-store.js";
import { formatDuration, formatError, truncate } from "./format.js";
import type { Message, ToolData, TaskInfo, PanelGroup } from "./types.js";
import type { SlashCommand } from "./commands.js";
import type { ProseRun } from "../prose/types.js";
import type { Experiment, ExperimentSummary } from "../experiments/types.js";

interface LayoutProps {
  runtime: HeliosRuntime;
  mouseEmitter?: EventEmitter;
  headless?: boolean;
  initialPrompt?: string;
  initialAttachments?: Attachment[];
}

let messageIdCounter = 0;

function MessageList({ messages, isStreaming }: { messages: Message[]; isStreaming: boolean }) {
  return (
    <>
      {messages.map((msg) => (
        <Box key={msg.id} paddingX={1}>
          <MessageLine message={msg} />
        </Box>
      ))}
      {isStreaming && (
        <Box paddingX={1} paddingLeft={3}>
          <PulsingIndicator />
        </Box>
      )}
    </>
  );
}

export function Layout({ runtime, mouseEmitter, headless, initialPrompt, initialAttachments }: LayoutProps) {
  const {
    orchestrator, sleepManager, connectionPool, executor,
    metricStore, metricCollector, monitorManager, experimentTracker,
    memoryStore, stickyManager, agentName, subagentManager,
  } = runtime;
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>(() => {
    // If a session was already resumed (via -r / -c flags) before Layout mounted,
    // pre-populate the UI with stored messages so the user can see conversation history.
    const session = orchestrator.activeSession;
    if (!session) return [];
    const stored = orchestrator.sessionStore.getMessages(session.id, 500);
    const msgs: Message[] = [];
    // Index tool calls by callId for O(1) correlation with tool results
    const toolCallIndex = new Map<string, { name: string; args: Record<string, unknown> }>();
    const toolMsgByCallId = new Map<string, Message>();

    for (const m of stored) {
      if (m.role === "assistant") {
        const tcs = parseToolCalls(m);
        if (m.content) {
          msgs.push({ id: ++messageIdCounter, role: "assistant", content: m.content });
        }
        for (const tc of tcs) {
          toolCallIndex.set(tc.id, { name: tc.name, args: tc.args });
          const toolMsg: Message = {
            id: ++messageIdCounter,
            role: "tool",
            content: "",
            tool: { callId: tc.id, name: tc.name, args: tc.args },
          };
          msgs.push(toolMsg);
          toolMsgByCallId.set(tc.id, toolMsg);
        }
      } else if (m.role === "tool" && m.toolCalls) {
        const meta = parseToolResultMeta(m);
        const existing = toolMsgByCallId.get(meta.callId);
        if (existing?.tool) {
          existing.tool.result = m.content;
          existing.tool.isError = meta.isError;
        } else {
          const parent = toolCallIndex.get(meta.callId);
          msgs.push({
            id: ++messageIdCounter,
            role: "tool",
            content: m.content,
            tool: { callId: meta.callId, name: parent?.name ?? "tool", args: parent?.args ?? {}, result: m.content, isError: meta.isError },
          });
        }
      } else if (m.role === "user") {
        msgs.push({ id: ++messageIdCounter, role: "user", content: m.content });
      }
    }
    return msgs;
  });
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingStartedAt, setStreamingStartedAt] = useState<number | null>(null);
  const [scrollUp, setScrollUp] = useState(0);
  const contentRef = useRef<any>(null);
  const viewportRef = useRef<any>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [metricData, setMetricData] = useState<Map<string, number[]>>(new Map());
  const [stickyNotes, setStickyNotes] = useState<StickyNote[]>([]);
  const [activeOverlay, setActiveOverlay] = useState<"none" | "tasks" | "metrics" | "prose" | "experiments">("none");
  const [focusProseRunId, setFocusProseRunId] = useState<string | undefined>();
  const [resourceData, setResourceData] = useState<Map<string, import("../metrics/resources.js").MachineResources>>(new Map());
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [panelGroup, setPanelGroup] = useState<PanelGroup>("default");
  const [proseRuns, setProseRuns] = useState<ProseRun[]>([]);
  const [experimentList, setExperimentList] = useState<Experiment[]>([]);
  const [experimentSummary, setExperimentSummary] = useState<ExperimentSummary | null>(null);

  // Refs for skipping unchanged polling state updates
  const lastTaskIdsRef = useRef("");
  const lastMetricKeyRef = useRef("");
  const lastResourceKeyRef = useRef("");

  // Check for updates on mount (non-blocking)
  useEffect(() => {
    checkForUpdate().then((v) => { if (v) setUpdateAvailable(v); }).catch(() => {});
  }, []);

  // Unicode fallback from project config
  useEffect(() => {
    if (runtime.projectConfig?.unicodeFallback) setUnicodeFallback(true);
  }, []);

  // Prose watcher polling
  useEffect(() => {
    const pw = runtime.proseWatcher;
    if (!pw) return;
    const refresh = () => setProseRuns(pw.getRuns());
    refresh();
    pw.on("update", refresh);
    const timer = setInterval(refresh, 3000);
    return () => { pw.removeListener("update", refresh); clearInterval(timer); };
  }, [runtime.proseWatcher]);

  // Experiment adapter polling
  // Note: ExperimentAdapter.onUpdate has no unsubscribe API; registering once is safe
  // since runtime.experimentAdapter is stable for the lifetime of the component.
  const experimentCallbackRegistered = useRef(false);
  useEffect(() => {
    const ea = runtime.experimentAdapter;
    if (!ea) return;
    const refresh = async () => {
      const exps = await ea.load();
      setExperimentList(exps);
      setExperimentSummary(ea.getSummary());
    };
    refresh();
    if (!experimentCallbackRegistered.current) {
      experimentCallbackRegistered.current = true;
      ea.onUpdate(refresh);
    }
  }, [runtime.experimentAdapter]);

  // Poll tasks and metrics every 5 seconds
  useEffect(() => {
    const poll = async () => {
      let didCollect = false;

      if (executor && connectionPool) {
        const { statuses, finished } = await pollTaskStatuses(executor);

        // Build TaskInfo[] for UI state
        const updated: TaskInfo[] = statuses.map(({ proc, running }) => {
          const shortCmd = truncate(proc.command, 40);
          return {
            id: `${proc.machineId}:${proc.pid}`,
            name: shortCmd,
            status: running ? "running" as const : "completed" as const,
            machineId: proc.machineId,
            pid: proc.pid,
            startedAt: proc.startedAt,
            groupId: proc.groupId,
            groupLabel: proc.groupLabel,
          };
        });

        if (finished.length > 0) {
          await handleFinishedTasks(finished, {
            executor, connectionPool, metricCollector, metricStore,
            experimentTracker, notifier: runtime.notifier,
          });
          didCollect = true;
        }

        // Remove finished processes from executor Map to prevent unbounded growth.
        // Only remove after handleFinishedTasks has processed them.
        for (const key of finished) {
          executor.removeBackgroundProcess(key);
        }

        // Prune orphaned experiment tracker entries
        if (experimentTracker) experimentTracker.prune();

        // Merge subagent entries into task list
        if (subagentManager) {
          for (const sa of subagentManager.listAll()) {
            updated.push({
              id: `sa:${sa.id}`,
              name: truncate(sa.task, 40),
              status: sa.status === "cancelled" ? "failed" : sa.status,
              machineId: sa.model,
              startedAt: sa.createdAt,
              type: "subagent",
              costUsd: sa.costUsd,
              turn: sa.turn,
              lastToolCall: sa.lastToolCall,
              log: sa.log,
            });
          }
        }

        const newTaskIds = updated.map(t => `${t.id}:${t.status}:${t.costUsd ?? ""}:${t.turn ?? ""}:${t.lastToolCall ?? ""}`).join(",");
        if (newTaskIds !== lastTaskIdsRef.current) {
          lastTaskIdsRef.current = newTaskIds;
          setTasks(updated);
        }
      }

      // Collect metrics from all sources (skip if we already collected for finished tasks above)
      if (metricCollector && metricStore) {
        if (!didCollect) {
          await metricCollector.collectAll().catch(() => {});
        }
        const newMetrics = metricStore.getAllSeries(50);
        const newMetricKey = Array.from(newMetrics.entries()).map(([k, v]) => `${k}:${v.length}:${v.length > 0 ? v[v.length - 1] : ""}`).join(",");
        if (newMetricKey !== lastMetricKeyRef.current) {
          lastMetricKeyRef.current = newMetricKey;
          setMetricData(newMetrics);
        }
      }

      // Collect resource usage from connected machines
      if (runtime.resourceCollector) {
        const res = await runtime.resourceCollector.collectAll().catch(() => new Map()) as Map<string, import("../metrics/resources.js").MachineResources>;
        const newResKey = Array.from(res.entries()).map(([k, v]) => `${k}:${v.cpuPercent}:${v.memoryUsed}`).join(",");
        if (newResKey !== lastResourceKeyRef.current) {
          lastResourceKeyRef.current = newResKey;
          setResourceData(res);
        }
      }
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const loop = async () => {
      await poll();
      if (!stopped) timer = setTimeout(loop, 5000);
    };
    loop();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [executor, connectionPool, metricCollector, metricStore]);

  // Re-snap to bottom when streaming starts.
  useEffect(() => {
    if (isStreaming) {
      setScrollUp(0);
    }
  }, [isStreaming]);

  // Measure current max scroll (content overflow above viewport).
  const getMaxScroll = useCallback(() => {
    if (!contentRef.current || !viewportRef.current) return 0;
    const ch = measureElement(contentRef.current).height;
    const vh = measureElement(viewportRef.current).height;
    return Math.max(0, ch - vh);
  }, []);

  // Scroll by delta rows (positive = up into history, negative = toward bottom).
  const scrollBy = useCallback((delta: number) => {
    setScrollUp((prev) => {
      const next = prev + delta;
      if (next <= 0) return 0;
      return Math.min(next, getMaxScroll());
    });
  }, [getMaxScroll]);

  // Enable SGR mouse reporting and handle scroll via mouseEmitter
  useEffect(() => {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    return () => { process.stdout.write("\x1b[?1006l\x1b[?1000l"); };
  }, []);

  useEffect(() => {
    if (!mouseEmitter) return;
    const handler = (evt: MouseEvent) => {
      if (evt.type === "scroll_up") {
        scrollBy(3);
      } else if (evt.type === "scroll_down") {
        scrollBy(-3);
      }
    };
    mouseEmitter.on("mouse", handler);
    return () => { mouseEmitter.removeListener("mouse", handler); };
  }, [mouseEmitter, scrollBy]);

  useInput((input, key) => {
    // Toggle overlays — always available
    if (key.ctrl && input === "t") {
      setActiveOverlay((prev) => prev === "tasks" ? "none" : "tasks");
      return;
    }
    if (key.ctrl && input === "g") {
      setActiveOverlay((prev) => prev === "metrics" ? "none" : "metrics");
      return;
    }
    if (key.ctrl && input === "p") {
      setActiveOverlay((prev) => prev === "prose" ? "none" : "prose");
      return;
    }
    if (key.ctrl && input === "e") {
      setActiveOverlay((prev) => prev === "experiments" ? "none" : "experiments");
      return;
    }
    if (key.ctrl && input === "p") {
      if (availableGroups.length > 1) {
        setPanelGroup(prev => {
          const idx = availableGroups.indexOf(prev);
          return availableGroups[(idx + 1) % availableGroups.length];
        });
      }
      return;
    }

    // Esc: close overlay first, then interrupt stream
    if (key.escape) {
      if (activeOverlay !== "none") {
        setActiveOverlay("none");
        return;
      }
      if (isStreaming) {
        orchestrator.interrupt();
        setIsStreaming(false);
        return;
      }
    }

    if (key.ctrl && input === "c") {
      if (activeOverlay !== "none") {
        setActiveOverlay("none");
        return;
      }
      if (isStreaming) {
        orchestrator.interrupt();
        setIsStreaming(false);
      } else {
        exit();
      }
      return;
    }

    // Don't process scroll keys when overlay is active
    if (activeOverlay !== "none") return;

    if (key.pageUp) {
      scrollBy(10);
    }
    if (key.pageDown) {
      scrollBy(-10);
    }
  });

  const addMessage = useCallback(
    (role: Message["role"], content: string, tool?: ToolData): number => {
      const id = ++messageIdCounter;
      setMessages((prev) => {
        const next = [...prev, { id, role, content, tool }];
        // Cap at 500 messages to prevent OOM in long sessions.
        // Old messages are still persisted in the session store.
        if (next.length > 500) {
          return next.slice(-500);
        }
        return next;
      });
      return id;
    },
    [],
  );

  const updateMessage = useCallback((id: number, updates: Partial<Message>) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    );
  }, []);

  const handleSubmit = useCallback(
    async (input: string, attachments?: Attachment[]) => {
      if (!input.trim()) return;

      // Snap to bottom on any submission — user intent is to interact, not read history.
      setScrollUp(0);

      if (input.startsWith("/")) {
        await handleSlashCommand(input, {
          orchestrator, addMessage, updateMessage, setMessages, messages: messagesRef.current, setIsStreaming,
          connectionPool, metricStore, metricCollector, memoryStore,
          stickyManager, setStickyNotes, executor, skillRegistry: runtime.skillRegistry,
          proseWatcher: runtime.proseWatcher,
          experimentAdapter: runtime.experimentAdapter,
          proseRunConfig: runtime.proseRunConfig,
          setFocusProseRunId,
          setActiveOverlay,
          restoreMessages: (msgs) =>
            msgs.map((m) => ({
              id: ++messageIdCounter,
              role: m.role as Message["role"],
              content: m.content,
            })),
        });
        return;
      }

      if (sleepManager.isSleeping) {
        addMessage("user", input);
        addMessage("system", "Waking agent...");
        sleepManager.manualWake(input);
        return;
      }

      addMessage("user", input);
      const startedAt = Date.now();
      setStreamingStartedAt(startedAt);
      setIsStreaming(true);

      try {
        let assistantText = "";
        let assistantMsgId: number | null = null;
        // Map tool callId -> message id for attaching results
        const toolMsgIds = new Map<string, number>();

        for await (const event of orchestrator.send(input, attachments)) {
          // Feed events to experiment tracker for auto-populating /experiments/
          experimentTracker?.onEvent(event);

          if (event.type === "text" && event.delta) {
            assistantText += event.delta;
            if (assistantMsgId === null) {
              assistantMsgId = addMessage("assistant", assistantText);
            } else {
              updateMessage(assistantMsgId, { content: assistantText });
            }
          }

          if (event.type === "tool_call") {
            const toolData: ToolData = {
              callId: event.id,
              name: event.name,
              args: event.args,
            };
            const msgId = addMessage("tool", "", toolData);
            toolMsgIds.set(event.id, msgId);
            assistantText = "";
            assistantMsgId = null;
          }

          if (event.type === "tool_result") {
            const msgId = toolMsgIds.get(event.callId);
            if (msgId !== undefined) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === msgId && m.tool
                    ? { ...m, tool: { ...m.tool, result: event.result, isError: event.isError } }
                    : m,
                ),
              );
            }
            if (event.isError) {
              addMessage("error", event.result);
            }
          }

          if (event.type === "error") {
            addMessage("error", event.error.message);
          }
        }
      } catch (err) {
        addMessage("error", formatError(err));
      } finally {
        const worked = Date.now() - startedAt;
        if (worked >= 1000) {
          addMessage("system", `[Worked for ${formatDuration(worked)}]`);
        }
        setIsStreaming(false);
        setStreamingStartedAt(null);
      }
    },
    [orchestrator, sleepManager, addMessage, updateMessage, setMessages, connectionPool, metricStore],
  );

  // Auto-submit initial prompt (from --prompt CLI flag)
  const promptSent = useRef(false);
  useEffect(() => {
    if (initialPrompt && !promptSent.current) {
      promptSent.current = true;
      handleSubmit(initialPrompt, initialAttachments);
    }
  }, [initialPrompt, initialAttachments, handleSubmit]);

  // Monitor: auto-invoke model on tick
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;

  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  useEffect(() => {
    if (!monitorManager) return;

    const onTick = (config: MonitorConfig) => {
      if (isStreamingRef.current) return;
      const message = buildMonitorMessage(config, executor, metricStore, memoryStore);
      handleSubmitRef.current(message);
    };

    monitorManager.on("tick", onTick);
    return () => {
      monitorManager.removeListener("tick", onTick);
    };
  }, [monitorManager]);

  // Sleep/wake: auto-resume model when a trigger fires
  const addMessageRef = useRef(addMessage);
  addMessageRef.current = addMessage;

  // Route OpenAI OAuth URL display through the TUI instead of stderr
  useEffect(() => {
    runtime.openaiOAuth.onAuthUrl = (url) => {
      addMessageRef.current("system", url);
    };
    return () => { runtime.openaiOAuth.onAuthUrl = null; };
  }, [runtime.openaiOAuth]);

  // Subagent completion/failure events → inject system messages
  useEffect(() => {
    if (!subagentManager) return;
    const onDone = (info: { id: string; task: string }) => {
      addMessageRef.current("system", `[Subagent ${info.id} completed — result at /subagents/${info.id}/result]`);
    };
    const onFail = (info: { id: string; error?: string }) => {
      addMessageRef.current("system", `[Subagent ${info.id} failed${info.error ? `: ${truncate(info.error, 80)}` : ""}]`);
    };
    subagentManager.on("completed", onDone);
    subagentManager.on("failed", onFail);
    return () => {
      subagentManager.removeListener("completed", onDone);
      subagentManager.removeListener("failed", onFail);
    };
  }, [subagentManager]);

  // Queue wake events that arrive while streaming, replay when streaming ends
  const pendingWakesRef = useRef<string[]>([]);

  useEffect(() => {
    const onWake = (_session: unknown, _reason: string, wakeMessage: string) => {
      if (isStreamingRef.current) {
        pendingWakesRef.current.push(wakeMessage);
        return;
      }
      addMessageRef.current("system", "Agent waking up — trigger fired");
      handleSubmitRef.current(wakeMessage);
    };

    sleepManager.on("wake", onWake);
    return () => {
      sleepManager.removeListener("wake", onWake);
    };
  }, [sleepManager]);

  // Replay queued wake events when streaming ends
  useEffect(() => {
    if (!isStreaming && pendingWakesRef.current.length > 0) {
      const wakeMessage = pendingWakesRef.current.shift()!;
      pendingWakesRef.current = []; // discard any further queued — one wake is enough
      addMessageRef.current("system", "Agent waking up — trigger fired");
      handleSubmitRef.current(wakeMessage);
    }
  }, [isStreaming]);

  // ── Panel group logic ──────────────────────────────────────
  const availableGroups = useMemo<PanelGroup[]>(() => {
    const groups: PanelGroup[] = ["default"];
    if (runtime.proseWatcher) groups.push("prose");
    if (runtime.experimentAdapter) groups.push("experiments");
    return groups;
  }, [runtime.proseWatcher, runtime.experimentAdapter]);

  // Clamp if current group becomes unavailable
  useEffect(() => {
    if (!availableGroups.includes(panelGroup)) setPanelGroup("default");
  }, [availableGroups, panelGroup]);

  // Auto-switch to "prose" on first prose update
  const autoSwitchedRef = useRef(false);
  useEffect(() => {
    const pw = runtime.proseWatcher;
    if (!pw || autoSwitchedRef.current) return undefined;
    const handler = () => {
      if (!autoSwitchedRef.current && panelGroup === "default") {
        autoSwitchedRef.current = true;
        setPanelGroup("prose");
      }
      pw.removeListener("update", handler);
    };
    pw.on("update", handler);
    return () => { pw.removeListener("update", handler); };
  }, [runtime.proseWatcher, panelGroup]);

  const isSleeping = sleepManager.isSleeping;

  // Merge static commands with dynamic skill commands for autocomplete
  const allCommands = useMemo<SlashCommand[]>(() => {
    const skillCmds = runtime.skillRegistry.list().map((s) => ({
      name: s.name,
      args: s.config.args
        ? Object.keys(s.config.args).map((k) => `<${k}>`).join(" ")
        : undefined,
      description: s.description,
    }));
    return [...COMMANDS, ...skillCmds];
  }, [runtime.skillRegistry]);

  // ── Panel height computation ────────────────────────────────
  const metricsRows = metricData.size > 0 ? metricData.size : 1;
  const tasksRows = tasks.length > 0 ? Math.min(tasks.length, 5) : 1;
  const activeProseRun = proseRuns.find(r => r.status === "running") ?? proseRuns[0] ?? null;

  let panelHeight: number;
  if (panelGroup === "prose") {
    const runsRows = Math.min(proseRuns.length, 5) || 1;
    const stepsRows = activeProseRun ? Math.min(activeProseRun.steps.length, 5) || 1 : 1;
    panelHeight = Math.max(runsRows, stepsRows);
  } else if (panelGroup === "experiments") {
    const summaryRows = experimentSummary ? experimentSummary.stats.length + 2 : 1;
    const leaderRows = Math.min(experimentList.length, 5) || 1;
    panelHeight = Math.max(summaryRows, leaderRows);
  } else {
    panelHeight = Math.max(metricsRows, tasksRows);
  }
  const verticalSeparator = useMemo(() => Array.from({ length: panelHeight }, () => "│").join("\n"), [panelHeight]);

  const { height, width } = useScreenSize();
  const halfPanelWidth = Math.floor((width - 1) / 2) - 2;
  const closeOverlay = useCallback(() => setActiveOverlay("none"), []);

  // ── Overlay content (rendered in place of main area) ─────────
  const overlayContent = (() => {
    if (activeOverlay === "tasks") {
      return (
        <TaskOverlay
          tasks={tasks}
          executor={executor}
          width={width}
          height={height - 3}
          onClose={closeOverlay}
        />
      );
    }
    if (activeOverlay === "metrics") {
      return (
        <MetricsOverlay
          metricData={metricData}
          metricStore={metricStore}
          width={width}
          height={height - 3}
          onClose={closeOverlay}
        />
      );
    }
    if (activeOverlay === "prose") {
      if (!runtime.proseWatcher) {
        return (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text color={C.dim}>No Prose watcher active. Start a .prose run to use this overlay.</Text>
          </Box>
        );
      }
      return (
        <ProseOverlay
          proseWatcher={runtime.proseWatcher}
          width={width}
          height={height - 3}
          focusRunId={focusProseRunId}
          onClose={() => { closeOverlay(); setFocusProseRunId(undefined); }}
        />
      );
    }
    if (activeOverlay === "experiments") {
      if (!runtime.experimentAdapter) {
        return (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text color={C.dim}>No experiment adapter detected. Configure in helios.json or place artifacts in a recognized directory.</Text>
          </Box>
        );
      }
      return (
        <ExperimentsOverlay
          adapter={runtime.experimentAdapter}
          executor={executor}
          width={width}
          height={height - 3}
          onClose={closeOverlay}
        />
      );
    }
    return null;
  })();

  // ── Normal layout ─────────────────────────────────────────────
  return (
    <Box flexDirection="column" height={height} width={width}>
        <Box flexShrink={0}>
          {headless && agentName ? (
            <HeadlessHeader agentName={agentName} width={width} />
          ) : (
            <HeaderWithPanels width={width} panelGroup={panelGroup} />
          )}
        </Box>

        {overlayContent ? (
          <Box flexGrow={1} flexShrink={1} flexDirection="column">
            {overlayContent}
          </Box>
        ) : (
          <>
            <Box flexShrink={0} flexDirection="row">
              <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
                {panelGroup === "default" && <MetricsDashboard metricData={metricData} width={halfPanelWidth} />}
                {panelGroup === "prose" && <ProseRunPanel runs={proseRuns} width={halfPanelWidth} />}
                {panelGroup === "experiments" && <ExperimentSummaryPanel summary={experimentSummary} width={halfPanelWidth} />}
              </Box>
              <Box width={1} flexDirection="column" alignItems="center">
                <Text color={C.primary} wrap="truncate">
                  {verticalSeparator}
                </Text>
              </Box>
              <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
                {panelGroup === "default" && <TaskListPanel tasks={tasks} resources={resourceData} width={halfPanelWidth} />}
                {panelGroup === "prose" && <ProseStepPanel run={activeProseRun} width={halfPanelWidth} />}
                {panelGroup === "experiments" && <ExperimentLeaderboardPanel experiments={experimentList} width={halfPanelWidth} />}
              </Box>
            </Box>

            <Box flexShrink={0}><HRule /></Box>

            {/* Chat area */}
            <Box flexGrow={1} flexShrink={1} flexDirection="row">
              <Box flexGrow={1} flexShrink={1}>
                {messages.length === 0 && !headless ? (
                  <Box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
                    <Text color={C.primary} bold>{G.brand}</Text>
                    <Text color={C.primary} bold>H E L I O S</Text>
                    <Text color={C.dim}>autonomous ml research</Text>
                    <Text color={C.dim} dimColor>v{VERSION}</Text>
                    <Text color={C.dim} dimColor>{""}</Text>
                    <Text color={C.dim} dimColor>/help for commands</Text>
                    {updateAvailable && (
                      <Box marginTop={1}>
                        <Text color={C.bright}>update available: v{updateAvailable} — npm i -g helios</Text>
                      </Box>
                    )}
                  </Box>
                ) : (
                  <Box
                    ref={viewportRef}
                    overflow="hidden"
                    flexGrow={1}
                    flexShrink={1}
                    flexDirection="column"
                    justifyContent="flex-end"
                  >
                    <Box
                      ref={contentRef}
                      flexDirection="column"
                      flexShrink={0}
                      marginBottom={scrollUp > 0 ? -scrollUp : undefined}
                    >
                      <MessageList messages={messages} isStreaming={isStreaming} />
                    </Box>
                  </Box>
                )}
              </Box>
              {stickyNotes.length > 0 && (
                <Box flexShrink={0}>
                  <StickyNotesPanel notes={stickyNotes} width={Math.min(30, Math.floor(width * 0.25))} />
                </Box>
              )}
            </Box>
          </>
        )}

        {!headless && <Box flexShrink={0}><KeyHintRule hasMultipleGroups={availableGroups.length > 1} /></Box>}
        <Box flexShrink={0}><StatusBar orchestrator={orchestrator} sleepManager={sleepManager} monitorManager={monitorManager} isStreaming={isStreaming} streamingStartedAt={streamingStartedAt} proseRuns={proseRuns} experimentSummary={experimentSummary} /></Box>
        {!headless && (
          <Box flexShrink={0}>
            <InputBar
              onSubmit={handleSubmit}
              disabled={isStreaming}
              commands={allCommands}
              placeholder={
                isSleeping
                  ? "type to wake agent..."
                  : "send a message... (/help for commands)"
              }
            />
          </Box>
        )}
    </Box>
  );
}

/** Compact header for headless mode — shows agent name prominently. */
function HeadlessHeader({ agentName, width }: { agentName: string; width: number }) {
  const label = ` ${G.brand} ${agentName} `;
  const fill = Math.max(0, width - label.length);
  return (
    <Box>
      <Text color={C.bright} bold>{label}</Text>
      <Text color={C.primary}>{G.rule.repeat(fill)}</Text>
    </Box>
  );
}

/** Single header line: logo on the left, panel labels right-aligned in each half. */
const HeaderWithPanels = memo(function HeaderWithPanels({ width, panelGroup }: { width: number; panelGroup: PanelGroup }) {
  const logo = ` ▓▒░ ${G.brand} HELIOS ░▒▓ `;
  const ver = `${VERSION} `;

  const labels: Record<PanelGroup, { left: string; right: string }> = {
    default:     { left: " ⣤⣸⣿ METRICS ",     right: " ⊳ TASKS " },
    prose:       { left: " ◈ PROSE RUNS ",       right: " ⊳ STEPS " },
    experiments: { left: " ◈ EXPERIMENTS ",      right: " ⊳ LEADERBOARD " },
  };

  const { left: leftLabel, right: rightLabel } = labels[panelGroup];

  const half = Math.floor(width / 2);
  const leftFill = Math.max(0, half - logo.length - ver.length - leftLabel.length - 1);
  const rightFill = Math.max(0, width - half - rightLabel.length - 1);

  return (
    <Box>
      <ShimmerLogo text={logo} />
      <Text color={C.dim}>{ver}</Text>
      <Text color={C.primary}>{G.rule.repeat(leftFill)}</Text>
      <Text color={C.primary}>{leftLabel}</Text>
      <Text color={C.primary}>{G.rule}</Text>
      <Text color={C.primary}>{G.rule.repeat(rightFill)}</Text>
      <Text color={C.primary}>{rightLabel}</Text>
      <Text color={C.primary}>{G.rule}</Text>
    </Box>
  );
});

const SHIMMER_INTERVAL = 80;
const SHIMMER_PAUSE = 20; // extra frames of pause after sweep

const ShimmerLogo = memo(function ShimmerLogo({ text }: { text: string }) {
  const [frame, setFrame] = useState(0);
  const len = text.length;
  const cycleLen = len + 6 + SHIMMER_PAUSE; // 6 = shimmer tail width

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => {
        if (f + 1 >= cycleLen) {
          clearInterval(timer);
          return f;
        }
        return f + 1;
      });
    }, SHIMMER_INTERVAL);
    return () => clearInterval(timer);
  }, [cycleLen]);

  const shimmerPos = frame - 3; // center of the bright spot

  // Group consecutive chars by color into segments for fewer <Text> nodes
  const segments: Array<{ color: string; chars: string }> = [];
  for (let i = 0; i < len; i++) {
    const dist = Math.abs(i - shimmerPos);
    const color = dist <= 1 ? C.bright : C.primary;

    const prev = segments[segments.length - 1];
    if (prev && prev.color === color) {
      prev.chars += text[i];
    } else {
      segments.push({ color, chars: text[i] });
    }
  }

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text key={i} color={seg.color} bold>{seg.chars}</Text>
      ))}
    </Text>
  );
});

