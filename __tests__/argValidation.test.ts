import {
  ArgSchema,
  formatArgumentErrors,
  suggestKey,
  validateToolArguments,
} from "../src/argValidation.js";

const reviewSchema: ArgSchema = {
  type: "object",
  properties: {
    owner: { type: "string" },
    repo: { type: "string" },
    pull_number: { type: "number" },
    event: { type: "string", enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"] },
    commit_id: { type: "string" },
    per_page: { type: "number", minimum: 1, maximum: 100 },
    release_id_or_tag: { type: ["string", "number"] },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          body: { type: "string" },
          line: { type: "number" },
          start_line: { type: "number" },
        },
        required: ["path", "body", "line"],
      },
    },
  },
  required: ["pull_number"],
};

describe("suggestKey", () => {
  it.each([
    ["pullNumber", "pull_number"],
    ["commitId", "commit_id"],
    ["PullNumber", "pull_number"],
    ["pull-number", "pull_number"],
  ])("maps %s to %s", (input, expected) => {
    expect(suggestKey(input, ["owner", "pull_number", "commit_id"])).toBe(
      expected
    );
  });

  it("offers nothing for an unrelated key", () => {
    expect(suggestKey("prNumber", ["pull_number"])).toBeUndefined();
  });
});

describe("validateToolArguments", () => {
  it("accepts a well-formed call", () => {
    expect(
      validateToolArguments(reviewSchema, {
        owner: "example-org",
        repo: "example",
        pull_number: 2491,
        event: "APPROVE",
        comments: [{ path: "a.ts", body: "nit", line: 3 }],
      })
    ).toEqual([]);
  });

  it("names pull_number for the camelCase-string call that used to 404", () => {
    const errors = validateToolArguments(reviewSchema, {
      owner: "example-org",
      repo: "example",
      pullNumber: "2491",
      event: "APPROVE",
    });
    expect(errors).toEqual([
      "unknown parameter `pullNumber`; did you mean `pull_number`?",
    ]);
  });

  it("reports a missing required parameter by name", () => {
    expect(validateToolArguments(reviewSchema, { event: "APPROVE" })).toEqual([
      "missing required parameter `pull_number`",
    ]);
  });

  it("treats null on a required key as missing", () => {
    expect(validateToolArguments(reviewSchema, { pull_number: null })).toEqual([
      "missing required parameter `pull_number`",
    ]);
  });

  it("lists the accepted keys for an unknown key with no close match", () => {
    const [error] = validateToolArguments(reviewSchema, {
      pull_number: 1,
      foo: true,
    });
    expect(error).toMatch(/^unknown parameter `foo` \(accepted: owner, repo, pull_number/);
  });

  it("suggests the casing fix for commitId", () => {
    expect(
      validateToolArguments(reviewSchema, { pull_number: 1, commitId: "abc" })
    ).toEqual(["unknown parameter `commitId`; did you mean `commit_id`?"]);
  });

  it("rejects a numeric string where a number is declared, with a hint", () => {
    expect(validateToolArguments(reviewSchema, { pull_number: "2491" })).toEqual([
      '`pull_number` must be number, got string "2491" (pass 2491 without quotes)',
    ]);
  });

  it("enforces enum, minimum and maximum", () => {
    expect(
      validateToolArguments(reviewSchema, {
        pull_number: 1,
        event: "approve",
        per_page: 500,
      })
    ).toEqual([
      '`event` must be one of "COMMENT", "APPROVE", "REQUEST_CHANGES", got "approve"',
      "`per_page` must be <= 100, got 500",
    ]);
  });

  it("accepts either member of a type union", () => {
    expect(
      validateToolArguments(reviewSchema, { pull_number: 1, release_id_or_tag: 7 })
    ).toEqual([]);
    expect(
      validateToolArguments(reviewSchema, {
        pull_number: 1,
        release_id_or_tag: "v1.0.0",
      })
    ).toEqual([]);
  });

  it("allows null on an optional key", () => {
    expect(
      validateToolArguments(reviewSchema, { pull_number: 1, commit_id: null })
    ).toEqual([]);
  });

  it("validates nested array items with indexed paths", () => {
    expect(
      validateToolArguments(reviewSchema, {
        pull_number: 1,
        comments: [
          { path: "a.ts", body: "ok", line: 1 },
          { path: "b.ts", body: "nit", startLine: 2 },
        ],
      })
    ).toEqual([
      "unknown parameter `comments[1].startLine`; did you mean `comments[1].start_line`?",
      "missing required parameter `comments[1].line`",
    ]);
  });

  it("allows extra keys when additionalProperties is true", () => {
    expect(
      validateToolArguments(
        { type: "object", properties: {}, additionalProperties: true },
        { anything: 1 }
      )
    ).toEqual([]);
  });
});

describe("formatArgumentErrors", () => {
  it("prefixes the tool name and joins problems", () => {
    expect(formatArgumentErrors("approvePullRequest", ["a", "b"])).toBe(
      "Invalid arguments for approvePullRequest: a; b"
    );
  });
});
