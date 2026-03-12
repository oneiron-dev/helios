import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProseBin } from "../src/prose/launcher.js";

const TEST_DIR = join(tmpdir(), `helios-launcher-test-${Date.now()}`);

describe("resolveProseBin", () => {
  const origProseBin = process.env.PROSE_BIN;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Restore original env
    if (origProseBin !== undefined) {
      process.env.PROSE_BIN = origProseBin;
    } else {
      delete process.env.PROSE_BIN;
    }
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns PROSE_BIN when set to an existing file", () => {
    const fakeBin = join(TEST_DIR, "prose");
    writeFileSync(fakeBin, "#!/bin/sh\necho fake", { mode: 0o755 });

    process.env.PROSE_BIN = fakeBin;
    expect(resolveProseBin()).toBe(fakeBin);
  });

  it("throws when PROSE_BIN points to a non-existent file", () => {
    process.env.PROSE_BIN = join(TEST_DIR, "does-not-exist");
    expect(() => resolveProseBin()).toThrow(/does not exist/);
  });
});
