import { describe, it, expect, mock } from "bun:test";
import { execSpecToShellCommand, executeAction } from "../src/experiments/action-executor.js";
import type { ExecSpec, OperatorAction, Experiment } from "../src/experiments/types.js";
import type { RemoteExecutor } from "../src/remote/executor.js";
import type { BackgroundProcess } from "../src/remote/types.js";

// ─── execSpecToShellCommand ──────────────────────────

describe("execSpecToShellCommand", () => {
  it("simple argv", () => {
    const spec: ExecSpec = { argv: ["python", "-m", "train"] };
    expect(execSpecToShellCommand(spec)).toBe("'python' '-m' 'train'");
  });

  it("with env", () => {
    const spec: ExecSpec = { argv: ["python"], env: { FOO: "bar" } };
    expect(execSpecToShellCommand(spec)).toBe("FOO='bar' 'python'");
  });

  it("with cwd", () => {
    const spec: ExecSpec = { argv: ["ls"], cwd: "/tmp" };
    expect(execSpecToShellCommand(spec)).toBe("cd '/tmp' && 'ls'");
  });

  it("shell-quotes special chars in argv", () => {
    const spec: ExecSpec = { argv: ["echo", "hello world", "it's"] };
    const cmd = execSpecToShellCommand(spec);
    // spaces are safe inside single quotes
    expect(cmd).toContain("'hello world'");
    // embedded single quote is escaped via '\''
    expect(cmd).toContain("'it'\\''s'");
  });

  it("combined: env + cwd + argv", () => {
    const spec: ExecSpec = {
      argv: ["python", "train.py"],
      cwd: "/workspace",
      env: { CUDA: "0", SEED: "42" },
    };
    const cmd = execSpecToShellCommand(spec);
    expect(cmd).toContain("CUDA='0'");
    expect(cmd).toContain("SEED='42'");
    expect(cmd).toContain("cd '/workspace' &&");
    expect(cmd).toContain("'python' 'train.py'");
  });

  it("multiple env vars appear before argv", () => {
    const spec: ExecSpec = {
      argv: ["run"],
      env: { A: "1", B: "2" },
    };
    const cmd = execSpecToShellCommand(spec);
    const runIdx = cmd.indexOf("'run'");
    const aIdx = cmd.indexOf("A='1'");
    const bIdx = cmd.indexOf("B='2'");
    expect(aIdx).toBeLessThan(runIdx);
    expect(bIdx).toBeLessThan(runIdx);
  });
});

// ─── executeAction ───────────────────────────────────

describe("executeAction", () => {
  it("calls execBackground with correct command and grouping", async () => {
    const spec: ExecSpec = { argv: ["python", "train.py"], env: { LR: "0.01" } };

    const fakeProc: BackgroundProcess = {
      pid: 123,
      machineId: "local",
      command: "LR='0.01' 'python' 'train.py'",
      startedAt: Date.now(),
    };

    const execBackground = mock(() => Promise.resolve(fakeProc));

    const mockExecutor = { execBackground } as unknown as RemoteExecutor;

    const action: OperatorAction = {
      name: "retrain",
      label: "Retrain",
      buildExec: () => spec,
    };

    const experiment: Experiment = {
      id: "candidate_42",
      status: "accepted",
      statusColor: "success",
      compositeScore: 1.5,
      metrics: {},
      description: "test experiment",
      metadata: {},
    };

    const result = await executeAction(action, experiment, mockExecutor);

    expect(execBackground).toHaveBeenCalledTimes(1);

    const [machineId, command, logPath, opts] = execBackground.mock.calls[0];
    expect(machineId).toBe("local");
    expect(command).toBe("LR='0.01' 'python' 'train.py'");
    expect(logPath).toBeUndefined();
    expect(opts).toEqual({
      groupId: "exp:candidate_42",
      groupLabel: "Retrain: candidate_42",
    });

    expect(result).toBe(fakeProc);
  });
});
