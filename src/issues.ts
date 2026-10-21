// Issue create/update request building.
//
// The REST endpoints accept almost anything and quietly ignore what does not
// fit: `state_reason` is "ignored unless state is changed", so a caller who
// sends `state_reason: "not_planned"` alone gets a 200 and no change. These
// builders turn those silent no-ops into InvalidParams-style errors before
// anything reaches GitHub.

export type IssueState = "open" | "closed";

/**
 * state_reason values the REST update endpoint accepts, per the installed
 * Octokit types. GitHub's UI also closes as "duplicate"; it is left out until
 * the REST types carry it, rather than offering a value that may 422.
 */
export const ISSUE_STATE_REASONS = ["completed", "not_planned", "reopened"] as const;
export type IssueStateReason = (typeof ISSUE_STATE_REASONS)[number];

export interface IssueCreateInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export interface IssueUpdateInput {
  title?: string;
  body?: string;
  state?: IssueState;
  state_reason?: IssueStateReason;
  labels?: string[];
  assignees?: string[];
}

/** Thrown for a request GitHub would reject or silently ignore. */
export class IssueRequestError extends Error {}

function requireTitle(title: string): void {
  if (title.trim() === "") {
    throw new IssueRequestError("`title` must not be empty");
  }
}

/** Params for `issues.create`, minus owner/repo. Omitted fields stay omitted. */
export function buildIssueCreate(input: IssueCreateInput): IssueCreateInput {
  requireTitle(input.title);
  const params: IssueCreateInput = { title: input.title };
  if (input.body !== undefined) params.body = input.body;
  if (input.labels !== undefined) params.labels = input.labels;
  if (input.assignees !== undefined) params.assignees = input.assignees;
  return params;
}

/**
 * Params for `issues.update`, minus owner/repo/issue_number.
 *
 * `labels` and `assignees` REPLACE the issue's whole set (GitHub's semantics);
 * an empty array clears it. A state_reason must travel with the state it
 * describes: closing reasons with `closed`, `reopened` with `open`.
 */
export function buildIssueUpdate(input: IssueUpdateInput): IssueUpdateInput {
  const params: IssueUpdateInput = {};
  if (input.title !== undefined) {
    requireTitle(input.title);
    params.title = input.title;
  }
  if (input.body !== undefined) params.body = input.body;
  if (input.state !== undefined) params.state = input.state;
  if (input.state_reason !== undefined) {
    if (input.state === undefined) {
      throw new IssueRequestError(
        "`state_reason` needs `state`: GitHub ignores a reason unless the state changes"
      );
    }
    const reopening = input.state_reason === "reopened";
    if (reopening !== (input.state === "open")) {
      throw new IssueRequestError(
        reopening
          ? "`state_reason: reopened` goes with `state: open`"
          : `\`state_reason: ${input.state_reason}\` goes with \`state: closed\``
      );
    }
    params.state_reason = input.state_reason;
  }
  if (input.labels !== undefined) params.labels = input.labels;
  if (input.assignees !== undefined) params.assignees = input.assignees;
  if (Object.keys(params).length === 0) {
    throw new IssueRequestError(
      "nothing to update: pass at least one of title, body, state, labels, assignees"
    );
  }
  return params;
}
