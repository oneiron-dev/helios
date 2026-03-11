import { useEffect, useState, useRef } from "react";
import { Box, Text } from "ink";
import type { EventEmitter } from "node:events";
import { Layout } from "./ui/layout.js";
import { createRuntime, type HeliosRuntime } from "./init.js";
import type { Attachment } from "./providers/types.js";

interface AppProps {
  defaultProvider?: "claude" | "openai";
  claudeMode?: "cli" | "api";
  mouseEmitter?: EventEmitter;
  headless?: boolean;
  initialPrompt?: string;
  initialAttachments?: Attachment[];
  resumeSessionId?: string;
  continueSession?: boolean;
  model?: string;
}

export function App({
  defaultProvider, claudeMode, mouseEmitter, headless,
  initialPrompt, initialAttachments, resumeSessionId, continueSession, model,
}: AppProps) {
  const [runtime, setRuntime] = useState<HeliosRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stable refs for values used in the effect but that shouldn't trigger re-init
  const modelRef = useRef(model);
  modelRef.current = model;
  const resumeRef = useRef(resumeSessionId);
  resumeRef.current = resumeSessionId;
  const continueRef = useRef(continueSession);
  continueRef.current = continueSession;

  useEffect(() => {
    let aborted = false;
    let cleanup: (() => void) | undefined;

    createRuntime({ provider: defaultProvider, claudeMode }).then(async (rt) => {
      if (aborted) { rt.cleanup(); return; }
      cleanup = rt.cleanup;

      // Apply model override before session start
      if (modelRef.current) {
        await rt.orchestrator.setModel(modelRef.current);
      }

      // Resume or continue session if requested
      if (resumeRef.current) {
        await rt.orchestrator.resumeSession(resumeRef.current).catch((err) => {
          process.stderr.write(`Failed to resume session: ${err}\n`);
        });
      } else if (continueRef.current) {
        const sessions = rt.orchestrator.sessionStore.listSessions(1);
        if (sessions.length > 0) {
          await rt.orchestrator.resumeSession(sessions[0].id).catch((err) => {
            process.stderr.write(`Failed to continue session: ${err}\n`);
          });
        }
      }

      if (!aborted) setRuntime(rt);
    }).catch((err) => {
      if (!aborted) setError(err instanceof Error ? err.message : String(err));
    });

    return () => { aborted = true; cleanup?.(); };
  }, [defaultProvider, claudeMode]);

  if (error) {
    return (
      <Box padding={1}>
        <Text color="red">Failed to start Helios: {error}</Text>
      </Box>
    );
  }

  if (!runtime) {
    return (
      <Box padding={1}>
        <Text color="yellow">Starting Helios...</Text>
      </Box>
    );
  }

  return (
    <Layout
      runtime={runtime}
      mouseEmitter={mouseEmitter}
      headless={headless}
      initialPrompt={initialPrompt}
      initialAttachments={initialAttachments}
    />
  );
}
