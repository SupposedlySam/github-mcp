/**
 * Pure helpers for the Release tools.
 *
 * Everything here is sync, side-effect-free, and unit-tested. The streaming
 * download itself lives in `src/index.ts` because it depends on fs / fetch /
 * Octokit; the helpers below stop just short of touching the filesystem so
 * they can be exercised without mocks.
 */

import path from "path";

/** Trimmed release shape returned by the Release tools. */
export interface ReleaseAssetSummary {
  id: number;
  name: string;
  label: string | null;
  size: number;
  content_type: string;
  state: string | null;
  download_count: number;
  browser_download_url: string;
  url: string;
  created_at: string;
  updated_at: string;
}

export interface ReleaseSummary {
  id: number;
  node_id: string;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  target_commitish: string | null;
  author: string | null;
  created_at: string;
  published_at: string | null;
  html_url: string;
  tarball_url: string | null;
  zipball_url: string | null;
  assets: ReleaseAssetSummary[];
}

export function summarizeReleaseAsset(asset: any): ReleaseAssetSummary {
  return {
    id: asset.id,
    name: asset.name,
    label: asset.label ?? null,
    size: asset.size,
    content_type: asset.content_type,
    state: asset.state ?? null,
    download_count: asset.download_count,
    browser_download_url: asset.browser_download_url,
    url: asset.url,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
  };
}

export function summarizeRelease(release: any): ReleaseSummary {
  return {
    id: release.id,
    node_id: release.node_id,
    tag_name: release.tag_name,
    name: release.name ?? null,
    body: release.body ?? null,
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    target_commitish: release.target_commitish ?? null,
    author: release.author?.login ?? null,
    created_at: release.created_at,
    published_at: release.published_at ?? null,
    html_url: release.html_url,
    tarball_url: release.tarball_url ?? null,
    zipball_url: release.zipball_url ?? null,
    assets: Array.isArray(release.assets)
      ? release.assets.map(summarizeReleaseAsset)
      : [],
  };
}

/**
 * Resolve a caller-supplied target path against the MCP server's cwd.
 *
 * - Absolute paths are returned as-is (after normalization).
 * - Relative paths are resolved against `baseDir` (typically `process.cwd()`).
 * - `~` is expanded to `homeDir` when provided.
 */
export function resolveTargetPath(
  target: string,
  baseDir: string,
  homeDir?: string
): string {
  if (target.length === 0) {
    throw new Error("target path must not be empty");
  }
  let expanded = target;
  if (homeDir && (expanded === "~" || expanded.startsWith("~/"))) {
    expanded = path.join(homeDir, expanded.slice(1));
  }
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(baseDir, expanded);
}

/**
 * Compile a shell-style glob to a RegExp.
 *
 * Supports:
 *   `*`   — any run of non-slash characters
 *   `**`  — any run of characters (including slashes)
 *   `?`   — a single non-slash character
 *   `[abc]` / `[a-z]` — character classes
 *
 * Everything else is a literal. The result is anchored.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      // Pass character class through verbatim until the matching ']'.
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        // Unterminated class — treat the '[' as a literal.
        out += "\\[";
        i += 1;
        continue;
      }
      out += glob.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    // Escape regex metacharacters in literal segments.
    if (/[.+^${}()|\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

/**
 * Test whether `name` matches `pattern`.
 *
 * - When the pattern looks like a regex literal (`/.../flags`), it's compiled
 *   as a regex.
 * - Otherwise it's treated as a glob.
 *
 * An empty / undefined pattern matches everything.
 */
export function matchesPattern(name: string, pattern?: string): boolean {
  if (!pattern || pattern.length === 0) return true;
  // /regex/ or /regex/flags
  const regexLiteral = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  if (regexLiteral) {
    try {
      const re = new RegExp(regexLiteral[1], regexLiteral[2]);
      return re.test(name);
    } catch {
      // Fall through to glob.
    }
  }
  return globToRegExp(pattern).test(name);
}

/**
 * Decide whether the supplied tag/id argument is a numeric release id or a tag
 * string. Numeric strings and numbers are treated as ids; everything else is a
 * tag. `v0.3.0`-style strings are correctly classified as tags because they
 * contain non-digit characters.
 */
export function classifyReleaseRef(
  ref: string | number
): { kind: "id"; id: number } | { kind: "tag"; tag: string } {
  if (typeof ref === "number") {
    if (!Number.isFinite(ref) || !Number.isInteger(ref) || ref < 0) {
      throw new Error(`Invalid release id: ${ref}`);
    }
    return { kind: "id", id: ref };
  }
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    if (trimmed.length === 0) {
      throw new Error("release_id_or_tag must not be empty");
    }
    if (/^\d+$/.test(trimmed)) {
      return { kind: "id", id: Number(trimmed) };
    }
    return { kind: "tag", tag: trimmed };
  }
  throw new Error(
    `release_id_or_tag must be a string or number, got ${typeof ref}`
  );
}
