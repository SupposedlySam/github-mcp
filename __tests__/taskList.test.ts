import {
  addTask,
  deleteTask,
  isTasksComment,
  parseTasks,
  serializeTasks,
  updateTask,
  TASKS_COMMENT_MARKER,
} from "../src/taskList.js";

const SAMPLE_BODY = [
  TASKS_COMMENT_MARKER,
  "### PR Tasks",
  "- [ ] first task",
  "- [x] second task",
  "- [ ] third task",
].join("\n");

describe("isTasksComment", () => {
  it("recognizes the managed marker", () => {
    expect(isTasksComment(SAMPLE_BODY)).toBe(true);
  });

  it("rejects ordinary comments and missing bodies", () => {
    expect(isTasksComment("just a regular checklist\n- [ ] item")).toBe(false);
    expect(isTasksComment(undefined)).toBe(false);
    expect(isTasksComment(null)).toBe(false);
  });
});

describe("parseTasks", () => {
  it("parses checklist items with 1-based ids and states", () => {
    const tasks = parseTasks(SAMPLE_BODY);
    expect(tasks).toEqual([
      { id: 1, content: "first task", state: "OPEN" },
      { id: 2, content: "second task", state: "RESOLVED" },
      { id: 3, content: "third task", state: "OPEN" },
    ]);
  });

  it("ignores non-checklist lines", () => {
    expect(parseTasks("no tasks here\njust text")).toEqual([]);
  });
});

describe("serializeTasks", () => {
  it("round-trips through parseTasks", () => {
    const tasks = parseTasks(SAMPLE_BODY);
    expect(parseTasks(serializeTasks(tasks))).toEqual(tasks);
  });

  it("includes the marker so the comment stays discoverable", () => {
    expect(serializeTasks([])).toContain(TASKS_COMMENT_MARKER);
  });
});

describe("addTask", () => {
  it("appends with the next id", () => {
    const tasks = addTask(parseTasks(SAMPLE_BODY), "fourth task");
    expect(tasks).toHaveLength(4);
    expect(tasks[3]).toEqual({ id: 4, content: "fourth task", state: "OPEN" });
  });
});

describe("updateTask", () => {
  it("updates content and state by id", () => {
    const updated = updateTask(parseTasks(SAMPLE_BODY), 1, {
      content: "renamed",
      state: "RESOLVED",
    });
    expect(updated?.[0]).toEqual({
      id: 1,
      content: "renamed",
      state: "RESOLVED",
    });
  });

  it("returns undefined for an unknown id", () => {
    expect(updateTask(parseTasks(SAMPLE_BODY), 99, { state: "OPEN" })).toBe(
      undefined
    );
  });
});

describe("deleteTask", () => {
  it("removes the task and renumbers the rest", () => {
    const remaining = deleteTask(parseTasks(SAMPLE_BODY), 2);
    expect(remaining).toEqual([
      { id: 1, content: "first task", state: "OPEN" },
      { id: 2, content: "third task", state: "OPEN" },
    ]);
  });

  it("returns undefined for an unknown id", () => {
    expect(deleteTask(parseTasks(SAMPLE_BODY), 99)).toBe(undefined);
  });
});
