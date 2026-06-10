// Log shaping for GitHub Actions job logs.
//
// Job logs can be megabytes of text; returning them raw would blow the MCP
// response budget. This applies, in order: an errors-only filter, a search
// filter, then head/tail truncation, and produces a human-readable summary
// describing what was kept.

export const DEFAULT_MAX_LOG_LINES = 500;
export const MAX_LOG_LINES_CAP = 5000;

export interface LogFilterOptions {
  maxLines?: number;
  tail?: boolean;
  errorsOnly?: boolean;
  searchTerm?: string;
}

export interface LogFilterResult {
  lines: string[];
  totalLines: number;
  filteredLines: number;
  wasTruncated: boolean;
  summary: string;
}

const ERROR_LINE_REGEX = /(error|failed|failure|exception|traceback|fatal)/i;

export function filterLogLines(
  rawLog: string,
  options: LogFilterOptions = {}
): LogFilterResult {
  const { maxLines, tail = false, errorsOnly = false, searchTerm } = options;

  const allLines = rawLog.length > 0 ? rawLog.split(/\r?\n/) : [];
  const totalLines = allLines.length;

  let filtered = allLines;
  const normalizedSearch = searchTerm?.trim().toLowerCase();
  if (errorsOnly) {
    filtered = filtered.filter((line) => ERROR_LINE_REGEX.test(line));
  }
  if (normalizedSearch && normalizedSearch.length > 0) {
    filtered = filtered.filter((line) =>
      line.toLowerCase().includes(normalizedSearch)
    );
  }

  const normalizedMaxLines =
    typeof maxLines === "number" && Number.isFinite(maxLines)
      ? Math.floor(maxLines)
      : DEFAULT_MAX_LOG_LINES;
  const resolvedMaxLines = Math.max(
    1,
    Math.min(normalizedMaxLines, MAX_LOG_LINES_CAP)
  );

  const hasLines = filtered.length > 0;
  const limited = hasLines
    ? tail
      ? filtered.slice(-resolvedMaxLines)
      : filtered.slice(0, resolvedMaxLines)
    : [];
  const wasTruncated = hasLines && filtered.length > limited.length;

  const summaryParts: string[] = [`Total log lines: ${totalLines}.`];
  if (errorsOnly || (normalizedSearch && normalizedSearch.length > 0)) {
    summaryParts.push(`Lines after filtering: ${filtered.length}.`);
  }
  if (!hasLines) {
    summaryParts.push("No log lines matched the provided filters.");
  } else {
    summaryParts.push(
      `Showing ${limited.length} ${tail ? "most recent" : "earliest"} lines${
        wasTruncated ? ` (limited to ${resolvedMaxLines} lines)` : ""
      }.`
    );
  }

  return {
    lines: limited,
    totalLines,
    filteredLines: filtered.length,
    wasTruncated,
    summary: summaryParts.join(" "),
  };
}
