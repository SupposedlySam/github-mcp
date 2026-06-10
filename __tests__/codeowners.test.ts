import { parseCodeowners } from "../src/codeowners.js";

describe("parseCodeowners", () => {
  it("parses patterns and owners", () => {
    const content = [
      "# Comment line",
      "",
      "*       @example-org/maintainers",
      "/src/   @octocat @hubot",
      "*.md    docs@example.com",
    ].join("\n");

    expect(parseCodeowners(content)).toEqual([
      { pattern: "*", owners: ["@example-org/maintainers"] },
      { pattern: "/src/", owners: ["@octocat", "@hubot"] },
      { pattern: "*.md", owners: ["docs@example.com"] },
    ]);
  });

  it("strips trailing comments", () => {
    expect(parseCodeowners("/app/ @octocat # mobile code")).toEqual([
      { pattern: "/app/", owners: ["@octocat"] },
    ]);
  });

  it("skips lines without owners", () => {
    expect(parseCodeowners("/orphaned/")).toEqual([]);
  });

  it("returns an empty list for empty content", () => {
    expect(parseCodeowners("")).toEqual([]);
  });
});
