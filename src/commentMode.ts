// Pure mode resolution for PR comments.
//
// A comment request resolves to one of three modes:
// - reply: continues an existing review-comment thread (in_reply_to set)
// - inline: comments on a diff line (path + line, optional multi-line range)
// - top-level: a plain PR conversation comment (no targeting options)
//
// Reply takes precedence over inline when both sets of options are present.

export type DiffSide = "LEFT" | "RIGHT";

export interface CommentModeOptions {
  path?: string;
  line?: number;
  side?: DiffSide;
  start_line?: number;
  start_side?: DiffSide;
  in_reply_to?: number;
}

export type CommentPlan =
  | { mode: "reply"; in_reply_to: number }
  | {
      mode: "inline";
      path: string;
      line: number;
      side: DiffSide;
      start_line?: number;
      start_side?: DiffSide;
    }
  | { mode: "top-level" }
  | { error: string };

/**
 * Resolve the targeting options of a PR comment into one of the three posting
 * modes, with diff-side defaults applied, or an error for invalid
 * combinations.
 */
export function planCommentMode(options: CommentModeOptions): CommentPlan {
  if (options.in_reply_to !== undefined) {
    return { mode: "reply", in_reply_to: options.in_reply_to };
  }

  if (options.path !== undefined || options.line !== undefined) {
    if (options.path === undefined || options.line === undefined) {
      return { error: "Inline comments require both path and line" };
    }
    const side = options.side ?? "RIGHT";
    return {
      mode: "inline",
      path: options.path,
      line: options.line,
      side,
      ...(options.start_line !== undefined
        ? {
            start_line: options.start_line,
            start_side: options.start_side ?? side,
          }
        : {}),
    };
  }

  return { mode: "top-level" };
}
