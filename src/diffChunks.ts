// Unified-diff hunk extraction.
//
// Maps each file in a unified diff to its hunk headers (old/new start lines
// and counts). Inline review comments need precise line positions; the hunk
// map answers "which lines of this file are commentable?" without shipping
// the full diff text to the model.

export interface DiffHunk {
  old_start: number;
  old_count: number;
  new_start: number;
  new_count: number;
}

export type DiffChunkMap = Record<string, DiffHunk[]>;

const FILE_HEADER_REGEX = /^\+\+\+ b\/(.+)/;
const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffChunks(diffText: string): DiffChunkMap {
  const files: DiffChunkMap = {};
  let currentPath: string | null = null;

  for (const line of diffText.split("\n")) {
    const plusMatch = line.match(FILE_HEADER_REGEX);
    if (plusMatch) {
      currentPath = plusMatch[1];
      if (!files[currentPath]) files[currentPath] = [];
      continue;
    }
    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch && currentPath) {
      files[currentPath].push({
        old_start: parseInt(hunkMatch[1], 10),
        old_count: parseInt(hunkMatch[2] ?? "1", 10),
        new_start: parseInt(hunkMatch[3], 10),
        new_count: parseInt(hunkMatch[4] ?? "1", 10),
      });
    }
  }

  return files;
}

/** Keep only entries matching the path filter (exact or suffix match). */
export function filterChunksByPath(
  files: DiffChunkMap,
  pathFilter: string
): DiffChunkMap {
  const normalized = pathFilter.replace(/^\//, "");
  return Object.fromEntries(
    Object.entries(files).filter(
      ([p]) => p === pathFilter || p === normalized || p.endsWith(pathFilter)
    )
  );
}
