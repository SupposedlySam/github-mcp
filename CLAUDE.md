# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server that provides AI assistants with programmatic access to the GitHub REST and GraphQL APIs. It is architecturally a sibling of bitbucket-mcp: the same server pattern, pagination model, and tool vocabulary, mapped onto GitHub (pull requests, comments and threads, diffs, statuses, GitHub Actions, branch protection, CODEOWNERS).

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/ (also sets executable permission)
npm start            # Run compiled server from dist/index.js
npm run dev          # Run in development mode with watch (uses tsx)
npm test             # Run Jest tests (ESM via ts-jest; no credentials needed)
npm run lint         # Run ESLint on src/**/*.ts
npm run inspector    # Launch MCP inspector for debugging tools
```

## Architecture

### Main server: `src/index.ts`

All tools live in `src/index.ts` with three insertion points (same as bitbucket-mcp):

1. **Tool definition** — the JSON schema entry in the `ListToolsRequestSchema` handler
2. **Switch case** — the routing entry in the `CallToolRequestSchema` handler
3. **Implementation method** — a method on `GitHubServer`

Adding a tool means touching all three.

### Helper modules (pure, unit-tested)

- `src/pagination.ts` — `GitHubPaginator`: single page or `all` mode (walks pages, caps at 1000 items)
- `src/auth.ts` — token resolution: `GITHUB_TOKEN` env var, then `gh auth token`
- `src/searchQuery.ts` — search-API query builders (author/state PR filters, pending-review queries)
- `src/taskList.ts` — PR task emulation via a marker-tagged markdown checklist comment
- `src/logFilter.ts` — Actions job log truncation/filtering (max_lines, tail, errors_only, search_term)
- `src/diffChunks.ts` — unified-diff hunk extraction
- `src/threads.ts` — comment thread building (in_reply_to_id chains) and new-reply detection
- `src/codeowners.ts` — CODEOWNERS parsing

Repetitive data processing belongs in these modules (code over compute), keeping it testable without network access.

### Conventions

- Implementation methods wrap their body in `this.guard(description, context, fn)` for logging + error mapping
- GitHub errors are surfaced via `formatGitHubError` ("prefix: message (HTTP code)")
- List outputs are summarized (trimmed shapes) to keep token use sane; single-item gets return fuller data
- `owner`/`repo` are optional everywhere and default to `GITHUB_OWNER`/`GITHUB_REPO` via `resolveContext`
- Draft transitions and thread resolution use `octokit.graphql` (REST does not support them)
- Destructive tools (currently `deletePullRequestTask`) are gated behind `GITHUB_ENABLE_DANGEROUS=true`

## Git

- Trunk-based development on `master`; conventional commits without scope (e.g. `feat: add review tools`)
- This is a personal project: keep real names, logins, and work email addresses out of code, docs, examples, and fixtures — use generic placeholders (octocat, example-org)
