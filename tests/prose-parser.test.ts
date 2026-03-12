import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStateMd } from "../src/prose/parser.js";
import assert from "node:assert";
import { test, describe } from "node:test";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("parseStateMd", () => {
  test("parses running state with 2 complete + 1 running step", () => {
    const content = readFileSync(join(FIXTURES, "state-running.md"), "utf-8");
    const result = parseStateMd(content);

    assert.strictEqual(result.status, "running");
    assert.strictEqual(result.steps.length, 3);
    assert.strictEqual(result.steps[0].label, "prepare_data");
    assert.strictEqual(result.steps[0].status, "complete");
    assert.strictEqual(result.steps[1].label, "configure_sweep");
    assert.strictEqual(result.steps[1].status, "complete");
    assert.strictEqual(result.steps[2].label, "train_model");
    assert.strictEqual(result.steps[2].status, "running");
  });

  test("parses parallel block with substeps", () => {
    const content = readFileSync(join(FIXTURES, "state-parallel.md"), "utf-8");
    const result = parseStateMd(content);

    assert.strictEqual(result.status, "running");
    // Step 1 (complete), step 2 (parallel block, complete), step 3 (running)
    assert.ok(result.steps.length >= 2);

    const step1 = result.steps.find((s) => s.number === 1);
    assert.ok(step1);
    assert.strictEqual(step1.status, "complete");

    // Step 2 should have substeps from the parallel block
    const step2 = result.steps.find((s) => s.number === 2);
    assert.ok(step2);
    assert.ok(step2.substeps);
    assert.deepStrictEqual(step2.substeps, ["screen", "train"]);
    assert.strictEqual(step2.status, "complete");
  });

  test("parses done state with end marker", () => {
    const content = readFileSync(join(FIXTURES, "state-done.md"), "utf-8");
    const result = parseStateMd(content);

    assert.strictEqual(result.status, "done");
    assert.strictEqual(result.steps.length, 5);
    assert.ok(result.steps.every((s) => s.status === "complete"));
    assert.ok(result.lastLine.startsWith("---end"));
  });

  test("parses error state with error marker", () => {
    const content = readFileSync(join(FIXTURES, "state-error.md"), "utf-8");
    const result = parseStateMd(content);

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.steps.length, 3);
    assert.strictEqual(result.steps[0].status, "complete");
    assert.strictEqual(result.steps[1].status, "complete");
    // Step 3 was running but error occurred
    assert.ok(result.lastLine.includes("timeout"));
  });

  test("handles empty content", () => {
    const result = parseStateMd("");

    assert.strictEqual(result.status, "running");
    assert.strictEqual(result.steps.length, 0);
    assert.strictEqual(result.lastLine, "");
  });
});
