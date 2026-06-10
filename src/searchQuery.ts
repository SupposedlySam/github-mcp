// Helpers for building GitHub search-API queries for PR filtering.
//
// GitHub's "list pull requests" REST endpoint has no author filter, so an
// author-scoped listing goes through the search API instead
// (`GET /search/issues` with `is:pr`). This mirrors pushing filters to the
// server rather than fetching every PR and filtering client-side (which is
// both slow and token-heavy).

/** Pull request state filter accepted by the tools. */
export type PullRequestStateFilter = "open" | "closed" | "merged" | "all";

/**
 * Quote a search qualifier value when it contains whitespace, escaping
 * embedded double quotes so the resulting query stays well-formed.
 */
function quoteValue(value: string): string {
  const escaped = value.replace(/"/g, '\\"');
  return /\s/.test(escaped) ? `"${escaped}"` : escaped;
}

/**
 * Build a search query for pull requests in a single repository, optionally
 * filtered by author login and state.
 *
 * State mapping:
 * - `open`   -> `is:open`
 * - `closed` -> `is:closed` (includes merged PRs)
 * - `merged` -> `is:merged`
 * - `all` / undefined -> no state qualifier
 */
export function buildPullRequestSearchQuery(
  owner: string,
  repo: string,
  options: { author?: string; state?: PullRequestStateFilter } = {}
): string {
  const parts = [`repo:${owner}/${repo}`, "is:pr"];

  const state = options.state;
  if (state === "open") parts.push("is:open");
  else if (state === "closed") parts.push("is:closed");
  else if (state === "merged") parts.push("is:merged");

  const author = options.author?.trim();
  if (author && author.length > 0) {
    parts.push(`author:${quoteValue(author.replace(/^@/, ""))}`);
  }

  return parts.join(" ");
}

/**
 * Build a search query for open PRs where the given user is requested as a
 * reviewer. Defaults to the authenticated user (`@me`). Optionally scoped to
 * an owner (org/user) or an explicit repo list.
 */
export function buildPendingReviewQuery(options: {
  reviewer?: string;
  owner?: string;
  repositoryList?: string[];
} = {}): string {
  const reviewer = options.reviewer?.trim().replace(/^@(?!me$)/, "") || "@me";
  const parts = ["is:pr", "is:open", `review-requested:${reviewer}`];

  if (options.repositoryList && options.repositoryList.length > 0) {
    for (const repo of options.repositoryList) {
      const qualified =
        repo.includes("/") || !options.owner
          ? repo
          : `${options.owner}/${repo}`;
      parts.push(`repo:${qualified}`);
    }
  } else if (options.owner) {
    parts.push(`org:${options.owner}`);
  }

  return parts.join(" ");
}
