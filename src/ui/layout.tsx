import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import { useScreenSize } from "fullscreen-ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { ConversationPanel } from "./panels/conversation.js";
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
import { formatDuration, formatError } from "./format.js";
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

export function Layout({ runtime, mouseEmitter, headless, initialPrompt, initialAttachments }: LayoutProps) {
  const {
    orchestrator, sleepManager, connectionPool, executor,
    metricStore, metricCollector, monitorManager, experimentTracker,
    memoryStore, stickyManager, agentName,
  } = runtime;
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingStartedAt, setStreamingStartedAt] = useState<number | null>(null);
  const scrollRef = useRef<ScrollViewRef>(null);

  const [userScrolled, setUserScrolled] = useState(false);
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
  useEffect(() => {
    const ea = runtime.experimentAdapter;
    if (!ea) return;
    const refresh = async () => {
      const exps = await ea.load();
      setExperimentList(exps);
      setExperimentSummary(ea.getSummary());
    };
    refresh();
    ea.onUpdate(() => { refresh(); });
  }, [runtime.experimentAdapter]);

  // Poll tasks and metrics every 5 seconds
  useEffect(() => {
    const poll = async () => {
      let didCollect = false;

      if (executor && connectionPool) {
        const { statuses, finished } = await pollTaskStatuses(executor);

        // Build TaskInfo[] for UI state
        const updated: TaskInfo[] = statuses.map(({ proc, running }) => {
          const shortCmd = proc.command.length > 40
            ? proc.command.slice(0, 40) + "..."
            : proc.command;
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

        setTasks(updated);
      }

      // Collect metrics from all sources (skip if we already collected for finished tasks above)
      if (metricCollector && metricStore) {
        if (!didCollect) {
          await metricCollector.collectAll().catch(() => {});
        }
        setMetricData(metricStore.getAllSeries(50));
      }

      // Collect resource usage from connected machines
      if (runtime.resourceCollector) {
        const res = await runtime.resourceCollector.collectAll().catch(() => new Map());
        setResourceData(res as Map<string, import("../metrics/resources.js").MachineResources>);
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

  // Auto-scroll to bottom when messages change, overlay closes, or user hasn't scrolled up
  useEffect(() => {
    if (!userScrolled) {
      scrollRef.current?.scrollToBottom();
    }
  }, [messages, userScrolled, activeOverlay]);

  // Re-snap to bottom when streaming starts, and keep scrolling during streaming
  useEffect(() => {
    if (isStreaming) {
      setUserScrolled(false);
      // During streaming, content changes faster than React state updates trigger effects.
      // Poll scrollToBottom on a short interval to keep up.
      const timer = setInterval(() => {
        scrollRef.current?.scrollToBottom();
      }, 100);
      return () => clearInterval(timer);
    }
  }, [isStreaming]);

  // Clamped scroll helper — ink-scroll-view's scrollBy has a bug where
  // it clamps to contentHeight instead of contentHeight - viewportHeight,
  // allowing you to scroll past the bottom into empty space.
  const clampedScrollBy = useCallback((delta: number) => {
    const sv = scrollRef.current;
    if (!sv) return;
    const target = Math.max(0, Math.min(sv.getScrollOffset() + delta, sv.getBottomOffset()));
    sv.scrollTo(target);
    return target >= sv.getBottomOffset();
  }, []);

  // Enable SGR mouse reporting and handle scroll via mouseEmitter
  useEffect(() => {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    return () => { process.stdout.write("\x1b[?1006l\x1b[?1000l"); };
  }, []);

  useEffect(() => {
    if (!mouseEmitter) return;
    const handler = (evt: MouseEvent) => {
      if (evt.type === "scroll_up") {
        clampedScrollBy(-3);
        setUserScrolled(true);
      } else if (evt.type === "scroll_down") {
        const atBottom = clampedScrollBy(3);
        if (atBottom) setUserScrolled(false);
      }
    };
    mouseEmitter.on("mouse", handler);
    return () => { mouseEmitter.removeListener("mouse", handler); };
  }, [mouseEmitter, clampedScrollBy]);

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
    if (key.ctrl && input === "r") {
      setActiveOverlay((prev) => prev === "prose" ? "none" : "prose");
      return;
    }
    if (key.ctrl && input === "d") {
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
      clampedScrollBy(-10);
      setUserScrolled(true);
    }
    if (key.pageDown) {
      const atBottom = clampedScrollBy(10);
      if (atBottom) setUserScrolled(false);
    }
  });

  const addMessage = useCallback(
    (role: Message["role"], content: string, tool?: ToolData): number => {
      const id = ++messageIdCounter;
      setMessages((prev) => {
        const next = [...prev, { id, role, content, tool }];
        // Cap at 500 messages to prevent OOM in long sessions.
        // Old messages are still persisted in the session store.
        return next.length > 500 ? next.slice(-500) : next;
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
      const message = buildMonitorMessage(config, executor, metricStore);
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

  useEffect(() => {
    const onWake = (_session: unknown, _reason: string, wakeMessage: string) => {
      if (isStreamingRef.current) return;
      addMessageRef.current("system", "Agent waking up — trigger fired");
      handleSubmitRef.current(wakeMessage);
    };

    sleepManager.on("wake", onWake);
    return () => {
      sleepManager.removeListener("wake", onWake);
    };
  }, [sleepManager]);

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

  const { height, width } = useScreenSize();

  // ── Fullscreen overlays ───────────────────────────────────────
  if (activeOverlay === "tasks") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <TaskOverlay
          tasks={tasks}
          executor={executor}
          width={width}
          height={height}
          onClose={() => setActiveOverlay("none")}
        />
      </Box>
    );
  }

  if (activeOverlay === "metrics") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <MetricsOverlay
          metricData={metricData}
          metricStore={metricStore}
          width={width}
          height={height}
          onClose={() => setActiveOverlay("none")}
        />
      </Box>
    );
  }

  if (activeOverlay === "prose" && runtime.proseWatcher) {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <ProseOverlay
          proseWatcher={runtime.proseWatcher}
          width={width}
          height={height}
          focusRunId={focusProseRunId}
          onClose={() => { setActiveOverlay("none"); setFocusProseRunId(undefined); }}
        />
      </Box>
    );
  }

  if (activeOverlay === "experiments" && runtime.experimentAdapter) {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <ExperimentsOverlay
          adapter={runtime.experimentAdapter}
          executor={executor}
          width={width}
          height={height}
          onClose={() => setActiveOverlay("none")}
        />
      </Box>
    );
  }

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

        <Box flexShrink={0} flexDirection="row">
          <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
            {panelGroup === "default" && <MetricsDashboard metricData={metricData} width={Math.floor((width - 1) / 2) - 2} />}
            {panelGroup === "prose" && <ProseRunPanel runs={proseRuns} width={Math.floor((width - 1) / 2) - 2} />}
            {panelGroup === "experiments" && <ExperimentSummaryPanel summary={experimentSummary} width={Math.floor((width - 1) / 2) - 2} />}
          </Box>
          <Box width={1} flexDirection="column" alignItems="center">
            <Text color={C.primary} wrap="truncate">
              {Array.from({ length: panelHeight }, () => "│").join("\n")}
            </Text>
          </Box>
          <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
            {panelGroup === "default" && <TaskListPanel tasks={tasks} resources={resourceData} width={Math.floor((width - 1) / 2) - 2} />}
            {panelGroup === "prose" && <ProseStepPanel run={activeProseRun} width={Math.floor((width - 1) / 2) - 2} />}
            {panelGroup === "experiments" && <ExperimentLeaderboardPanel experiments={experimentList} width={Math.floor((width - 1) / 2) - 2} />}
          </Box>
        </Box>

        <Box flexShrink={0}><HRule /></Box>

        {/* Chat area — ScrollView handles clipping and scrolling */}
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
              <ScrollView ref={scrollRef}>
                <ConversationPanel
                  messages={messages}
                  isStreaming={isStreaming}
                />
              </ScrollView>
            )}
          </Box>
          {stickyNotes.length > 0 && (
            <Box flexShrink={0}>
              <StickyNotesPanel notes={stickyNotes} width={Math.min(30, Math.floor(width * 0.25))} />
            </Box>
          )}
        </Box>

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
function HeaderWithPanels({ width, panelGroup }: { width: number; panelGroup: PanelGroup }) {
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
}

const SHIMMER_INTERVAL = 80;
const SHIMMER_PAUSE = 20; // extra frames of pause after sweep

function ShimmerLogo({ text }: { text: string }) {
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
}
