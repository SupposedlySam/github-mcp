// Optional auto-appended comment signature.
//
// When GITHUB_COMMENT_SIGNATURE is set and non-empty, the server appends it to
// the body of comments it posts. The signature value itself carries any
// leading dash/emoji/formatting — no decoration is hardcoded here.
//
// The value is read from process.env, which takes precedence over a gitignored
// `.env` file at the project root (loaded by loadDotEnv before construction).

import fs from "fs";

const SIGNATURE_ENV_VAR = "GITHUB_COMMENT_SIGNATURE";

/** Resolve the configured signature, or undefined when unset/empty. */
export function getCommentSignature(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const value = env[SIGNATURE_ENV_VAR];
  if (value === undefined) {
    return undefined;
  }
  // Preserve the signature verbatim; only treat all-whitespace as "unset".
  return value.trim().length > 0 ? value : undefined;
}

/**
 * Append the configured signature to a comment body.
 *
 * - Returns the body unchanged when no signature is configured.
 * - Returns undefined when the body is undefined (so callers can omit it).
 * - Idempotent: skips appending when the body already ends with the signature
 *   (trimmed compare).
 * - Append format: existing body, two newlines, signature verbatim.
 * - `override` is the caller's per-call `signature` argument. When given it
 *   replaces the configured signature for this post; an empty (or
 *   all-whitespace) override posts the body exactly as given.
 *
 * Why an explicit override rather than "skip when the body already ends in
 * some signature-looking line": a caller that signs its own posts (an agent
 * whose waker recognizes its comments by their LAST line) had the configured
 * signature stacked under its own, which both put the account holder's name
 * on every post and made the caller's own comments unrecognizable to it. Edits
 * could not repair it, because every edit re-appended the line. A heuristic
 * would also fire on a body that merely ends with a quoted signature line, so
 * the caller states it instead.
 */
export function applySignature(
  body: string,
  env?: Record<string, string | undefined>,
  override?: string
): string;
export function applySignature(
  body: string | undefined,
  env?: Record<string, string | undefined>,
  override?: string
): string | undefined;
export function applySignature(
  body: string | undefined,
  env: Record<string, string | undefined> = process.env,
  override?: string
): string | undefined {
  const signature =
    override === undefined
      ? getCommentSignature(env)
      : override.trim().length > 0
        ? override
        : undefined;
  if (signature === undefined) {
    return body;
  }
  if (body === undefined) {
    return body;
  }
  if (body.trimEnd().endsWith(signature.trim())) {
    return body;
  }
  return `${body}\n\n${signature}`;
}

/**
 * Load KEY=VALUE pairs from a `.env` file into process.env without overriding
 * variables that are already set (process.env takes precedence).
 *
 * Minimal inline parser — the project avoids extra runtime dependencies. Lines
 * that are blank or start with `#` are ignored. Surrounding single or double
 * quotes around a value are stripped.
 */
export function loadDotEnv(
  filePath: string,
  env: Record<string, string | undefined> = process.env
): void {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch {
    // No .env file (or unreadable) — nothing to load.
    return;
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key.length === 0) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}
