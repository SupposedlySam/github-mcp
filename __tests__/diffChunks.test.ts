import { filterChunksByPath, parseDiffChunks } from "../src/diffChunks.js";

const SAMPLE_DIFF = [
  "diff --git a/src/widget.dart b/src/widget.dart",
  "index 1111111..2222222 100644",
  "--- a/src/widget.dart",
  "+++ b/src/widget.dart",
  "@@ -10,5 +10,7 @@ class Widget {",
  " context",
  "+added line",
  "+another added line",
  " context",
  "@@ -40 +42,2 @@",
  "+tail addition",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,2 +1,3 @@",
  " # Title",
  "+New line",
].join("\n");

describe("parseDiffChunks", () => {
  it("maps each file to its hunks", () => {
    const chunks = parseDiffChunks(SAMPLE_DIFF);
    expect(Object.keys(chunks)).toEqual(["src/widget.dart", "README.md"]);
    expect(chunks["src/widget.dart"]).toEqual([
      { old_start: 10, old_count: 5, new_start: 10, new_count: 7 },
      { old_start: 40, old_count: 1, new_start: 42, new_count: 2 },
    ]);
    expect(chunks["README.md"]).toEqual([
      { old_start: 1, old_count: 2, new_start: 1, new_count: 3 },
    ]);
  });

  it("returns an empty map for an empty diff", () => {
    expect(parseDiffChunks("")).toEqual({});
  });
});

describe("filterChunksByPath", () => {
  it("keeps exact path matches", () => {
    const filtered = filterChunksByPath(
      parseDiffChunks(SAMPLE_DIFF),
      "README.md"
    );
    expect(Object.keys(filtered)).toEqual(["README.md"]);
  });

  it("keeps suffix matches", () => {
    const filtered = filterChunksByPath(
      parseDiffChunks(SAMPLE_DIFF),
      "widget.dart"
    );
    expect(Object.keys(filtered)).toEqual(["src/widget.dart"]);
  });

  it("strips a leading slash before matching", () => {
    const filtered = filterChunksByPath(
      parseDiffChunks(SAMPLE_DIFF),
      "/README.md"
    );
    expect(Object.keys(filtered)).toEqual(["README.md"]);
  });
});
