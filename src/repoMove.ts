// Helpers for renamed/transferred repositories.
//
// GitHub answers API calls that use a repository's old owner/name with a
// redirect. GET requests follow it transparently, but a request with a body
// cannot be replayed by the fetch layer, which fails with "Request body
// length does not match content-length header" (Octokit surfaces this as an
// HTTP 500 even though no response was received). These helpers recognize
// that failure and track old-slug -> current-slug mappings so requests can
// be rewritten and retried against the repository's new location.

/** An owner/repo pair identifying a repository. */
export interface RepoSlug {
  owner: string;
  repo: string;
}

const CONTENT_LENGTH_MISMATCH_PATTERN =
  /request body length does not match content-length header/i;
const CONTENT_LENGTH_MISMATCH_CODE = "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH";

/**
 * True when an error is the fetch layer's unreplayable-redirect failure
 * (undici's RequestContentLengthMismatchError, possibly wrapped by Octokit).
 */
export function isContentLengthMismatchError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    message?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  if (
    typeof candidate.message === "string" &&
    CONTENT_LENGTH_MISMATCH_PATTERN.test(candidate.message)
  ) {
    return true;
  }
  if (candidate.code === CONTENT_LENGTH_MISMATCH_CODE) return true;
  if (candidate.cause && typeof candidate.cause === "object") {
    return isContentLengthMismatchError(candidate.cause);
  }
  return false;
}

/** Split an "owner/repo" full name into a slug. */
export function parseFullName(fullName: unknown): RepoSlug | undefined {
  if (typeof fullName !== "string") return undefined;
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { owner: parts[0], repo: parts[1] };
}

function slugKey(slug: RepoSlug): string {
  return `${slug.owner.toLowerCase()}/${slug.repo.toLowerCase()}`;
}

/** Case-insensitive slug equality (GitHub slugs are case-insensitive). */
export function sameSlug(a: RepoSlug, b: RepoSlug): boolean {
  return slugKey(a) === slugKey(b);
}

/** Tracks old-slug -> current-slug mappings discovered at runtime. */
export class RepoMoveCache {
  private moves = new Map<string, RepoSlug>();

  /** Record that a repository moved from one slug to another. */
  record(from: RepoSlug, to: RepoSlug): void {
    if (sameSlug(from, to)) return;
    this.moves.set(slugKey(from), to);
  }

  /**
   * Resolve a slug through recorded moves, following chains of renames.
   * Returns undefined when no move is recorded for the slug.
   */
  resolve(slug: RepoSlug): RepoSlug | undefined {
    const seen = new Set([slugKey(slug)]);
    let resolved: RepoSlug | undefined;
    let next = this.moves.get(slugKey(slug));
    while (next && !seen.has(slugKey(next))) {
      seen.add(slugKey(next));
      resolved = next;
      next = this.moves.get(slugKey(next));
    }
    return resolved;
  }
}
