# github-mcp

A Model Context Protocol (MCP) server for the GitHub REST and GraphQL APIs,
built as a sibling of [bitbucket-mcp](https://github.com/MatanYemini/bitbucket-mcp):
the same single-server architecture, pagination model, log shaping, and tool
vocabulary, mapped onto GitHub.

Covers pull requests, reviews, comments and threads, diffs, commit statuses
and check runs, GitHub Actions (workflows, runs, jobs, logs), branch
protection, and CODEOWNERS.

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
| `GITHUB_OWNER` | Default owner so tools can omit `owner` (e.g. `hii-inc-sebu`) |
| `GITHUB_REPO` | Default repository so tools can omit `repo` (e.g. `drops`) |
| `GITHUB_API_URL` | Optional GitHub Enterprise API base URL |
| `GITHUB_ENABLE_DANGEROUS` | Set `true` to enable destructive tools (`deletePullRequestTask`) |
| `GITHUB_MCP_LOG_DISABLE` / `GITHUB_MCP_LOG_FILE` / `GITHUB_MCP_LOG_DIR` / `GITHUB_MCP_LOG_PER_CWD` | File-logging controls (logs default to the platform log directory, never the CWD) |

See `.env.example` for a starter configuration.

### Claude Code registration

```bash
claude mcp add github -- node /path/to/github-mcp/dist/index.js \
  --env GITHUB_TOKEN=<your-token> \
  --env GITHUB_OWNER=<default-owner> \
  --env GITHUB_REPO=<default-repo>
```

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
| `getPullRequestComments` | `getPullRequestComments` | Issue comments + review comments grouped into threads, with resolution state via GraphQL |
| `getPullRequestComment` | `getPullRequestComment` | Auto-detects review vs issue comment |
| `addPullRequestComment` | `addPullRequestComment` | Top-level, inline (`path`+`line`), or reply (`in_reply_to`) |
| `updatePullRequestComment` | `updatePullRequestComment` | |
| `deletePullRequestComment` | `deletePullRequestComment` | |
| `resolveComment` | `resolveComment` | GraphQL `resolveReviewThread` |
| `reopenComment` | `reopenComment` | GraphQL `unresolveReviewThread` |
| `checkPrReplies` | `checkPrReplies` | Finds threads with replies newer than your last comment; identity defaults to the authenticated user's login |

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
parsing, token resolution) and run without any credentials or network.

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

## License

MIT
