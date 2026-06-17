import path from "path";
import {
  classifyReleaseRef,
  globToRegExp,
  matchesPattern,
  resolveTargetPath,
  summarizeRelease,
  summarizeReleaseAsset,
} from "../src/releases.js";

describe("summarizeReleaseAsset", () => {
  it("picks the documented fields and normalizes label", () => {
    const summary = summarizeReleaseAsset({
      id: 42,
      name: "zonai-macos-arm64.zip",
      label: null,
      size: 1234,
      content_type: "application/zip",
      state: "uploaded",
      download_count: 7,
      browser_download_url: "https://example.com/a.zip",
      url: "https://api.github.com/repos/o/r/releases/assets/42",
      created_at: "2026-06-17T00:00:00Z",
      updated_at: "2026-06-17T00:01:00Z",
      extra: "dropped",
    });

    expect(summary).toEqual({
      id: 42,
      name: "zonai-macos-arm64.zip",
      label: null,
      size: 1234,
      content_type: "application/zip",
      state: "uploaded",
      download_count: 7,
      browser_download_url: "https://example.com/a.zip",
      url: "https://api.github.com/repos/o/r/releases/assets/42",
      created_at: "2026-06-17T00:00:00Z",
      updated_at: "2026-06-17T00:01:00Z",
    });
  });
});

describe("summarizeRelease", () => {
  it("trims to the documented fields and walks assets", () => {
    const summary = summarizeRelease({
      id: 1,
      node_id: "RE_kwDO",
      tag_name: "v0.3.0",
      name: "v0.3.0",
      body: "notes",
      draft: false,
      prerelease: false,
      target_commitish: "main",
      author: { login: "mrgnhnt96" },
      created_at: "2026-06-16T00:00:00Z",
      published_at: "2026-06-16T00:05:00Z",
      html_url: "https://github.com/mrgnhnt96/zonai/releases/tag/v0.3.0",
      tarball_url: "https://api.github.com/.../tarball/v0.3.0",
      zipball_url: "https://api.github.com/.../zipball/v0.3.0",
      assets: [
        {
          id: 10,
          name: "zonai-macos-arm64.zip",
          size: 1,
          content_type: "application/zip",
          download_count: 0,
          browser_download_url: "https://example.com/a.zip",
          url: "https://api.github.com/.../assets/10",
          created_at: "x",
          updated_at: "y",
        },
      ],
    });

    expect(summary.tag_name).toBe("v0.3.0");
    expect(summary.author).toBe("mrgnhnt96");
    expect(summary.draft).toBe(false);
    expect(summary.prerelease).toBe(false);
    expect(summary.assets).toHaveLength(1);
    expect(summary.assets[0].name).toBe("zonai-macos-arm64.zip");
  });

  it("nulls optional fields when missing and handles empty assets", () => {
    const summary = summarizeRelease({
      id: 2,
      node_id: "n",
      tag_name: "v0.0.1",
      draft: true,
      prerelease: true,
      created_at: "now",
      html_url: "https://example.com",
    });
    expect(summary.name).toBeNull();
    expect(summary.body).toBeNull();
    expect(summary.published_at).toBeNull();
    expect(summary.author).toBeNull();
    expect(summary.tarball_url).toBeNull();
    expect(summary.zipball_url).toBeNull();
    expect(summary.assets).toEqual([]);
    expect(summary.draft).toBe(true);
    expect(summary.prerelease).toBe(true);
  });
});

describe("resolveTargetPath", () => {
  it("returns absolute paths as-is (normalized)", () => {
    expect(resolveTargetPath("/tmp/./foo/../bar", "/cwd")).toBe(
      path.normalize("/tmp/bar")
    );
  });

  it("resolves relative paths against baseDir", () => {
    expect(resolveTargetPath("dist/a.zip", "/work")).toBe(
      path.resolve("/work", "dist/a.zip")
    );
  });

  it("expands a leading ~ when homeDir is supplied", () => {
    expect(resolveTargetPath("~/Downloads/a.zip", "/cwd", "/Users/me")).toBe(
      path.normalize("/Users/me/Downloads/a.zip")
    );
  });

  it("does not expand ~ when no homeDir is supplied", () => {
    expect(resolveTargetPath("~/Downloads/a.zip", "/cwd")).toBe(
      path.resolve("/cwd", "~/Downloads/a.zip")
    );
  });

  it("rejects empty targets", () => {
    expect(() => resolveTargetPath("", "/cwd")).toThrow(/must not be empty/);
  });
});

describe("globToRegExp", () => {
  it("matches `*` against any non-slash run", () => {
    const re = globToRegExp("*.zip");
    expect(re.test("a.zip")).toBe(true);
    expect(re.test("foo-bar.zip")).toBe(true);
    expect(re.test("foo/a.zip")).toBe(false);
  });

  it("matches `**` against slashes", () => {
    const re = globToRegExp("**/a.zip");
    expect(re.test("a.zip")).toBe(false);
    expect(re.test("dir/a.zip")).toBe(true);
    expect(re.test("dir/sub/a.zip")).toBe(true);
  });

  it("matches `?` as one non-slash char", () => {
    const re = globToRegExp("a?b");
    expect(re.test("axb")).toBe(true);
    expect(re.test("aXb")).toBe(true);
    expect(re.test("ab")).toBe(false);
    expect(re.test("a/b")).toBe(false);
  });

  it("supports character classes", () => {
    const re = globToRegExp("v[0-9].zip");
    expect(re.test("v1.zip")).toBe(true);
    expect(re.test("vA.zip")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    const re = globToRegExp("a.b+c(d)");
    expect(re.test("a.b+c(d)")).toBe(true);
    expect(re.test("axb+c(d)")).toBe(false);
  });

  it("anchors the pattern", () => {
    const re = globToRegExp("*macos-arm64*");
    expect(re.test("zonai-macos-arm64.zip")).toBe(true);
    expect(re.test("zonai-macos-x86_64.zip")).toBe(false);
  });
});

describe("matchesPattern", () => {
  it("returns true when pattern is undefined or empty", () => {
    expect(matchesPattern("anything.zip", undefined)).toBe(true);
    expect(matchesPattern("anything.zip", "")).toBe(true);
  });

  it("interprets `/.../` as a regex literal", () => {
    expect(matchesPattern("zonai-macos-arm64.zip", "/macos-arm64/")).toBe(true);
    expect(matchesPattern("zonai-linux-x86_64.zip", "/macos-arm64/")).toBe(
      false
    );
  });

  it("respects regex flags", () => {
    expect(matchesPattern("ZONAI-MACOS-ARM64.ZIP", "/macos-arm64/i")).toBe(
      true
    );
  });

  it("falls back to glob for non-regex patterns", () => {
    expect(matchesPattern("zonai-macos-arm64.zip", "*macos-arm64*")).toBe(true);
    expect(matchesPattern("zonai-linux-x86_64.zip", "*macos-arm64*")).toBe(
      false
    );
  });
});

describe("classifyReleaseRef", () => {
  it("treats numbers as ids", () => {
    expect(classifyReleaseRef(123)).toEqual({ kind: "id", id: 123 });
  });

  it("treats digit-only strings as ids", () => {
    expect(classifyReleaseRef("123")).toEqual({ kind: "id", id: 123 });
  });

  it("treats v-prefixed strings as tags", () => {
    expect(classifyReleaseRef("v0.3.0")).toEqual({ kind: "tag", tag: "v0.3.0" });
  });

  it("treats other strings as tags", () => {
    expect(classifyReleaseRef("release-2026-06-17")).toEqual({
      kind: "tag",
      tag: "release-2026-06-17",
    });
  });

  it("rejects empty strings", () => {
    expect(() => classifyReleaseRef("")).toThrow(/must not be empty/);
    expect(() => classifyReleaseRef("   ")).toThrow(/must not be empty/);
  });

  it("rejects non-integer / negative numbers", () => {
    expect(() => classifyReleaseRef(1.5)).toThrow(/Invalid release id/);
    expect(() => classifyReleaseRef(-1)).toThrow(/Invalid release id/);
  });
});
