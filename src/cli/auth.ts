/**
 * `helios auth` subcommands — login, logout, status.
 */

import { Effect, Option } from "effect";
import { Command, Options } from "@effect/cli";

// ── helios auth login ────────────────────────────────────

const loginProvider = Options.choice("provider", ["claude", "openai"]).pipe(
  Options.withAlias("P"),
  Options.withDescription("Provider to authenticate with"),
  Options.optional,
);

export const login = Command.make(
  "login",
  { provider: loginProvider },
  ({ provider }) =>
    Effect.promise(async () => {
      const providerName = Option.getOrElse(provider, () => "claude") as "claude" | "openai";

      const { AuthManager } = await import("../providers/auth/auth-manager.js");
      const { OpenAIOAuth } = await import("../providers/openai/oauth.js");
      const { ClaudeProvider } = await import("../providers/claude/provider.js");
      const { OpenAIProvider } = await import("../providers/openai/provider.js");

      const authManager = new AuthManager();

      if (providerName === "openai") {
        const oauth = new OpenAIOAuth(authManager);
        authManager.registerRefreshHandler("openai", (rt) => oauth.refresh(rt));
        console.log("Starting OpenAI OAuth flow...");
        await oauth.login();
        console.log("OpenAI authentication successful.");
      } else {
        const openaiOAuth = new OpenAIOAuth(authManager);
        authManager.registerRefreshHandler("openai", (rt) => openaiOAuth.refresh(rt));
        const claude = new ClaudeProvider(authManager);
        console.log("Authenticating with Claude...");
        await claude.authenticate();
        console.log("Claude authentication successful.");
      }
    }),
);

// ── helios auth logout ───────────────────────────────────

const logoutProvider = Options.choice("provider", ["claude", "openai"]).pipe(
  Options.withAlias("P"),
  Options.withDescription("Provider to log out from (omit to clear all)"),
  Options.optional,
);

export const logout = Command.make(
  "logout",
  { provider: logoutProvider },
  ({ provider }) =>
    Effect.promise(async () => {
      const { AuthManager } = await import("../providers/auth/auth-manager.js");
      const authManager = new AuthManager();

      if (Option.isSome(provider)) {
        authManager.tokenStore.clear(provider.value as "claude" | "openai");
        console.log(`Logged out from ${provider.value}.`);
      } else {
        authManager.tokenStore.clear("claude");
        authManager.tokenStore.clear("openai");
        console.log("Logged out from all providers.");
      }
    }),
);

// ── helios auth status ───────────────────────────────────

export const status = Command.make(
  "status",
  {},
  () =>
    Effect.promise(async () => {
      const { AuthManager } = await import("../providers/auth/auth-manager.js");
      const authManager = new AuthManager();

      const result = {
        claude: {
          authenticated: authManager.isAuthenticated("claude"),
        },
        openai: {
          authenticated: authManager.isAuthenticated("openai"),
        },
      };

      console.log(JSON.stringify(result, null, 2));
    }),
);

// ── helios auth (parent command) ─────────────────────────

export const auth = Command.make("auth").pipe(
  Command.withSubcommands([login, logout, status]),
);
