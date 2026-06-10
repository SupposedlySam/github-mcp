// PR task emulation via a managed markdown checklist.
//
// GitHub has no native pull-request task object (Bitbucket does). The tools
// emulate tasks with a single dedicated issue comment on the PR containing a
// markdown checklist. The comment is identified by an HTML marker so it can
// be found and rewritten on every mutation:
//
//   <!-- github-mcp:tasks -->
//   ### PR Tasks
//   - [ ] open task
//   - [x] resolved task
//
// Task ids are 1-based positions in the checklist. Deleting a task renumbers
// the tasks that follow it.

export const TASKS_COMMENT_MARKER = "<!-- github-mcp:tasks -->";
export const TASKS_COMMENT_HEADING = "### PR Tasks";

export type TaskState = "OPEN" | "RESOLVED";

export interface PrTask {
  id: number;
  content: string;
  state: TaskState;
}

const TASK_LINE_REGEX = /^- \[( |x|X)\] (.*)$/;

/** True when the comment body is the managed tasks comment. */
export function isTasksComment(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes(TASKS_COMMENT_MARKER);
}

/** Parse the managed tasks comment body into a task list. */
export function parseTasks(body: string): PrTask[] {
  const tasks: PrTask[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(TASK_LINE_REGEX);
    if (!match) continue;
    tasks.push({
      id: tasks.length + 1,
      content: match[2].trim(),
      state: match[1].toLowerCase() === "x" ? "RESOLVED" : "OPEN",
    });
  }
  return tasks;
}

/** Serialize a task list back into the managed comment body. */
export function serializeTasks(tasks: PrTask[]): string {
  const lines = [TASKS_COMMENT_MARKER, TASKS_COMMENT_HEADING];
  for (const task of tasks) {
    const box = task.state === "RESOLVED" ? "x" : " ";
    lines.push(`- [${box}] ${task.content}`);
  }
  return lines.join("\n");
}

/** Append a new task; returns the updated list (ids renumbered). */
export function addTask(
  tasks: PrTask[],
  content: string,
  state: TaskState = "OPEN"
): PrTask[] {
  const next = [...tasks, { id: tasks.length + 1, content, state }];
  return renumber(next);
}

/** Update a task's content and/or state by id. Returns undefined if absent. */
export function updateTask(
  tasks: PrTask[],
  id: number,
  changes: { content?: string; state?: TaskState }
): PrTask[] | undefined {
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) return undefined;
  const next = tasks.map((t) =>
    t.id === id
      ? {
          ...t,
          content: changes.content ?? t.content,
          state: changes.state ?? t.state,
        }
      : t
  );
  return renumber(next);
}

/** Delete a task by id. Returns undefined if absent. */
export function deleteTask(tasks: PrTask[], id: number): PrTask[] | undefined {
  if (!tasks.some((t) => t.id === id)) return undefined;
  return renumber(tasks.filter((t) => t.id !== id));
}

function renumber(tasks: PrTask[]): PrTask[] {
  return tasks.map((t, i) => ({ ...t, id: i + 1 }));
}
