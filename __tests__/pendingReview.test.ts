import {
  describePendingReviewFailure,
  PendingReviewCandidate,
  planApprovalWithPendingReview,
  resolvePendingReview,
  validateReviewCommentDrafts,
  ReviewCommentDraft,
} from "../src/pendingReview.js";

// All examples use generic placeholders only. Do not introduce real user
// identities (names, logins, emails) into this file.

function review(
  overrides: Partial<PendingReviewCandidate> = {}
): PendingReviewCandidate {
  return {
    id: 1,
    node_id: "PRR_node1",
    state: "PENDING",
    user: { login: "octocat" },
    ...overrides,
  };
}

describe("resolvePendingReview", () => {
  it("finds the user's single pending review", () => {
    const pending = review({ id: 42 });
    const result = resolvePendingReview(
      [review({ id: 1, state: "APPROVED" }), pending],
      "octocat"
    );
    expect(result).toEqual({ kind: "found", review: pending });
  });

  it("ignores pending reviews by other users", () => {
    const result = resolvePendingReview(
      [review({ user: { login: "hubot" } })],
      "octocat"
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("ignores the user's submitted reviews", () => {
    const result = resolvePendingReview(
      [
        review({ state: "APPROVED" }),
        review({ state: "COMMENTED" }),
        review({ state: "CHANGES_REQUESTED" }),
        review({ state: "DISMISSED" }),
      ],
      "octocat"
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("returns none for an empty review list", () => {
    expect(resolvePendingReview([], "octocat")).toEqual({ kind: "none" });
  });

  it("returns ambiguous when multiple pending reviews exist", () => {
    const first = review({ id: 1 });
    const second = review({ id: 2 });
    const result = resolvePendingReview([first, second], "octocat");
    expect(result).toEqual({ kind: "ambiguous", reviews: [first, second] });
  });

  it("handles reviews with missing user info", () => {
    const result = resolvePendingReview(
      [review({ user: null }), review({ user: {} })],
      "octocat"
    );
    expect(result).toEqual({ kind: "none" });
  });
});

describe("describePendingReviewFailure", () => {
  it("explains how to start a pending review when none exists", () => {
    const message = describePendingReviewFailure(
      { kind: "none" },
      "octocat",
      7
    );
    expect(message).toContain("No pending review by octocat on PR #7");
    expect(message).toContain("createPullRequestReview");
  });

  it("lists review ids when the lookup is ambiguous", () => {
    const message = describePendingReviewFailure(
      { kind: "ambiguous", reviews: [review({ id: 10 }), review({ id: 11 })] },
      "octocat",
      7
    );
    expect(message).toContain("2 pending reviews");
    expect(message).toContain("ids: 10, 11");
    expect(message).toContain("review_id");
  });
});

describe("planApprovalWithPendingReview", () => {
  it("submits an empty draft (no body, no comments)", () => {
    expect(planApprovalWithPendingReview(review(), 0, 7)).toEqual({
      action: "submit",
    });
  });

  it("treats a whitespace-only body as empty", () => {
    expect(
      planApprovalWithPendingReview(review({ body: "   " }), 0, 7)
    ).toEqual({ action: "submit" });
  });

  it("blocks when the draft has a summary body", () => {
    const plan = planApprovalWithPendingReview(
      review({ id: 42, body: "WIP notes" }),
      0,
      7
    );
    expect(plan.action).toBe("block");
    if (plan.action === "block") {
      expect(plan.reason).toContain("a summary body");
      expect(plan.reason).toContain("PR #7");
      expect(plan.reason).toContain("review 42");
      expect(plan.reason).toContain("submitPullRequestReview");
      expect(plan.reason).toContain("deletePendingReview");
    }
  });

  it("blocks when the draft has comments, with singular wording", () => {
    const plan = planApprovalWithPendingReview(review(), 1, 7);
    expect(plan.action).toBe("block");
    if (plan.action === "block") {
      expect(plan.reason).toContain("1 draft comment already exists");
    }
  });

  it("blocks when the draft has both body and comments", () => {
    const plan = planApprovalWithPendingReview(
      review({ body: "WIP notes" }),
      3,
      7
    );
    expect(plan.action).toBe("block");
    if (plan.action === "block") {
      expect(plan.reason).toContain("a summary body and 3 draft comments");
    }
  });
});

describe("validateReviewCommentDrafts", () => {
  const valid: ReviewCommentDraft = {
    path: "src/example.ts",
    body: "Consider renaming this.",
    line: 12,
  };

  it("accepts a minimal valid draft", () => {
    expect(validateReviewCommentDrafts([valid])).toEqual([]);
  });

  it("accepts a multi-line draft with start_line <= line", () => {
    expect(
      validateReviewCommentDrafts([
        { ...valid, start_line: 10, side: "RIGHT", start_side: "RIGHT" },
      ])
    ).toEqual([]);
  });

  it("accepts an empty list", () => {
    expect(validateReviewCommentDrafts([])).toEqual([]);
  });

  it("flags a missing path", () => {
    const problems = validateReviewCommentDrafts([
      { ...valid, path: "" },
    ]);
    expect(problems).toEqual(["comments[0]: path is required"]);
  });

  it("flags a missing body", () => {
    const problems = validateReviewCommentDrafts([
      { ...valid, body: "   " },
    ]);
    expect(problems).toEqual(["comments[0]: body is required"]);
  });

  it("flags a missing line", () => {
    const problems = validateReviewCommentDrafts([
      { path: "src/example.ts", body: "note" } as ReviewCommentDraft,
    ]);
    expect(problems).toEqual(["comments[0]: line is required"]);
  });

  it("flags start_line greater than line", () => {
    const problems = validateReviewCommentDrafts([
      { ...valid, line: 5, start_line: 9 },
    ]);
    expect(problems).toEqual([
      "comments[0]: start_line (9) must be <= line (5)",
    ]);
  });

  it("prefixes problems with the draft index", () => {
    const problems = validateReviewCommentDrafts([
      valid,
      { ...valid, path: "" },
      { ...valid, body: "" },
    ]);
    expect(problems).toEqual([
      "comments[1]: path is required",
      "comments[2]: body is required",
    ]);
  });
});
