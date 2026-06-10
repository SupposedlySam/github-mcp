// Comment-thread assembly and reply detection for pull requests.
//
// GitHub splits PR conversation across two comment kinds:
// - Review comments (inline, anchored to a diff location) thread via
//   `in_reply_to_id`.
// - Issue comments (top-level conversation) have no threading; they are
//   grouped here into a single pseudo-thread keyed by the PR conversation.
//
// `findThreadsWithNewReplies` answers: "in threads I participated in, which
// have replies from someone else newer than my last comment?"

export interface ThreadComment {
  id: number;
  in_reply_to_id?: number | null;
  user: { login: string };
  body: string;
  created_at: string;
  path?: string;
  line?: number | null;
  start_line?: number | null;
}

export interface CommentThread {
  /** Root comment id for review threads; 0 for the issue-comment pseudo-thread. */
  thread_id: number;
  kind: "review" | "discussion";
  location: { path: string; line?: number | null; start_line?: number | null } | null;
  comments: ThreadComment[];
}

/** Group review comments into threads via in_reply_to_id chains. */
export function buildReviewThreads(
  reviewComments: ThreadComment[]
): CommentThread[] {
  const byId = new Map(reviewComments.map((c) => [c.id, c]));

  const rootOf = (comment: ThreadComment, depth = 0): number => {
    if (depth > 50 || !comment.in_reply_to_id) return comment.id;
    const parent = byId.get(comment.in_reply_to_id);
    return parent ? rootOf(parent, depth + 1) : comment.id;
  };

  const threads = new Map<number, ThreadComment[]>();
  for (const comment of reviewComments) {
    const root = rootOf(comment);
    const list = threads.get(root) ?? [];
    list.push(comment);
    threads.set(root, list);
  }

  const result: CommentThread[] = [];
  for (const [rootId, comments] of threads) {
    comments.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const root = byId.get(rootId) ?? comments[0];
    result.push({
      thread_id: rootId,
      kind: "review",
      location: root.path
        ? { path: root.path, line: root.line, start_line: root.start_line }
        : null,
      comments,
    });
  }
  return result;
}

/** Wrap issue comments as a single discussion pseudo-thread (or none). */
export function buildDiscussionThread(
  issueComments: ThreadComment[]
): CommentThread | undefined {
  if (issueComments.length === 0) return undefined;
  const sorted = [...issueComments].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  return {
    thread_id: 0,
    kind: "discussion",
    location: null,
    comments: sorted,
  };
}

export interface NewReplyThread {
  thread_id: number;
  kind: "review" | "discussion";
  location: CommentThread["location"];
  root_comment: {
    author: string;
    content: string;
    created_at: string;
  } | null;
  new_replies: Array<{
    id: number;
    author: string;
    content: string;
    created_at: string;
  }>;
}

export interface NewRepliesResult {
  my_threads: number;
  threads_with_new_replies: number;
  total_new_replies: number;
  threads: NewReplyThread[];
}

/**
 * Find threads where `selfLogin` has commented and someone else replied
 * after that user's most recent comment in the thread.
 */
export function findThreadsWithNewReplies(
  threads: CommentThread[],
  selfLogin: string
): NewRepliesResult {
  const resultThreads: NewReplyThread[] = [];
  let totalNewReplies = 0;
  let myThreads = 0;

  for (const thread of threads) {
    const mine = thread.comments.filter((c) => c.user.login === selfLogin);
    if (mine.length === 0) continue;
    myThreads += 1;

    const myLastTime = new Date(
      mine[mine.length - 1].created_at
    ).getTime();
    const newReplies = thread.comments.filter(
      (c) =>
        c.user.login !== selfLogin &&
        new Date(c.created_at).getTime() > myLastTime
    );
    if (newReplies.length === 0) continue;

    totalNewReplies += newReplies.length;
    const root = thread.comments[0];
    resultThreads.push({
      thread_id: thread.thread_id,
      kind: thread.kind,
      location: thread.location,
      root_comment: root
        ? {
            author: root.user.login,
            content: root.body,
            created_at: root.created_at,
          }
        : null,
      new_replies: newReplies.map((c) => ({
        id: c.id,
        author: c.user.login,
        content: c.body,
        created_at: c.created_at,
      })),
    });
  }

  return {
    my_threads: myThreads,
    threads_with_new_replies: resultThreads.length,
    total_new_replies: totalNewReplies,
    threads: resultThreads,
  };
}
