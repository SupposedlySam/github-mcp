import {
  labelNames,
  LabelRequestError,
  normalizeLabelNames,
  partitionByPresence,
} from "../src/labels.js";

// All examples use generic placeholders only. Do not introduce real user
// identities (names, logins, emails) into this file.

describe("normalizeLabelNames", () => {
  it("keeps names exactly, in order", () => {
    expect(normalizeLabelNames(["preview", "needs review"])).toEqual([
      "preview",
      "needs review",
    ]);
  });

  it("drops case-insensitive duplicates, keeping the first spelling", () => {
    expect(normalizeLabelNames(["Bug", "bug", "docs"])).toEqual(["Bug", "docs"]);
  });

  it.each([[[]], [undefined], ["preview"]])("refuses a non-array or empty list (%j)", (v) => {
    expect(() => normalizeLabelNames(v)).toThrow(LabelRequestError);
  });

  it.each(["", "   "])("refuses a blank name (%j)", (name) => {
    expect(() => normalizeLabelNames([name])).toThrow(/non-empty/);
  });

  it("refuses a name with stray whitespace rather than trimming it", () => {
    expect(() => normalizeLabelNames([" preview"])).toThrow(/whitespace/);
  });
});

describe("labelNames / partitionByPresence", () => {
  it("reads object and string labels", () => {
    expect(labelNames([{ name: "a" }, "b", { id: 3 }])).toEqual(["a", "b"]);
    expect(labelNames(undefined)).toEqual([]);
  });

  it("splits by presence case-insensitively", () => {
    expect(partitionByPresence(["Preview", "docs"], ["preview", "frontend"])).toEqual({
      present: ["Preview"],
      absent: ["docs"],
    });
  });
});

describe("addPullRequestLabels / removePullRequestLabels handlers", () => {
  let GitHubServer: any;
  beforeAll(async () => {
    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "test-token";
    ({ GitHubServer } = await import("../src/index.js"));
  });

  const labels = (...names: string[]) => names.map((name) => ({ name }));
  const pr = (...names: string[]) => ({
    data: {
      number: 7,
      labels: labels(...names),
      pull_request: { url: "https://example.test/pulls/7" },
    },
  });
  const parse = (result: any) => JSON.parse(result.content[0].text);

  function serverWith(stubs: Record<string, unknown>): any {
    const server: any = new GitHubServer();
    // Any endpoint not stubbed must never be reached: above all
    // issues.update, which REPLACES the label set.
    server.octokit.rest.issues.update = async () => {
      throw new Error("issues.update must never be called for labels");
    };
    Object.assign(server.octokit.rest.issues, stubs);
    return server;
  }

  it("adds only the missing labels, through the additive endpoint", async () => {
    const calls: any[] = [];
    const server = serverWith({
      get: async () => pr("frontend", "preview"),
      addLabels: async (params: any) => (
        calls.push(params), { data: labels("frontend", "preview", "docs") }
      ),
    });
    const out = parse(
      await server.addPullRequestLabels("example-org", "example", 7, ["preview", "docs"])
    );
    expect(calls).toEqual([
      { owner: "example-org", repo: "example", issue_number: 7, labels: ["docs"] },
    ]);
    expect(out).toEqual({
      pull_number: 7,
      added: ["docs"],
      already_present: ["preview"],
      labels: ["frontend", "preview", "docs"],
    });
  });

  it("makes no write when every label is already present", async () => {
    let wrote = false;
    const server = serverWith({
      get: async () => pr("preview"),
      addLabels: async () => ((wrote = true), { data: [] }),
    });
    const out = parse(await server.addPullRequestLabels("o", "r", 7, ["preview"]));
    expect(wrote).toBe(false);
    expect(out).toMatchObject({ added: [], already_present: ["preview"], labels: ["preview"] });
  });

  it("removes one label and leaves the others", async () => {
    const calls: any[] = [];
    const server = serverWith({
      get: async () => pr("frontend", "preview"),
      removeLabel: async (params: any) => (calls.push(params), { data: labels("frontend") }),
    });
    const out = parse(await server.removePullRequestLabels("o", "r", 7, ["preview"]));
    expect(calls).toEqual([{ owner: "o", repo: "r", issue_number: 7, name: "preview" }]);
    expect(out).toEqual({
      pull_number: 7,
      removed: ["preview"],
      not_present: [],
      labels: ["frontend"],
    });
  });

  it("reports a label that is not on the PR without sending a DELETE", async () => {
    let deleted = false;
    const server = serverWith({
      get: async () => pr("frontend"),
      removeLabel: async () => ((deleted = true), { data: [] }),
    });
    const out = parse(await server.removePullRequestLabels("o", "r", 7, ["preview"]));
    expect(deleted).toBe(false);
    expect(out).toMatchObject({ removed: [], not_present: ["preview"], labels: ["frontend"] });
  });

  it("treats a 404 from DELETE (label removed meanwhile) as not_present", async () => {
    const gone = Object.assign(new Error("Label does not exist"), {
      name: "HttpError",
      status: 404,
      response: { data: { message: "Label does not exist" } },
    });
    const server = serverWith({
      get: async () => pr("frontend", "preview"),
      removeLabel: async () => {
        throw gone;
      },
    });
    const out = parse(await server.removePullRequestLabels("o", "r", 7, ["preview"]));
    expect(out).toMatchObject({ removed: [], not_present: ["preview"], labels: ["frontend"] });
  });

  it("surfaces any other DELETE failure instead of reporting success", async () => {
    const forbidden = Object.assign(new Error("Forbidden"), {
      name: "HttpError",
      status: 403,
      response: { data: { message: "Forbidden" } },
    });
    const server = serverWith({
      get: async () => pr("preview"),
      removeLabel: async () => {
        throw forbidden;
      },
    });
    await expect(server.removePullRequestLabels("o", "r", 7, ["preview"])).rejects.toThrow(
      /403|Forbidden/
    );
  });

  it.each(["addPullRequestLabels", "removePullRequestLabels"])(
    "%s refuses an Issue number before writing",
    async (tool) => {
      let wrote = false;
      const server = serverWith({
        get: async () => ({ data: { number: 7, labels: labels("preview") } }),
        addLabels: async () => ((wrote = true), { data: [] }),
        removeLabel: async () => ((wrote = true), { data: [] }),
      });
      await expect(server[tool]("o", "r", 7, ["preview"])).rejects.toThrow(/is an Issue/);
      expect(wrote).toBe(false);
    }
  );

  it.each(["addPullRequestLabels", "removePullRequestLabels"])(
    "%s refuses an empty list without calling GitHub",
    async (tool) => {
      let called = false;
      const server = serverWith({ get: async () => ((called = true), pr()) });
      await expect(server[tool]("o", "r", 7, [])).rejects.toThrow(/non-empty/);
      expect(called).toBe(false);
    }
  );
});
