import {
  countReviewStates,
  summarizeReview,
  type ReviewSummary,
} from "../src/reviews.js";

// All examples use generic placeholders only. Do not introduce real user
// identities (names, logins, emails) into this file.

describe("summarizeReview", () => {
  it("extracts the review submission fields callers need", () => {
    const raw = {
      id: 4242,
      user: { login: "reviewer-one" },
      state: "COMMENTED",
      body: "Priority: this regresses X.",
      submitted_at: "2026-07-31T12:00:00Z",
      commit_id: "abc123",
      html_url: "https://github.test/pr/1#pullrequestreview-4242",
      // fields we deliberately drop:
      author_association: "MEMBER",
    };

    expect(summarizeReview(raw)).toEqual({
      id: 4242,
      author: "reviewer-one",
      state: "COMMENTED",
      body: "Priority: this regresses X.",
      submitted_at: "2026-07-31T12:00:00Z",
      commit_id: "abc123",
      html_url: "https://github.test/pr/1#pullrequestreview-4242",
    });
  });

  it("tolerates a missing author, body, submitted_at, and commit_id", () => {
    // A PENDING review (not yet submitted) has no submitted_at and often no
    // body; a ghost author has no user.
    expect(
      summarizeReview({ id: 7, state: "PENDING", html_url: "u" })
    ).toEqual({
      id: 7,
      author: null,
      state: "PENDING",
      body: "",
      submitted_at: null,
      commit_id: null,
      html_url: "u",
    });
  });
});

describe("countReviewStates", () => {
  it("tallies reviews by state", () => {
    const reviews = [
      { state: "APPROVED" },
      { state: "COMMENTED" },
      { state: "COMMENTED" },
      { state: "CHANGES_REQUESTED" },
    ] as ReviewSummary[];

    expect(countReviewStates(reviews)).toEqual({
      APPROVED: 1,
      COMMENTED: 2,
      CHANGES_REQUESTED: 1,
    });
  });

  it("returns an empty tally for no reviews", () => {
    expect(countReviewStates([])).toEqual({});
  });
});
