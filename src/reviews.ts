// Pull-request review-submission summarization.
//
// A "review" is a submitted review event (Approve / Request changes / Comment /
// Dismissed / Pending), distinct from the inline comment threads or top-level
// issue comments those reviews may carry. A review with state COMMENTED (e.g. a
// bot re-review posting a finding, or a human who picks "Comment" instead of
// "Approve"/"Request changes") does NOT move the PR's reviewDecision and is not
// surfaced by any comment-listing tool, so it must be read from the reviews
// endpoint directly.

/** GitHub review submission states. */
export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export interface ReviewSummary {
  id: number;
  author: string | null;
  state: string;
  body: string;
  submitted_at: string | null;
  commit_id: string | null;
  html_url?: string;
}

/** Trim a raw REST review object to the fields callers need. */
export function summarizeReview(review: any): ReviewSummary {
  return {
    id: review.id,
    author: review.user?.login ?? null,
    state: review.state,
    body: review.body ?? "",
    submitted_at: review.submitted_at ?? null,
    commit_id: review.commit_id ?? null,
    html_url: review.html_url,
  };
}

/** Count reviews by state (uppercased) for a quick at-a-glance summary. */
export function countReviewStates(
  reviews: ReviewSummary[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const review of reviews) {
    const key = (review.state ?? "UNKNOWN").toUpperCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
