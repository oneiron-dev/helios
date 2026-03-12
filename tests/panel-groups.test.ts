import { describe, it, expect } from "bun:test";
import type { PanelGroup } from "../src/ui/types.js";

/**
 * Pure logic extracted from layout.tsx for testability.
 * Mirrors the availableGroups computation and cycling logic.
 */
function computeAvailableGroups(opts: {
  hasProseWatcher: boolean;
  hasExperimentAdapter: boolean;
}): PanelGroup[] {
  const groups: PanelGroup[] = ["default"];
  if (opts.hasProseWatcher) groups.push("prose");
  if (opts.hasExperimentAdapter) groups.push("experiments");
  return groups;
}

function cycleGroup(current: PanelGroup, available: PanelGroup[]): PanelGroup {
  const idx = available.indexOf(current);
  return available[(idx + 1) % available.length];
}

describe("computeAvailableGroups", () => {
  it("returns only default when both adapters are absent", () => {
    expect(computeAvailableGroups({ hasProseWatcher: false, hasExperimentAdapter: false }))
      .toEqual(["default"]);
  });

  it("includes prose when proseWatcher is present", () => {
    expect(computeAvailableGroups({ hasProseWatcher: true, hasExperimentAdapter: false }))
      .toEqual(["default", "prose"]);
  });

  it("includes experiments when experimentAdapter is present", () => {
    expect(computeAvailableGroups({ hasProseWatcher: false, hasExperimentAdapter: true }))
      .toEqual(["default", "experiments"]);
  });

  it("includes all three when both are present", () => {
    expect(computeAvailableGroups({ hasProseWatcher: true, hasExperimentAdapter: true }))
      .toEqual(["default", "prose", "experiments"]);
  });
});

describe("cycleGroup", () => {
  it("cycles default → prose → experiments → default", () => {
    const all: PanelGroup[] = ["default", "prose", "experiments"];
    expect(cycleGroup("default", all)).toBe("prose");
    expect(cycleGroup("prose", all)).toBe("experiments");
    expect(cycleGroup("experiments", all)).toBe("default");
  });

  it("stays on default when only default available", () => {
    expect(cycleGroup("default", ["default"])).toBe("default");
  });

  it("cycles between two groups", () => {
    const two: PanelGroup[] = ["default", "prose"];
    expect(cycleGroup("default", two)).toBe("prose");
    expect(cycleGroup("prose", two)).toBe("default");
  });

  it("falls back to first group if current not in available", () => {
    // indexOf returns -1, (-1+1)%len = 0 → first element
    expect(cycleGroup("experiments", ["default", "prose"])).toBe("default");
  });
});
