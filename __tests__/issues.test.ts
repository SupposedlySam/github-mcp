import {
  buildIssueCreate,
  buildIssueUpdate,
  IssueRequestError,
} from "../src/issues.js";

// All examples use generic placeholders only. Do not introduce real user
// identities (names, logins, emails) into this file.

describe("buildIssueCreate", () => {
  it("passes every given field through", () => {
    expect(
      buildIssueCreate({
        title: "Crash on start",
        body: "Steps...",
        labels: ["bug"],
        assignees: ["octocat"],
      })
    ).toEqual({
      title: "Crash on start",
      body: "Steps...",
      labels: ["bug"],
      assignees: ["octocat"],
    });
  });

  it("leaves omitted fields out rather than sending undefined", () => {
    const params = buildIssueCreate({ title: "Only a title" });
    expect(Object.keys(params)).toEqual(["title"]);
  });

  it.each(["", "   "])("refuses a blank title (%j)", (title) => {
    expect(() => buildIssueCreate({ title })).toThrow(IssueRequestError);
  });
});

describe("buildIssueUpdate", () => {
  it("refuses an update with nothing in it", () => {
    expect(() => buildIssueUpdate({})).toThrow(/nothing to update/);
  });

  it("keeps an empty labels array, which clears the labels", () => {
    expect(buildIssueUpdate({ labels: [] })).toEqual({ labels: [] });
  });

  it("keeps an empty body, which clears the body", () => {
    expect(buildIssueUpdate({ body: "" })).toEqual({ body: "" });
  });

  it("refuses a blank title", () => {
    expect(() => buildIssueUpdate({ title: " " })).toThrow(/title/);
  });

  it.each(["completed", "not_planned"] as const)(
    "closes with state_reason %s",
    (state_reason) => {
      expect(buildIssueUpdate({ state: "closed", state_reason })).toEqual({
        state: "closed",
        state_reason,
      });
    }
  );

  it("reopens with state_reason reopened", () => {
    expect(
      buildIssueUpdate({ state: "open", state_reason: "reopened" })
    ).toEqual({ state: "open", state_reason: "reopened" });
  });

  it("accepts a state change without a reason", () => {
    expect(buildIssueUpdate({ state: "closed" })).toEqual({ state: "closed" });
  });

  it("refuses a state_reason without a state (GitHub would ignore it)", () => {
    expect(() => buildIssueUpdate({ state_reason: "not_planned" })).toThrow(
      /needs `state`/
    );
  });

  it("refuses a closing reason on an open state", () => {
    expect(() =>
      buildIssueUpdate({ state: "open", state_reason: "completed" })
    ).toThrow(/state: closed/);
  });

  it("refuses reopened on a closed state", () => {
    expect(() =>
      buildIssueUpdate({ state: "closed", state_reason: "reopened" })
    ).toThrow(/state: open/);
  });
});

describe("createIssue / updateIssue handlers", () => {
  // Imported lazily so the pure tests above never construct a server.
  let GitHubServer: any;
  beforeAll(async () => {
    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "test-token";
    ({ GitHubServer } = await import("../src/index.js"));
  });

  const issue = (overrides: Record<string, unknown> = {}) => ({
    data: {
      number: 12,
      title: "Crash on start",
      state: "open",
      body: "Steps...",
      node_id: "I_kw12",
      html_url: "https://github.com/example-org/example/issues/12",
      user: { login: "octocat" },
      labels: [{ name: "bug" }],
      assignees: [],
      ...overrides,
    },
  });

  function serverWith(stubs: Record<string, unknown>): any {
    const server: any = new GitHubServer();
    Object.assign(server.octokit.rest.issues, stubs);
    return server;
  }

  const parse = (result: any) => JSON.parse(result.content[0].text);

  it("createIssue sends only the given fields and returns number + url", async () => {
    const calls: any[] = [];
    const server = serverWith({
      create: async (params: any) => (calls.push(params), issue()),
    });
    const out = parse(
      await server.createIssue("example-org", "example", "Crash on start", undefined, ["bug"])
    );
    expect(calls).toEqual([
      { owner: "example-org", repo: "example", title: "Crash on start", labels: ["bug"] },
    ]);
    expect(out).toMatchObject({
      number: 12,
      html_url: "https://github.com/example-org/example/issues/12",
      labels: ["bug"],
    });
  });

  it("createIssue refuses a blank title without calling GitHub", async () => {
    let called = false;
    const server = serverWith({ create: async () => ((called = true), issue()) });
    await expect(
      server.createIssue("example-org", "example", "  ")
    ).rejects.toThrow(/title/);
    expect(called).toBe(false);
  });

  it("updateIssue closes as not_planned", async () => {
    const updates: any[] = [];
    const server = serverWith({
      get: async () => issue(),
      update: async (params: any) => (
        updates.push(params), issue({ state: "closed", state_reason: "not_planned" })
      ),
    });
    const out = parse(
      await server.updateIssue("example-org", "example", 12, {
        state: "closed",
        state_reason: "not_planned",
      })
    );
    expect(updates).toEqual([
      {
        owner: "example-org",
        repo: "example",
        issue_number: 12,
        state: "closed",
        state_reason: "not_planned",
      },
    ]);
    expect(out).toMatchObject({ state: "closed", state_reason: "not_planned" });
  });

  it("updateIssue refuses a pull request before editing it", async () => {
    let updated = false;
    const server = serverWith({
      get: async () => issue({ pull_request: { url: "https://example.test/pr/12" } }),
      update: async () => ((updated = true), issue()),
    });
    await expect(
      server.updateIssue("example-org", "example", 12, { title: "New" })
    ).rejects.toThrow(/pull request/);
    expect(updated).toBe(false);
  });

  it("updateIssue refuses a reason with no state without calling GitHub", async () => {
    let called = false;
    const server = serverWith({
      get: async () => ((called = true), issue()),
      update: async () => ((called = true), issue()),
    });
    await expect(
      server.updateIssue("example-org", "example", 12, { state_reason: "completed" })
    ).rejects.toThrow(/needs `state`/);
    expect(called).toBe(false);
  });
});
