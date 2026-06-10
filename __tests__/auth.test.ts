import { jest } from "@jest/globals";
import { resolveGitHubToken } from "../src/auth.js";

describe("resolveGitHubToken", () => {
  it("prefers GITHUB_TOKEN when set", () => {
    const exec = jest.fn(() => "cli-token\n");
    const token = resolveGitHubToken(
      { GITHUB_TOKEN: "env-token" },
      exec as any
    );
    expect(token).toBe("env-token");
    expect(exec).not.toHaveBeenCalled();
  });

  it("trims whitespace from the env token", () => {
    const token = resolveGitHubToken(
      { GITHUB_TOKEN: "  env-token  " },
      jest.fn() as any
    );
    expect(token).toBe("env-token");
  });

  it("falls back to `gh auth token` when GITHUB_TOKEN is unset", () => {
    const exec = jest.fn(() => "cli-token\n");
    const token = resolveGitHubToken({}, exec as any);
    expect(token).toBe("cli-token");
    expect(exec).toHaveBeenCalledWith("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5000,
    });
  });

  it("falls back to gh when GITHUB_TOKEN is empty or blank", () => {
    const exec = jest.fn(() => "cli-token\n");
    expect(resolveGitHubToken({ GITHUB_TOKEN: "   " }, exec as any)).toBe(
      "cli-token"
    );
  });

  it("returns undefined when gh is missing or errors", () => {
    const exec = jest.fn(() => {
      throw new Error("command not found: gh");
    });
    expect(resolveGitHubToken({}, exec as any)).toBeUndefined();
  });

  it("returns undefined when gh outputs nothing", () => {
    const exec = jest.fn(() => "\n");
    expect(resolveGitHubToken({}, exec as any)).toBeUndefined();
  });
});
