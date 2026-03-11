/**
 * `helios init` — initialize a project with a helios.json config file.
 */

import { Effect, Option } from "effect";
import { Command, Options } from "@effect/cli";
import type { ProjectConfig } from "../config/project.js";

const providerOpt = Options.choice("provider", ["claude", "openai"]).pipe(
  Options.withAlias("P"),
  Options.withDescription("Default provider for this project"),
  Options.optional,
);

const modelOpt = Options.text("model").pipe(
  Options.withAlias("m"),
  Options.withDescription("Default model for this project"),
  Options.optional,
);

const machineOpt = Options.text("machine").pipe(
  Options.withDescription("Default machine for experiments"),
  Options.optional,
);

export const initCmd = Command.make(
  "init",
  { provider: providerOpt, model: modelOpt, machine: machineOpt },
  ({ provider, model, machine }) =>
    Effect.promise(async () => {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { writeProjectConfig } = await import("../config/project.js");

      const dir = process.cwd();
      const configPath = join(dir, "helios.json");

      if (existsSync(configPath)) {
        console.log(`helios.json already exists in ${dir}`);
        console.log("Edit it directly or delete it and re-run 'helios init'.");
        return;
      }

      const config: ProjectConfig = {};
      if (Option.isSome(provider)) config.provider = provider.value as "claude" | "openai";
      if (Option.isSome(model)) config.model = model.value;
      if (Option.isSome(machine)) config.defaultMachine = machine.value;

      // Sensible defaults
      config.metricNames = ["loss", "acc", "lr"];

      writeProjectConfig(dir, config);
      console.log(`Created helios.json in ${dir}`);
      console.log("\nEdit it to configure:");
      console.log("  - provider/model defaults");
      console.log("  - metric names and patterns to track");
      console.log("  - notification channels (desktop, webhook, command)");
      console.log("  - project-specific agent instructions");
    }),
);
