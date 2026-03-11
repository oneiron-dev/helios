import { exec } from "node:child_process";
import { shellQuote, formatError } from "../ui/format.js";

export type NotificationChannel =
  | { type: "desktop" }
  | { type: "webhook"; url: string; method?: "GET" | "POST"; headers?: Record<string, string> }
  | { type: "command"; command: string };

export interface NotificationConfig {
  channels: NotificationChannel[];
  /** Only send notifications for these events. If empty, send all. */
  events?: ("task_complete" | "task_failed" | "metric_threshold" | "agent_idle")[];
}

export interface NotificationPayload {
  event: string;
  title: string;
  body: string;
  machineId?: string;
  pid?: number;
  metrics?: Record<string, number>;
  timestamp: number;
}

export class Notifier {
  private config: NotificationConfig;

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  async notify(payload: NotificationPayload): Promise<void> {
    const sends = this.config.channels.map((channel) =>
      this.sendToChannel(channel, payload),
    );
    await Promise.allSettled(sends);
  }

  async notifyAll(payload: NotificationPayload): Promise<void> {
    if (
      this.config.events &&
      this.config.events.length > 0 &&
      !this.config.events.includes(payload.event as any)
    ) {
      return;
    }
    await this.notify(payload);
  }

  private async sendToChannel(
    channel: NotificationChannel,
    payload: NotificationPayload,
  ): Promise<void> {
    try {
      switch (channel.type) {
        case "desktop":
          await this.sendDesktop(payload);
          break;
        case "webhook":
          await this.sendWebhook(channel, payload);
          break;
        case "command":
          await this.sendCommand(channel, payload);
          break;
      }
    } catch (err) {
      process.stderr.write(
        `[helios] notification error (${channel.type}): ${formatError(err)}\n`,
      );
    }
  }

  private sendDesktop(payload: NotificationPayload): Promise<void> {
    let cmd: string;
    if (process.platform === "darwin") {
      // AppleScript strings use backslash-escaped double quotes
      const escapeAS = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
      const script = `display notification "${escapeAS(payload.body)}" with title "${escapeAS(payload.title)}"`;
      cmd = `osascript -e ${shellQuote(script)}`;
    } else {
      cmd = `notify-send ${shellQuote(payload.title)} ${shellQuote(payload.body)}`;
    }

    return new Promise<void>((resolve) => {
      exec(cmd, (err) => {
        if (err) {
          process.stderr.write(
            `[helios] desktop notification error: ${err.message}\n`,
          );
        }
        resolve();
      });
    });
  }

  private async sendWebhook(
    channel: Extract<NotificationChannel, { type: "webhook" }>,
    payload: NotificationPayload,
  ): Promise<void> {
    const method = channel.method ?? "POST";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...channel.headers,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (method === "POST") {
        options.body = JSON.stringify(payload);
      }

      await fetch(channel.url, options);
    } catch (err) {
      process.stderr.write(
        `[helios] webhook error (${channel.url}): ${formatError(err)}\n`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private sendCommand(
    channel: Extract<NotificationChannel, { type: "command" }>,
    payload: NotificationPayload,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      exec(
        channel.command,
        {
          env: {
            ...process.env,
            HELIOS_EVENT: payload.event,
            HELIOS_TITLE: payload.title,
            HELIOS_BODY: payload.body,
          },
        },
        (err) => {
          if (err) {
            process.stderr.write(
              `[helios] command notification error: ${err.message}\n`,
            );
          }
          resolve();
        },
      );
    });
  }
}
