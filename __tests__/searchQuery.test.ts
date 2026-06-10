import {
  buildPendingReviewQuery,
  buildPullRequestSearchQuery,
} from "../src/searchQuery.js";

// All examples use generic placeholders only. Do not introduce real user
// identities (names, logins, emails) into this file.

describe("buildPullRequestSearchQuery", () => {
  it("builds a repo-scoped PR query with no filters", () => {
    expect(buildPullRequestSearchQuery("example-org", "example-repo")).toBe(
      "repo:example-org/example-repo is:pr"
    );
  });

  it("adds an author qualifier", () => {
    expect(
      buildPullRequestSearchQuery("example-org", "example-repo", {
        author: "octocat",
      })
    ).toBe("repo:example-org/example-repo is:pr author:octocat");
  });

  it("strips a leading @ from the author login", () => {
    expect(
      buildPullRequestSearchQuery("example-org", "example-repo", {
        author: "@octocat",
      })
    ).toBe("repo:example-org/example-repo is:pr author:octocat");
  });

  it("maps the merged state to is:merged", () => {
    expect(
      buildPullRequestSearchQuery("example-org", "example-repo", {
        state: "merged",
      })
    ).toBe("repo:example-org/example-repo is:pr is:merged");
  });

  it("combines state and author qualifiers", () => {
    expect(
      buildPullRequestSearchQuery("example-org", "example-repo", {
        state: "open",
        author: "octocat",
      })
    ).toBe("repo:example-org/example-repo is:pr is:open author:octocat");
  });

  it("omits the state qualifier for all", () => {
    expect(
      buildPullRequestSearchQuery("example-org", "example-repo", {
        state: "all",
        author: "octocat",
      })
    ).toBe("repo:example-org/example-repo is:pr author:octocat");
  });

  it("ignores a whitespace-only author", () => {
    expect(
      buildPullRequestSearchQuery("example-org", "example-repo", {
        author: "   ",
      })
    ).toBe("repo:example-org/example-repo is:pr");
  });
});

describe("buildPendingReviewQuery", () => {
  it("defaults to the authenticated user with no scope", () => {
    expect(buildPendingReviewQuery()).toBe(
      "is:pr is:open review-requested:@me"
    );
  });

  it("scopes to an org when owner is provided", () => {
    expect(buildPendingReviewQuery({ owner: "example-org" })).toBe(
      "is:pr is:open review-requested:@me org:example-org"
    );
  });

  it("uses repo qualifiers instead of org when a repository list is given", () => {
    expect(
      buildPendingReviewQuery({
        owner: "example-org",
        repositoryList: ["repo-one", "other-org/repo-two"],
      })
    ).toBe(
      "is:pr is:open review-requested:@me repo:example-org/repo-one repo:other-org/repo-two"
    );
  });

  it("accepts an explicit reviewer login", () => {
    expect(buildPendingReviewQuery({ reviewer: "octocat" })).toBe(
      "is:pr is:open review-requested:octocat"
    );
    expect(buildPendingReviewQuery({ reviewer: "@octocat" })).toBe(
      "is:pr is:open review-requested:octocat"
    );
  });

  it("keeps @me untouched", () => {
    expect(buildPendingReviewQuery({ reviewer: "@me" })).toBe(
      "is:pr is:open review-requested:@me"
    );
  });
});
