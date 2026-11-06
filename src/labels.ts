// Additive label changes on a pull request.
//
// GitHub has two ways to change labels and they are not equivalent:
//   PATCH /issues/{n} with `labels`        REPLACES the whole set
//   POST  /issues/{n}/labels               ADDS to it
//   DELETE /issues/{n}/labels/{name}       removes one
// Replacing the set strips labels other workflows applied (a path labeler,
// a bot), and the caller never sees them go. These tools only ever use the
// additive endpoints. Labels can be load-bearing (one that starts a deploy,
// one whose removal tears an environment down), so names are validated
// before anything is sent and the result says exactly what changed.

/** Thrown for a label request that should never reach GitHub. */
export class LabelRequestError extends Error {}

/**
 * Validate and de-duplicate label names, keeping first-seen order.
 * Names are passed through exactly (GitHub matches them case-insensitively
 * but stores the case it was given), so no trimming or case-folding here:
 * a name with stray whitespace is refused rather than silently "fixed".
 */
export function normalizeLabelNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.length === 0) {
    throw new LabelRequestError("`labels` must be a non-empty array of label names");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new LabelRequestError("label names must be non-empty strings");
    }
    if (name !== name.trim()) {
      throw new LabelRequestError(
        `label name ${JSON.stringify(name)} has leading or trailing whitespace`
      );
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/** Label names from an issue/PR `labels` array (objects or bare strings). */
export function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l: any) => (typeof l === "string" ? l : l?.name))
    .filter((n: unknown): n is string => typeof n === "string");
}

/** Split requested names by whether they are already on the item (case-insensitive). */
export function partitionByPresence(
  requested: string[],
  current: string[]
): { present: string[]; absent: string[] } {
  const have = new Set(current.map((n) => n.toLowerCase()));
  const present: string[] = [];
  const absent: string[] = [];
  for (const name of requested) {
    (have.has(name.toLowerCase()) ? present : absent).push(name);
  }
  return { present, absent };
}
