import {
  buildDiscussionThread,
  buildReviewThreads,
  findThreadsWithNewReplies,
  ThreadComment,
} from "../src/threads.js";

// All examples use generic placeholders only. Do not introduce real user
// identities (names, logins, emails) into this file.

const comment = (
  id: number,
  login: string,
  createdAt: string,
  options: Partial<ThreadComment> = {}
): ThreadComment => ({
  id,
  in_reply_to_id: null,
  user: { login },
  body: `comment ${id}`,
  created_at: createdAt,
  ...options,
});

describe("buildReviewThreads", () => {
  it("groups replies under their root via in_reply_to_id", () => {
    const comments = [
      comment(1, "octocat", "2026-01-01T00:00:00Z", { path: "a.dart", line: 5 }),
      comment(2, "hubot", "2026-01-02T00:00:00Z", { in_reply_to_id: 1 }),
      comment(3, "octocat", "2026-01-03T00:00:00Z", { in_reply_to_id: 2 }),
      comment(4, "hubot", "2026-01-01T12:00:00Z", { path: "b.dart", line: 9 }),
    ];

    const threads = buildReviewThreads(comments);
    expect(threads).toHaveLength(2);

    const first = threads.find((t) => t.thread_id === 1);
    expect(first?.comments.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(first?.location).toEqual({ path: "a.dart", line: 5, start_line: undefined });

    const second = threads.find((t) => t.thread_id === 4);
    expect(second?.comments.map((c) => c.id)).toEqual([4]);
  });

  it("treats an orphaned reply as its own thread root", () => {
    const comments = [
      comment(7, "octocat", "2026-01-01T00:00:00Z", { in_reply_to_id: 999 }),
    ];
    const threads = buildReviewThreads(comments);
    expect(threads).toHaveLength(1);
    expect(threads[0].thread_id).toBe(7);
  });
});

describe("buildDiscussionThread", () => {
  it("returns undefined when there are no issue comments", () => {
    expect(buildDiscussionThread([])).toBeUndefined();
  });

  it("sorts issue comments chronologically into one pseudo-thread", () => {
    const thread = buildDiscussionThread([
      comment(2, "hubot", "2026-01-02T00:00:00Z"),
      comment(1, "octocat", "2026-01-01T00:00:00Z"),
    ]);
    expect(thread?.kind).toBe("discussion");
    expect(thread?.comments.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("findThreadsWithNewReplies", () => {
  it("finds replies from others after my last comment", () => {
    const threads = buildReviewThreads([
      comment(1, "octocat", "2026-01-01T00:00:00Z", { path: "a.dart", line: 3 }),
      comment(2, "hubot", "2026-01-02T00:00:00Z", { in_reply_to_id: 1 }),
      comment(3, "hubot", "2026-01-03T00:00:00Z", { in_reply_to_id: 1 }),
    ]);

    const result = findThreadsWithNewReplies(threads, "octocat");
    expect(result.my_threads).toBe(1);
    expect(result.threads_with_new_replies).toBe(1);
    expect(result.total_new_replies).toBe(2);
    expect(result.threads[0].new_replies.map((r) => r.id)).toEqual([2, 3]);
  });

  it("ignores threads where my comment is the most recent", () => {
    const threads = buildReviewThreads([
      comment(1, "hubot", "2026-01-01T00:00:00Z", { path: "a.dart", line: 3 }),
      comment(2, "octocat", "2026-01-02T00:00:00Z", { in_reply_to_id: 1 }),
    ]);

    const result = findThreadsWithNewReplies(threads, "octocat");
    expect(result.my_threads).toBe(1);
    expect(result.threads_with_new_replies).toBe(0);
    expect(result.total_new_replies).toBe(0);
  });

  it("ignores threads I never commented in", () => {
    const threads = buildReviewThreads([
      comment(1, "hubot", "2026-01-01T00:00:00Z"),
      comment(2, "hubot", "2026-01-02T00:00:00Z", { in_reply_to_id: 1 }),
    ]);

    const result = findThreadsWithNewReplies(threads, "octocat");
    expect(result.my_threads).toBe(0);
    expect(result.threads_with_new_replies).toBe(0);
  });
});
