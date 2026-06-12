import {
  isContentLengthMismatchError,
  parseFullName,
  RepoMoveCache,
  sameSlug,
} from "../src/repoMove.js";

// All examples use generic placeholders only. Do not introduce real user
// identities (names, logins, emails) into this file.

describe("isContentLengthMismatchError", () => {
  it("matches the error message Octokit surfaces", () => {
    expect(
      isContentLengthMismatchError(
        new Error("Request body length does not match content-length header")
      )
    ).toBe(true);
  });

  it("matches case-insensitively within a longer message", () => {
    expect(
      isContentLengthMismatchError({
        status: 500,
        message:
          "request body length does not match content-length header (HTTP 500)",
      })
    ).toBe(true);
  });

  it("matches undici's error code", () => {
    expect(
      isContentLengthMismatchError({
        code: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
        message: "fetch failed",
      })
    ).toBe(true);
  });

  it("matches when the mismatch is nested in the error cause", () => {
    const error = new Error("fetch failed");
    (error as Error & { cause: unknown }).cause = {
      code: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
    };
    expect(isContentLengthMismatchError(error)).toBe(true);
  });

  it("rejects other errors", () => {
    expect(isContentLengthMismatchError(new Error("Not Found"))).toBe(false);
    expect(isContentLengthMismatchError({ status: 500, message: "boom" })).toBe(
      false
    );
  });

  it("rejects non-object values", () => {
    expect(isContentLengthMismatchError(undefined)).toBe(false);
    expect(isContentLengthMismatchError(null)).toBe(false);
    expect(
      isContentLengthMismatchError(
        "Request body length does not match content-length header"
      )
    ).toBe(false);
  });
});

describe("parseFullName", () => {
  it("splits owner/repo", () => {
    expect(parseFullName("example-org/widgets")).toEqual({
      owner: "example-org",
      repo: "widgets",
    });
  });

  it("rejects malformed names", () => {
    expect(parseFullName("widgets")).toBeUndefined();
    expect(parseFullName("a/b/c")).toBeUndefined();
    expect(parseFullName("/widgets")).toBeUndefined();
    expect(parseFullName("example-org/")).toBeUndefined();
    expect(parseFullName(undefined)).toBeUndefined();
    expect(parseFullName(42)).toBeUndefined();
  });
});

describe("sameSlug", () => {
  it("compares case-insensitively", () => {
    expect(
      sameSlug(
        { owner: "Example-Org", repo: "Widgets" },
        { owner: "example-org", repo: "widgets" }
      )
    ).toBe(true);
  });

  it("distinguishes different slugs", () => {
    expect(
      sameSlug(
        { owner: "example-org", repo: "widgets" },
        { owner: "renamed-org", repo: "widgets" }
      )
    ).toBe(false);
  });
});

describe("RepoMoveCache", () => {
  it("resolves a recorded move", () => {
    const cache = new RepoMoveCache();
    cache.record(
      { owner: "old-org", repo: "widgets" },
      { owner: "new-org", repo: "widgets" }
    );
    expect(cache.resolve({ owner: "old-org", repo: "widgets" })).toEqual({
      owner: "new-org",
      repo: "widgets",
    });
  });

  it("resolves case-insensitively", () => {
    const cache = new RepoMoveCache();
    cache.record(
      { owner: "old-org", repo: "widgets" },
      { owner: "new-org", repo: "widgets" }
    );
    expect(cache.resolve({ owner: "Old-Org", repo: "Widgets" })).toEqual({
      owner: "new-org",
      repo: "widgets",
    });
  });

  it("returns undefined for unknown slugs", () => {
    const cache = new RepoMoveCache();
    expect(
      cache.resolve({ owner: "old-org", repo: "widgets" })
    ).toBeUndefined();
  });

  it("ignores a self-move", () => {
    const cache = new RepoMoveCache();
    cache.record(
      { owner: "example-org", repo: "widgets" },
      { owner: "Example-Org", repo: "widgets" }
    );
    expect(
      cache.resolve({ owner: "example-org", repo: "widgets" })
    ).toBeUndefined();
  });

  it("follows a chain of moves", () => {
    const cache = new RepoMoveCache();
    cache.record(
      { owner: "first-org", repo: "widgets" },
      { owner: "second-org", repo: "widgets" }
    );
    cache.record(
      { owner: "second-org", repo: "widgets" },
      { owner: "third-org", repo: "widgets" }
    );
    expect(cache.resolve({ owner: "first-org", repo: "widgets" })).toEqual({
      owner: "third-org",
      repo: "widgets",
    });
  });

  it("stops on a move cycle instead of looping", () => {
    const cache = new RepoMoveCache();
    cache.record(
      { owner: "a-org", repo: "widgets" },
      { owner: "b-org", repo: "widgets" }
    );
    cache.record(
      { owner: "b-org", repo: "widgets" },
      { owner: "a-org", repo: "widgets" }
    );
    expect(cache.resolve({ owner: "a-org", repo: "widgets" })).toEqual({
      owner: "b-org",
      repo: "widgets",
    });
  });
});
