import fs from "fs";
import os from "os";
import path from "path";
import {
  applySignature,
  getCommentSignature,
  loadDotEnv,
} from "../src/signature.js";

const SIG = "— 🤖 Example MCP Bot";

describe("getCommentSignature", () => {
  it("returns the value when set and non-empty", () => {
    expect(getCommentSignature({ GITHUB_COMMENT_SIGNATURE: SIG })).toBe(SIG);
  });

  it("returns undefined when unset", () => {
    expect(getCommentSignature({})).toBeUndefined();
  });

  it("returns undefined when empty or whitespace-only", () => {
    expect(getCommentSignature({ GITHUB_COMMENT_SIGNATURE: "" })).toBeUndefined();
    expect(
      getCommentSignature({ GITHUB_COMMENT_SIGNATURE: "   " })
    ).toBeUndefined();
  });
});

describe("applySignature", () => {
  const env = { GITHUB_COMMENT_SIGNATURE: SIG };

  it("appends the signature with two newlines", () => {
    expect(applySignature("Looks good", env)).toBe(`Looks good\n\n${SIG}`);
  });

  it("is idempotent when the body already ends with the signature", () => {
    const already = `Looks good\n\n${SIG}`;
    expect(applySignature(already, env)).toBe(already);
  });

  it("is idempotent ignoring trailing whitespace", () => {
    const already = `Looks good\n\n${SIG}\n  `;
    expect(applySignature(already, env)).toBe(already);
  });

  it("is a no-op when the signature is unset", () => {
    expect(applySignature("Looks good", {})).toBe("Looks good");
  });

  it("is a no-op when the signature is empty", () => {
    expect(applySignature("Looks good", { GITHUB_COMMENT_SIGNATURE: "" })).toBe(
      "Looks good"
    );
  });

  it("returns undefined for an undefined body even when signing", () => {
    expect(applySignature(undefined, env)).toBeUndefined();
  });

  it("returns undefined for an undefined body when unset", () => {
    expect(applySignature(undefined, {})).toBeUndefined();
  });

  it("appends to an empty-string body", () => {
    expect(applySignature("", env)).toBe(`\n\n${SIG}`);
  });
});

describe("loadDotEnv", () => {
  function writeTmpEnv(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-mcp-env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, contents, "utf8");
    return file;
  }

  it("parses a UTF-8 value containing an em-dash and emoji verbatim", () => {
    const file = writeTmpEnv(`GITHUB_COMMENT_SIGNATURE=${SIG}\n`);
    const env: Record<string, string | undefined> = {};
    loadDotEnv(file, env);
    expect(env.GITHUB_COMMENT_SIGNATURE).toBe(SIG);
    // And the parsed value flows through signing unchanged.
    expect(applySignature("Looks good", env)).toBe(`Looks good\n\n${SIG}`);
  });

  it("strips surrounding quotes but preserves the inner em-dash/emoji", () => {
    const file = writeTmpEnv(`GITHUB_COMMENT_SIGNATURE="${SIG}"\n`);
    const env: Record<string, string | undefined> = {};
    loadDotEnv(file, env);
    expect(env.GITHUB_COMMENT_SIGNATURE).toBe(SIG);
  });

  it("does not override a value already present (process.env precedence)", () => {
    const file = writeTmpEnv(`GITHUB_COMMENT_SIGNATURE=from-file\n`);
    const env: Record<string, string | undefined> = {
      GITHUB_COMMENT_SIGNATURE: "from-process",
    };
    loadDotEnv(file, env);
    expect(env.GITHUB_COMMENT_SIGNATURE).toBe("from-process");
  });

  it("is a silent no-op when the file is missing", () => {
    const env: Record<string, string | undefined> = {};
    expect(() =>
      loadDotEnv(path.join(os.tmpdir(), "definitely-missing-.env"), env)
    ).not.toThrow();
    expect(env.GITHUB_COMMENT_SIGNATURE).toBeUndefined();
  });
});
