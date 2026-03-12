import { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import { useScreenSize } from "fullscreen-ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { ConversationPanel } from "./panels/conversation.js";
import { TaskListPanel } from "./panels/task-list.js";
import { MetricsDashboard } from "./panels/metrics-dashboard.js";
import { StatusBar } from "./components/status-bar.js";
import { InputBar } from "./components/input-bar.js";
import { C, G, HRule } from "./theme.js";
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
import { handleSlashCommand } from "./commands.js";
import { pollTaskStatuses, handleFinishedTasks, buildMonitorMessage } from "../core/task-poller.js";
import type { Message, ToolData, TaskInfo } from "./types.js";

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
  const scrollRef = useRef<ScrollViewRef>(null);

  const [userScrolled, setUserScrolled] = useState(false);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [metricData, setMetricData] = useState<Map<string, number[]>>(new Map());
  const [stickyNotes, setStickyNotes] = useState<StickyNote[]>([]);
  const [activeOverlay, setActiveOverlay] = useState<"none" | "tasks" | "metrics" | "prose" | "experiments">("none");
  const [resourceData, setResourceData] = useState<Map<string, import("../metrics/resources.js").MachineResources>>(new Map());
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);

  // Check for updates on mount (non-blocking)
  useEffect(() => {
    checkForUpdate().then((v) => { if (v) setUpdateAvailable(v); }).catch(() => {});
  }, []);

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
      setMessages((prev) => [...prev, { id, role, content, tool }]);
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
          stickyManager, setStickyNotes, executor,
          proseWatcher: runtime.proseWatcher,
          experimentAdapter: runtime.experimentAdapter,
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
        addMessage(
          "error",
          err instanceof Error ? err.message : "Unknown error",
        );
      } finally {
        setIsStreaming(false);
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

  const isSleeping = sleepManager.isSleeping;

  const metricsRows = metricData.size > 0 ? metricData.size : 1;
  const tasksRows = tasks.length > 0 ? Math.min(tasks.length, 5) : 1;
  const panelHeight = Math.max(metricsRows, tasksRows);

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
          onClose={() => setActiveOverlay("none")}
        />
      </Box>
    );
  }

  if (activeOverlay === "experiments" && runtime.experimentAdapter) {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <ExperimentsOverlay
          adapter={runtime.experimentAdapter}
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
            <HeaderWithPanels width={width} />
          )}
        </Box>

        <Box flexShrink={0} flexDirection="row">
          <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
            <MetricsDashboard metricData={metricData} width={Math.floor((width - 1) / 2) - 2} />
          </Box>
          <Box width={1} flexDirection="column" alignItems="center">
            <Text color={C.primary} wrap="truncate">
              {Array.from({ length: panelHeight }, () => "│").join("\n")}
            </Text>
          </Box>
          <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
            <TaskListPanel tasks={tasks} resources={resourceData} width={Math.floor((width - 1) / 2) - 2} />
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

        {!headless && <Box flexShrink={0}><KeyHintRule /></Box>}
        <Box flexShrink={0}><StatusBar orchestrator={orchestrator} sleepManager={sleepManager} monitorManager={monitorManager} /></Box>
        {!headless && (
          <Box flexShrink={0}>
            <InputBar
              onSubmit={handleSubmit}
              disabled={isStreaming}
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
function HeaderWithPanels({ width }: { width: number }) {
  const logo = ` ▓▒░ ${G.brand} HELIOS ░▒▓ `;
  const ver = `${VERSION} `;
  const metricsLabel = ` ⣤⣸⣿ METRICS `;
  const tasksLabel = ` ⊳ TASKS `;

  const half = Math.floor(width / 2);
  const leftFill = Math.max(0, half - logo.length - ver.length - metricsLabel.length - 1);
  const rightFill = Math.max(0, width - half - tasksLabel.length - 1);

  return (
    <Box>
      <ShimmerLogo text={logo} />
      <Text color={C.dim}>{ver}</Text>
      <Text color={C.primary}>{G.rule.repeat(leftFill)}</Text>
      <Text color={C.primary}>{metricsLabel}</Text>
      <Text color={C.primary}>{G.rule}</Text>
      <Text color={C.primary}>{G.rule.repeat(rightFill)}</Text>
      <Text color={C.primary}>{tasksLabel}</Text>
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
    const timer = setInterval(() => setFrame((f) => (f + 1) % cycleLen), SHIMMER_INTERVAL);
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
