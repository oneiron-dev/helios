import { describe, it, expect } from "bun:test";
import { groupTasks } from "../src/ui/overlays/task-overlay.js";
import type { TaskInfo } from "../src/ui/types.js";

function makeTask(overrides: Partial<TaskInfo> & { id: string }): TaskInfo {
  return {
    name: "task",
    status: "running",
    machineId: "local",
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("groupTasks", () => {
  it("empty array → empty array", () => {
    expect(groupTasks([])).toEqual([]);
  });

  it("all ungrouped (no groupId) → single group with groupId: null", () => {
    const tasks = [
      makeTask({ id: "t1" }),
      makeTask({ id: "t2" }),
    ];
    const groups = groupTasks(tasks);

    expect(groups).toHaveLength(1);
    expect(groups[0].groupId).toBeNull();
    expect(groups[0].tasks).toHaveLength(2);
    expect(groups[0].label).toBe("ungrouped");
  });

  it("mixed groups → correct number of groups, correct tasks in each", () => {
    const tasks = [
      makeTask({ id: "t1", groupId: "exp:a", groupLabel: "Run A" }),
      makeTask({ id: "t2", groupId: "exp:b", groupLabel: "Run B" }),
      makeTask({ id: "t3", groupId: "exp:a", groupLabel: "Run A" }),
      makeTask({ id: "t4" }), // ungrouped
    ];
    const groups = groupTasks(tasks);

    expect(groups).toHaveLength(3);

    const groupA = groups.find((g) => g.groupId === "exp:a");
    expect(groupA).toBeDefined();
    expect(groupA!.tasks).toHaveLength(2);
    expect(groupA!.tasks.map((t) => t.id)).toEqual(["t1", "t3"]);

    const groupB = groups.find((g) => g.groupId === "exp:b");
    expect(groupB).toBeDefined();
    expect(groupB!.tasks).toHaveLength(1);

    const ungrouped = groups.find((g) => g.groupId === null);
    expect(ungrouped).toBeDefined();
    expect(ungrouped!.tasks).toHaveLength(1);
    expect(ungrouped!.label).toBe("ungrouped");
  });

  it("label comes from first task's groupLabel", () => {
    const tasks = [
      makeTask({ id: "t1", groupId: "g1", groupLabel: "First Label" }),
      makeTask({ id: "t2", groupId: "g1", groupLabel: "Second Label" }),
    ];
    const groups = groupTasks(tasks);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("First Label");
  });

  it("tasks with same groupId but different groupLabel → uses first task's label", () => {
    const tasks = [
      makeTask({ id: "t1", groupId: "exp:x", groupLabel: "Alpha" }),
      makeTask({ id: "t2", groupId: "exp:x", groupLabel: "Beta" }),
      makeTask({ id: "t3", groupId: "exp:x", groupLabel: "Gamma" }),
    ];
    const groups = groupTasks(tasks);

    expect(groups).toHaveLength(1);
    expect(groups[0].groupId).toBe("exp:x");
    expect(groups[0].label).toBe("Alpha");
    expect(groups[0].tasks).toHaveLength(3);
  });

  it("groupId with no groupLabel uses groupId as label", () => {
    const tasks = [
      makeTask({ id: "t1", groupId: "exp:orphan" }),
    ];
    const groups = groupTasks(tasks);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("exp:orphan");
  });
});
