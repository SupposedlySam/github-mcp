# github-mcp

A Model Context Protocol (MCP) server for the GitHub REST and GraphQL APIs,
built as a sibling of [bitbucket-mcp](https://github.com/MatanYemini/bitbucket-mcp):
the same single-server architecture, pagination model, log shaping, and tool
vocabulary, mapped onto GitHub.

Exposes 48 tools by default (49 total — `deletePullRequestTask` is gated
behind `GITHUB_ENABLE_DANGEROUS`) covering pull requests, reviews, comments
and threads, diffs, commit statuses and check runs, GitHub Actions
(workflows, runs, jobs, logs), branch protection, and CODEOWNERS.

## Setup

```bash
npm install
npm run build
```

### Authentication

The server resolves a token in this order:

1. `GITHUB_TOKEN` environment variable
2. `gh auth token` — the GitHub CLI, if installed and logged in

Create a personal access token at <https://github.com/settings/tokens>.

Required scopes (classic PAT):

| Scope | Needed for |
|-------|-----------|
| `repo` | All repository, PR, comment, diff, and status tools |
| `read:org` | Org repository listing, org-scoped search |
| `workflow` | `runWorkflow` (workflow_dispatch) and `cancelWorkflowRun` |

Fine-grained PATs need read/write on Contents, Pull requests, Issues, and
Actions for the target repositories.

### Configuration

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | Token (falls back to `gh auth token`) |
| `GITHUB_OWNER` | Default owner so tools can omit `owner` (e.g. `your-org` or `octocat`) |
| `GITHUB_REPO` | Default repository so tools can omit `repo` (e.g. `your-repo` or `Hello-World`) |
| `GITHUB_API_URL` | Optional GitHub Enterprise API base URL |
| `GITHUB_ENABLE_DANGEROUS` | Set `true` to enable destructive tools (`deletePullRequestTask`) |
| `GITHUB_COMMENT_SIGNATURE` | Optional auto-appended comment signature (see below) |
| `GITHUB_MCP_LOG_DISABLE` / `GITHUB_MCP_LOG_FILE` / `GITHUB_MCP_LOG_DIR` / `GITHUB_MCP_LOG_PER_CWD` | File-logging controls (logs default to the platform log directory, never the CWD) |

Variables are read from `process.env` and, as a fallback, from a gitignored
`.env` file in the project root. `process.env` always takes precedence; `.env`
only fills in variables that are otherwise unset. See `.env.example` for a
starter configuration.

#### Comment signature

When `GITHUB_COMMENT_SIGNATURE` is set and non-empty, the server appends it to
the body of comments it posts. The value is appended verbatim after two
newlines, so the signature itself carries any decoration (dash, emoji, etc.) —
nothing is hardcoded. A generic example value:

```
GITHUB_COMMENT_SIGNATURE=🤖 via Example MCP bot
```

It applies to:

- `addPullRequestComment` — top-level, inline, and reply bodies.
- `createPullRequestReview` — the top-level review summary `body` only (never
  the inline `comments[]`).
- `submitPullRequestReview` — the `body`, when one is provided.

It does **not** apply to:

- `addCommentToPendingReview` — these are inline drafts within a batch; the
  eventual review body carries the signature instead.
- Any other tool.

Appending is idempotent: if a body already ends with the signature (trimmed
compare), it is not appended again. Leaving the variable unset or empty is a
no-op. The signature is body text only — GitHub still attributes the comment to
the authenticated token account.

### Claude Code registration

```bash
claude mcp add github \
  --env GITHUB_TOKEN=<your-token> \
  --env GITHUB_OWNER=<default-owner> \
  --env GITHUB_REPO=<default-repo> \
  -- node /path/to/github-mcp/dist/index.js
```

The `--env` flags must come before the `--` separator; everything after `--`
is the command the server runs.

Or in `mcpServers` JSON form:

```json
{
  "mcpServers": {
    "github": {
      "command": "node",
      "args": ["/path/to/github-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "<your-token>",
        "GITHUB_OWNER": "<default-owner>",
        "GITHUB_REPO": "<default-repo>"
      }
    }
  }
}
```

If `GITHUB_TOKEN` is omitted, the server uses `gh auth token`.

## Tool reference (Bitbucket → GitHub mapping)

Every tool accepts optional `owner`/`repo` (defaulting to
`GITHUB_OWNER`/`GITHUB_REPO`).

### Repositories

| Tool | Bitbucket equivalent | Notes |
|------|---------------------|-------|
| `listRepositories` | `listRepositories` | Org or user repos; client-side partial name filter |
| `getRepository` | `getRepository` | |

### Pull requests

| Tool | Bitbucket equivalent | Notes |
|------|---------------------|-------|
| `getPullRequests` | `getPullRequests` | `author` filter (login) and `state=merged` route through the search API server-side |
| `getPullRequest` | `getPullRequest` | |
| `createPullRequest` | `createPullRequest` | Reviewers are logins; requested after creation |
| `createDraftPullRequest` | `createDraftPullRequest` | Native `draft: true` |
| `publishDraftPullRequest` | `publishDraftPullRequest` | GraphQL `markPullRequestReadyForReview` |
| `convertToDraft` | `convertTodraft` | GraphQL `convertPullRequestToDraft` (name typo fixed) |
| `updatePullRequest` | `updatePullRequest` | Also supports changing the base branch |
| `mergePullRequest` | `mergePullRequest` | `merge` / `squash` / `rebase` |
| `closePullRequest` | `declinePullRequest` | GitHub has no decline; closes the PR, optional closing comment |
| `approvePullRequest` | `approvePullRequest` | Submits an `APPROVE` review |
| `unapprovePullRequest` | `unapprovePullRequest` | Dismisses your latest `APPROVED` review |
| `getPendingReviewPRs` | `getPendingReviewPRs` | Search API: `is:pr is:open review-requested:@me` |
| `getPullRequestActivity` | `getPullRequestActivity` | Issue timeline events |

### Comments and threads

| Tool | Bitbucket equivalent | Notes |
|------|---------------------|-------|
| `getPullRequestComments` | `getPullRequestComments` | Issue comments + review comments grouped into threads. Every comment carries `is_minimized` / `minimized_reason`; every review thread carries `is_resolved` / `is_outdated` (all via GraphQL) |
| `getPullRequestComment` | `getPullRequestComment` | Auto-detects review vs issue comment |
| `addPullRequestComment` | `addPullRequestComment` | Top-level, inline (`path`+`line`), or reply (`in_reply_to`) |
| `updatePullRequestComment` | `updatePullRequestComment` | |
| `deletePullRequestComment` | `deletePullRequestComment` | |
| `resolveComment` | `resolveComment` | GraphQL `resolveReviewThread` |
| `reopenComment` | `reopenComment` | GraphQL `unresolveReviewThread` |
| `minimizePullRequestComment` | — | Hide/collapse a comment with a reason (GraphQL `minimizeComment`); numeric id auto-resolved to node id; `reason` defaults to `OUTDATED`. Known limitation: the comment is hidden and the reason recorded, but GitHub renders the generic "This comment has been minimized" label instead of the specific reason ([community discussion #19865](https://github.com/orgs/community/discussions/19865)) |
| `unminimizePullRequestComment` | — | Un-collapse a minimized comment (GraphQL `unminimizeComment`) |
| `checkPrReplies` | `checkPrReplies` | Finds threads with replies newer than your last comment; identity defaults to the authenticated user's login. Each thread carries `is_resolved` and the latest comment's `latest_comment_is_minimized` / `latest_comment_minimized_reason` |

### Issues

Issue-side parallel to the PR tools above. The babysit/watcher idiom that
works for PRs (`getPullRequestActivity` as a doorbell, `checkPrReplies` as
detail-on-demand) maps cleanly to Issues with the same shapes.

| Tool | Notes |
|------|-------|
| `getIssue` | Issue equivalent of `getPullRequest`. Rejects when `#n` is actually a PR (GitHub's issues endpoint returns both). |
| `getIssueActivity` | Issue equivalent of `getPullRequestActivity` (timeline events: comments, label/assignee/milestone changes, state changes). |
| `getIssueComments` | List top-level comments. Supports server-side `since` ISO timestamp cursor. Each comment carries `is_minimized` / `minimized_reason` via GraphQL. |
| `getIssueComment` | Single comment by id. |
| `addIssueComment` | Post a top-level comment. Issues have no inline/reply analog. |
| `updateIssueComment` | |
| `deleteIssueComment` | |
| `checkIssueReplies` | Same shape as `checkPrReplies` but for Issues. Each Issue is a single discussion thread (the OP plus comments); `is_resolved` is always `null`. |

### Reactions

Emoji-reaction signaling that GitHub uses for lightweight ack ("👀 looking",
"👍 done", "🚀 shipped"). Reactions are not exposed by the comment/activity
endpoints, so the watcher needs these to diff client-side.

| Tool | Notes |
|------|-------|
| `getCommentReactions` | Reactions on a single comment. `kind`: `issue` (Issue *or* PR top-level conversation comment — they share the issues/comments table) or `pr_review` (PR inline review comment). Auto-detected with a 404 fallback when omitted. Optional `content` filter. |
| `getIssueReactions` | Reactions on the Issue body itself. |
| `getPullRequestReactions` | Reactions on the PR body itself (backed by `/issues/{n}/reactions` — PR bodies live in the issues table). |
| `addCommentReaction` | Idempotent — GitHub returns the existing reaction when you already reacted with that content. |
| `removeCommentReaction` | Removes the authenticated user's reaction of the given content (looks up the reaction id first because GitHub's delete endpoint takes a reaction id, not user+content). |

Reaction `content` values: `+1`, `-1`, `laugh`, `confused`, `heart`,
`hooray`, `rocket`, `eyes` (matches GitHub's [Reactions API](https://docs.github.com/en/rest/reactions/reactions)).
The `squirrel-girl` preview header is no longer required as of 2020.

### Review batching

These tools post multiple review comments as **one review** — the PR author
gets a single notification email instead of one per comment. They have no
Bitbucket equivalent (Bitbucket has no review object).

| Tool | Notes |
|------|-------|
| `createPullRequestReview` | One-shot publish (`event` set) or start a pending review (`event` omitted); accepts a `comments` array of inline comments |
| `getPendingReview` | Your pending review plus its draft comments (path, line, body) |
| `addCommentToPendingReview` | Add one draft comment to the pending review: new thread (`path`+`line`) or reply (`in_reply_to`); GraphQL `addPullRequestReviewThread` / `addPullRequestReviewThreadReply` |
| `submitPullRequestReview` | Publish the pending review as `COMMENT` / `APPROVE` / `REQUEST_CHANGES` |
| `deletePendingReview` | Discard the pending review and its drafts (GitHub only allows deleting PENDING reviews) |

`submitPullRequestReview` and `deletePendingReview` take an optional
`review_id`; when omitted they resolve the authenticated user's single
pending review on the PR automatically and fail with a clear message when
there is none.

**One-shot flow** — when the full comment set is known up front, send it
atomically:

1. `createPullRequestReview` with `event` (`COMMENT`, `APPROVE`, or
   `REQUEST_CHANGES`), an optional summary `body`, and the `comments` array.
   The review publishes immediately as a single review.

**Pending flow** — when comments accumulate while working through a diff:

1. `createPullRequestReview` with `event` omitted (optionally seeded with
   initial `comments`) to start a PENDING draft review.
2. `addCommentToPendingReview` for each additional comment (inline or
   reply).
3. `getPendingReview` to inspect the drafts.
4. `submitPullRequestReview` to publish everything as one review, or
   `deletePendingReview` to discard it without publishing.

**Pending reviews are invisible to other accounts.** A pending review can
only be seen by the account that created it. When the account behind the
MCP token differs from the account a person uses in the browser (a common
setup with bot or secondary accounts), drafts will not appear in the web UI
at all — `getPendingReview` is the only way to inspect them before
submitting.

### Tasks (emulated)

GitHub has no native PR task object, so tasks are **emulated as a markdown
checklist in a single dedicated PR comment** tagged with
`<!-- github-mcp:tasks -->`. This was chosen over mapping to GitHub issues
because tasks stay attached to the PR, render natively as checkboxes in the
GitHub UI, and need no extra permissions or cleanup. Task ids are 1-based
checklist positions; deleting a task renumbers the ones after it.

| Tool | Bitbucket equivalent |
|------|---------------------|
| `getPullRequestTasks` | `getPullRequestTasks` |
| `createPullRequestTask` | `createPullRequestTask` |
| `getPullRequestTask` | `getPullRequestTask` |
| `updatePullRequestTask` | `updatePullRequestTask` |
| `deletePullRequestTask` | `deletePullRequestTask` (gated behind `GITHUB_ENABLE_DANGEROUS=true`) |

### Diffs

| Tool | Bitbucket equivalent | Notes |
|------|---------------------|-------|
| `getPullRequestDiff` | `getPullRequestDiff` | `Accept: application/vnd.github.diff` |
| `getPullRequestPatch` | `getPullRequestPatch` | |
| `getPullRequestDiffStat` | `getPullRequestDiffStat` | `GET /pulls/{n}/files` |
| `getPullRequestDiffChunks` | `getPullRequestDiffChunks` | Hunk map per file, for placing inline comments |
| `getPullRequestCommits` | `getPullRequestCommits` | |

### Statuses

| Tool | Bitbucket equivalent | Notes |
|------|---------------------|-------|
| `getPullRequestStatuses` | `getPullRequestStatuses` | Combined commit status + check runs for the PR head |

### GitHub Actions (Bitbucket Pipelines)

| Tool | Bitbucket equivalent | Notes |
|------|---------------------|-------|
| `listWorkflows` | — | New: discover workflow ids/file names |
| `listWorkflowRuns` | `listPipelineRuns` | Filter by workflow, branch, status, event, actor |
| `getWorkflowRun` | `getPipelineRun` | |
| `listWorkflowJobs` | `getPipelineSteps` | |
| `getWorkflowJob` | `getPipelineStep` | |
| `getWorkflowJobLogs` | `getPipelineStepLogs` | Follows the blob-storage redirect; same `max_lines`/`tail`/`errors_only`/`search_term`/`save_to_file` shaping |
| `runWorkflow` | `runPipeline` | `workflow_dispatch` (requires the `workflow` scope) |
| `cancelWorkflowRun` | `stopPipeline` | |

### Branch rules and reviewers

| Tool | Bitbucket equivalent | Notes |
|------|---------------------|-------|
| `getBranchProtection` | branching-model tools | Defaults to the repo's default branch |
| `getCodeowners` | `getEffectiveDefaultReviewers` | Parses `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS` |

### Releases

Release metadata plus streaming asset downloads. The babysit idiom: a watcher
script polls `getLatestRelease` (or `listReleases`) for a new tag, then the
session uses `downloadReleaseAsset` / `downloadReleaseAssets` to pull the
artifact under test — same shape as `getPullRequestActivity` / `checkPrReplies`
as doorbell + detail-on-demand.

| Tool | Notes |
|------|-------|
| `getLatestRelease` | Latest published, non-draft, non-prerelease release. Convenience wrapper for the common babysit case. 404s when the repo has no published releases. |
| `getRelease` | Get a release by `tag` (e.g. `v0.3.0`). |
| `getReleaseById` | Get a release by numeric id. Draft releases require write access. |
| `listReleases` | Newest first (GitHub's default order). Includes drafts and prereleases. Same `per_page` / `page` / `all` pagination as the other list tools. |
| `downloadReleaseAsset` | Stream a single asset to a local path. See the path-resolution and overwrite rules below. Returns `{ bytes_written, sha256, content_type, target_path, asset }`. |
| `downloadReleaseAssets` | Stream multiple assets matching an optional glob (or `/regex/flags`) into a directory. Convenient when a release ships per-platform artifacts (`*macos-arm64*`). |

Release shape (from `getRelease` / `getReleaseById` / `getLatestRelease` and
each entry in `listReleases`): `id`, `node_id`, `tag_name`, `name`, `body`,
`draft`, `prerelease`, `target_commitish`, `author`, `created_at`,
`published_at`, `html_url`, `tarball_url`, `zipball_url`, and an `assets[]`
array each carrying `{ id, name, label, size, content_type, state,
download_count, browser_download_url, url, created_at, updated_at }`.

**Asset download contract** (both download tools share this):

- **Streaming.** The response body is piped to disk and hashed on the fly — nothing is buffered in memory. Releases that ship 30–50MB+ binaries work fine.
- **Redirect handling.** The initial `api.github.com` response is a 302 to a signed CDN URL with a different host (`objects.githubusercontent.com`); the tools set `Accept: application/octet-stream` and follow the redirect automatically.
- **Auth.** The MCP server's `GITHUB_TOKEN` is sent as a Bearer token. Public assets work without auth too; private repos require it.
- **Path resolution.** Absolute paths are used as-is, `~/...` is expanded to the user's home, and relative paths resolve against the MCP server's `process.cwd()` (i.e. wherever the MCP server was launched from, *not* your shell's cwd). Parent directories are created automatically.
- **Overwrite is opt-in.** When the target file already exists the call fails with `InvalidParams`; pass `overwrite: true` to replace it. Partial files are removed on stream error.
- **chmod.** The file is written with the default umask. Callers are responsible for `chmod +x` on binaries — the server does not infer executability.
- **Pattern matching** (plural tool only). `pattern` is a shell-style glob by default (`*macos-arm64*`, `*.zip`); patterns formatted as `/regex/flags` are compiled as regex. Assets that do not match are returned under `skipped_no_match` so the caller can confirm the filter did what they meant. Omit `pattern` to download every asset.
- **`release_id_or_tag`** (plural tool only) accepts a number, an all-digit string (also treated as an id), or a tag name (`v0.3.0`). A `v`-prefixed string is unambiguously a tag.

Quirks worth knowing:

- **Draft releases** are returned by `getReleaseById` / `getRelease` only when the token has write access. Public read-only tokens get a 404.
- **`getLatestRelease` ignores drafts and prereleases** by definition — use `listReleases` (or `getRelease` with the known tag) to inspect prereleases.
- **Asset `state`** is usually `"uploaded"`; assets still uploading (`"starter"`) return errors when downloaded, but in practice releases ship in a publish-complete state.
- **Tag names with slashes** (`release/v1`) are URL-encoded automatically by Octokit; you can pass them verbatim.

### Intentionally dropped (no GitHub analog)

These Bitbucket tools cover the Bitbucket *branching model* concept, which
has no GitHub equivalent; branch protection (`getBranchProtection`) is the
closest counterpart and replaces them:

- `getRepositoryBranchingModel`, `getRepositoryBranchingModelSettings`,
  `updateRepositoryBranchingModelSettings`,
  `getEffectiveRepositoryBranchingModel`
- `getProjectBranchingModel`, `getProjectBranchingModelSettings`,
  `updateProjectBranchingModelSettings` (Bitbucket *projects* don't exist on
  GitHub; the org level has rulesets, out of scope here)

## Development

```bash
npm run build      # tsc to dist/, marks dist/index.js executable
npm test           # Jest (ESM via ts-jest)
npm run lint       # ESLint on src/
npm run dev        # tsx watch mode
npm run inspector  # MCP inspector against the built server
```

Unit tests cover the pure helper modules (pagination, search queries, task
checklists, log filtering, diff chunking, thread building, CODEOWNERS
parsing, token resolution, pending-review resolution) and run without any
credentials or network.

## Architecture

- `src/index.ts` — the server: tool definitions, the call-tool routing
  switch, and one implementation method per tool (same three insertion
  points as bitbucket-mcp).
- `src/pagination.ts` — page walker with an `all` mode capped at 1000 items.
- `src/auth.ts` — `GITHUB_TOKEN` → `gh auth token` resolution.
- `src/searchQuery.ts` — search-API query builders (author/state filters,
  pending reviews).
- `src/taskList.ts` — markdown-checklist task emulation.
- `src/logFilter.ts` — Actions log truncation/filtering.
- `src/diffChunks.ts` — unified-diff hunk extraction.
- `src/threads.ts` — comment thread building and new-reply detection.
- `src/codeowners.ts` — CODEOWNERS parsing.
- `src/pendingReview.ts` — pending-review resolution and review-comment
  draft validation for review batching.
- `src/signature.ts` — optional comment-signature appending and the `.env`
  loader.
- `src/repoMove.ts` — renamed/transferred repository handling: recognizing
  the content-length-mismatch failure GitHub's redirect causes on requests
  with a body, and caching old-slug → new-slug mappings for retries.
- `src/releases.ts` — pure helpers for the Release tools: response shaping,
  target-path resolution (absolute vs `~`-expanded vs cwd-relative), glob /
  regex pattern matching for asset filtering, and tag-vs-id classification.

## License

MIT
