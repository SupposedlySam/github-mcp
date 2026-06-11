// Helpers for GitHub PR review batching.
//
// A "pending" review is GitHub's draft state: inline comments accumulate on
// the review without sending notifications, then a single submit publishes
// everything as one review (one notification). These helpers cover the two
// pure pieces of that flow: locating a user's pending review in a review
// list, and validating batched comment drafts before they are sent.

/** Minimal review shape needed to locate a pending review. */
export interface PendingReviewCandidate {
  id: number;
  node_id?: string;
  state?: string;
  user?: { login?: string | null } | null;
  body?: string | null;
  commit_id?: string | null;
  html_url?: string | null;
}

/** Outcome of looking for a user's pending review in a review list. */
export type PendingReviewResolution =
  | { kind: "found"; review: PendingReviewCandidate }
  | { kind: "none" }
  | { kind: "ambiguous"; reviews: PendingReviewCandidate[] };

/**
 * Find the given user's pending (draft) review in a list of PR reviews.
 *
 * GitHub allows at most one pending review per user per PR, so the expected
 * outcomes are `found` and `none`; `ambiguous` is returned defensively if
 * the API ever reports more than one.
 */
export function resolvePendingReview(
  reviews: PendingReviewCandidate[],
  login: string
): PendingReviewResolution {
  const pending = reviews.filter(
    (review) => review.state === "PENDING" && review.user?.login === login
  );
  if (pending.length === 0) return { kind: "none" };
  if (pending.length === 1) return { kind: "found", review: pending[0] };
  return { kind: "ambiguous", reviews: pending };
}

/**
 * Build a human-readable error message for a failed pending-review lookup.
 */
export function describePendingReviewFailure(
  resolution: Exclude<PendingReviewResolution, { kind: "found" }>,
  login: string,
  pull_number: number
): string {
  if (resolution.kind === "none") {
    return (
      `No pending review by ${login} on PR #${pull_number}. ` +
      "Start one with createPullRequestReview (omit event) or addCommentToPendingReview."
    );
  }
  const ids = resolution.reviews.map((review) => review.id).join(", ");
  return (
    `Found ${resolution.reviews.length} pending reviews by ${login} on ` +
    `PR #${pull_number} (ids: ${ids}); pass review_id explicitly.`
  );
}

/** One inline comment in a batched review request. */
export interface ReviewCommentDraft {
  path: string;
  body: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

/**
 * Validate batched review comment drafts before sending them to GitHub.
 * Returns a list of problems (empty when all drafts are valid), each
 * prefixed with the draft's index, e.g. `comments[2]: line is required`.
 */
export function validateReviewCommentDrafts(
  drafts: ReviewCommentDraft[]
): string[] {
  const problems: string[] = [];
  drafts.forEach((draft, index) => {
    const prefix = `comments[${index}]`;
    if (!draft || typeof draft !== "object") {
      problems.push(`${prefix}: must be an object`);
      return;
    }
    if (typeof draft.path !== "string" || draft.path.trim().length === 0) {
      problems.push(`${prefix}: path is required`);
    }
    if (typeof draft.body !== "string" || draft.body.trim().length === 0) {
      problems.push(`${prefix}: body is required`);
    }
    if (typeof draft.line !== "number" || !Number.isFinite(draft.line)) {
      problems.push(`${prefix}: line is required`);
    } else if (draft.start_line !== undefined) {
      if (
        typeof draft.start_line !== "number" ||
        !Number.isFinite(draft.start_line)
      ) {
        problems.push(`${prefix}: start_line must be a number`);
      } else if (draft.start_line > draft.line) {
        problems.push(
          `${prefix}: start_line (${draft.start_line}) must be <= line (${draft.line})`
        );
      }
    }
  });
  return problems;
}
