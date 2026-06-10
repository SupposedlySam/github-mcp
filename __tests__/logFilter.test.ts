import {
  DEFAULT_MAX_LOG_LINES,
  filterLogLines,
  MAX_LOG_LINES_CAP,
} from "../src/logFilter.js";

const makeLog = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

describe("filterLogLines", () => {
  it("returns everything when under the default limit", () => {
    const result = filterLogLines(makeLog(10));
    expect(result.lines).toHaveLength(10);
    expect(result.totalLines).toBe(10);
    expect(result.wasTruncated).toBe(false);
  });

  it("truncates to the default limit from the head", () => {
    const result = filterLogLines(makeLog(DEFAULT_MAX_LOG_LINES + 100));
    expect(result.lines).toHaveLength(DEFAULT_MAX_LOG_LINES);
    expect(result.lines[0]).toBe("line 1");
    expect(result.wasTruncated).toBe(true);
  });

  it("returns the tail when tail=true", () => {
    const result = filterLogLines(makeLog(20), { maxLines: 5, tail: true });
    expect(result.lines).toEqual([
      "line 16",
      "line 17",
      "line 18",
      "line 19",
      "line 20",
    ]);
    expect(result.summary).toContain("most recent");
  });

  it("filters to error-looking lines with errors_only", () => {
    const log = ["ok step", "ERROR: build failed", "another ok", "Exception thrown"].join(
      "\n"
    );
    const result = filterLogLines(log, { errorsOnly: true });
    expect(result.lines).toEqual(["ERROR: build failed", "Exception thrown"]);
    expect(result.filteredLines).toBe(2);
  });

  it("filters by search term case-insensitively", () => {
    const log = ["Compile widget", "Run tests", "compile shaders"].join("\n");
    const result = filterLogLines(log, { searchTerm: "COMPILE" });
    expect(result.lines).toEqual(["Compile widget", "compile shaders"]);
  });

  it("caps max_lines at the hard cap", () => {
    const result = filterLogLines(makeLog(MAX_LOG_LINES_CAP + 500), {
      maxLines: MAX_LOG_LINES_CAP + 500,
    });
    expect(result.lines).toHaveLength(MAX_LOG_LINES_CAP);
    expect(result.wasTruncated).toBe(true);
  });

  it("reports when nothing matches the filters", () => {
    const result = filterLogLines(makeLog(5), { searchTerm: "absent" });
    expect(result.lines).toEqual([]);
    expect(result.summary).toContain("No log lines matched");
  });

  it("handles an empty log", () => {
    const result = filterLogLines("");
    expect(result.totalLines).toBe(0);
    expect(result.lines).toEqual([]);
  });
});
