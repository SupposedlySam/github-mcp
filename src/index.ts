#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import winston from "winston";
import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  GitHubPaginator,
  GITHUB_ALL_ITEMS_CAP,
  GITHUB_DEFAULT_PER_PAGE,
  GITHUB_MAX_PER_PAGE,
} from "./pagination.js";
import { resolveGitHubToken } from "./auth.js";
import {
  buildPendingReviewQuery,
  buildPullRequestSearchQuery,
  PullRequestStateFilter,
} from "./searchQuery.js";
import {
  addTask,
  deleteTask,
  isTasksComment,
  parseTasks,
  serializeTasks,
  updateTask,
  TaskState,
} from "./taskList.js";
import { filterLogLines } from "./logFilter.js";
import { filterChunksByPath, parseDiffChunks } from "./diffChunks.js";
import {
  buildDiscussionThread,
  buildReviewThreads,
  findThreadsWithNewReplies,
  ThreadComment,
} from "./threads.js";
import { CODEOWNERS_LOCATIONS, parseCodeowners } from "./codeowners.js";
import {
  describePendingReviewFailure,
  PendingReviewCandidate,
  planApprovalWithPendingReview,
  resolvePendingReview,
  ReviewCommentDraft,
  validateReviewCommentDrafts,
} from "./pendingReview.js";
import {
  isContentLengthMismatchError,
  parseFullName,
  RepoMoveCache,
  RepoSlug,
  sameSlug,
} from "./repoMove.js";
import { applySignature, loadDotEnv } from "./signature.js";
import { planCommentMode } from "./commentMode.js";

// Load a gitignored `.env` from the project root before any process.env reads.
// process.env always wins; `.env` only fills in unset variables.
loadDotEnv(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"));

// =========== LOGGER SETUP ==========
// File-based logging with sensible defaults and ability to disable
function getDefaultLogDirectory(): string {
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "github-mcp");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Logs", "github-mcp");
  }
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome && xdgStateHome.length > 0) {
    return path.join(xdgStateHome, "github-mcp");
  }
  return path.join(os.homedir(), ".local", "state", "github-mcp");
}

function isTruthyEnv(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const normalized = String(value).toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function getLogFilePath(): string | undefined {
  if (isTruthyEnv(process.env.GITHUB_MCP_LOG_DISABLE)) {
    return undefined;
  }

  const explicitFile = process.env.GITHUB_MCP_LOG_FILE;
  if (explicitFile && explicitFile.trim().length > 0) {
    return explicitFile;
  }

  const baseDir =
    process.env.GITHUB_MCP_LOG_DIR &&
    process.env.GITHUB_MCP_LOG_DIR.trim().length > 0
      ? process.env.GITHUB_MCP_LOG_DIR
      : getDefaultLogDirectory();

  let effectiveDir = baseDir;
  if (isTruthyEnv(process.env.GITHUB_MCP_LOG_PER_CWD)) {
    const sanitizedCwd = process
      .cwd()
      .replace(/[\\/]/g, "_")
      .replace(/[:*?"<>|]/g, "");
    effectiveDir = path.join(baseDir, sanitizedCwd);
  }

  try {
    fs.mkdirSync(effectiveDir, { recursive: true });
  } catch {
    return undefined; // If we cannot create the directory, disable file logging rather than polluting CWD
  }

  return path.join(effectiveDir, "github.log");
}

const resolvedLogFile = getLogFilePath();
const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: resolvedLogFile
    ? [new winston.transports.File({ filename: resolvedLogFile })]
    : [],
});

// =========== SHARED SCHEMA FRAGMENTS ==========
const PAGINATION_BASE_SCHEMA = {
  per_page: {
    type: "number",
    minimum: 1,
    maximum: GITHUB_MAX_PER_PAGE,
    description: `Number of items per page. Defaults to ${GITHUB_DEFAULT_PER_PAGE} and caps at ${GITHUB_MAX_PER_PAGE}.`,
  },
  page: {
    type: "number",
    minimum: 1,
    description: "Page number to fetch (1-based).",
  },
};

const PAGINATION_ALL_SCHEMA = {
  type: "boolean",
  description: `When true (and no page is provided), automatically walks pages to return all items up to ${GITHUB_ALL_ITEMS_CAP}.`,
};

const OWNER_REPO_SCHEMA = {
  owner: {
    type: "string",
    description:
      "Repository owner (user or organization). Defaults to GITHUB_OWNER.",
  },
  repo: {
    type: "string",
    description: "Repository name. Defaults to GITHUB_REPO.",
  },
};

const PULL_NUMBER_SCHEMA = {
  type: "number",
  description: "Pull request number",
};

// =========== CONFIG ==========
interface GitHubConfig {
  baseUrl: string;
  token: string;
  defaultOwner?: string;
  defaultRepo?: string;
  allowDangerousCommands?: boolean;
}

// =========== ERROR FORMATTING ==========
/**
 * Extracts a human-readable message from a GitHub error body. GitHub
 * typically returns `{ "message": "...", "errors": [...] }`; this walks the
 * common shapes and returns undefined when nothing useful is present.
 */
function extractGitHubErrorMessage(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "string") {
    const trimmed = data.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.message === "string" && obj.message.trim().length > 0) {
    parts.push(obj.message.trim());
  }
  if (Array.isArray(obj.errors)) {
    const details = obj.errors
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          if (typeof e.message === "string") return e.message;
          if (typeof e.code === "string" && typeof e.field === "string") {
            return `${e.field}: ${e.code}`;
          }
        }
        return undefined;
      })
      .filter((value): value is string => !!value);
    if (details.length > 0) {
      parts.push(`(${details.join("; ")})`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Duck-typed check for Octokit's RequestError shape. */
function isRequestError(
  error: unknown
): error is { status: number; message: string; response?: { data?: unknown } } {
  return (
    !!error &&
    typeof error === "object" &&
    typeof (error as Record<string, unknown>).status === "number" &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

/**
 * Builds a readable McpError message that surfaces the GitHub response body
 * (when present) instead of the generic HTTP message. Format:
 *   "<prefix>: <GitHub message> (HTTP <code>)"
 */
function formatGitHubError(error: unknown, prefix: string): string {
  if (isRequestError(error)) {
    const bodyMessage = extractGitHubErrorMessage(error.response?.data);
    if (bodyMessage) {
      return `${prefix}: ${bodyMessage} (HTTP ${error.status})`;
    }
    return `${prefix}: ${error.message} (HTTP ${error.status})`;
  }
  if (error instanceof Error) {
    return `${prefix}: ${error.message}`;
  }
  return `${prefix}: ${String(error)}`;
}

// =========== RESPONSE SHAPING ==========
/** Trimmed PR shape for list outputs; keeps token use sane. */
function summarizePullRequest(pr: any) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft ?? false,
    merged: pr.merged ?? (pr.merged_at ? true : undefined),
    author: pr.user?.login,
    head: pr.head?.ref,
    base: pr.base?.ref,
    head_sha: pr.head?.sha,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    requested_reviewers: Array.isArray(pr.requested_reviewers)
      ? pr.requested_reviewers.map((r: any) => r.login)
      : undefined,
    html_url: pr.html_url,
  };
}

/** Trimmed search-result shape (search items lack head/base refs). */
function summarizeSearchItem(item: any) {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    draft: item.draft ?? false,
    author: item.user?.login,
    created_at: item.created_at,
    updated_at: item.updated_at,
    repository_url: item.repository_url,
    html_url: item.html_url,
  };
}

function summarizeComment(comment: any) {
  return {
    id: comment.id,
    author: comment.user?.login,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    in_reply_to_id: comment.in_reply_to_id,
    path: comment.path,
    line: comment.line ?? comment.original_line,
    start_line: comment.start_line ?? comment.original_start_line,
    html_url: comment.html_url,
  };
}

function summarizeWorkflowRun(run: any) {
  return {
    id: run.id,
    name: run.name,
    workflow_id: run.workflow_id,
    run_number: run.run_number,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    actor: run.actor?.login,
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
  };
}

function summarizeJob(job: any) {
  return {
    id: job.id,
    run_id: job.run_id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    steps: Array.isArray(job.steps)
      ? job.steps.map((step: any) => ({
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
        }))
      : undefined,
    html_url: job.html_url,
  };
}

// =========== GRAPHQL DOCUMENTS ==========
const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes { databaseId }
            }
          }
        }
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation ResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

const UNRESOLVE_THREAD_MUTATION = `
  mutation UnresolveThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

/** Valid values of the GraphQL ReportedContentClassifiers enum. */
const MINIMIZE_REASONS = [
  "OUTDATED",
  "RESOLVED",
  "OFF_TOPIC",
  "DUPLICATE",
  "SPAM",
  "ABUSE",
  "LOW_QUALITY",
] as const;

const MINIMIZE_COMMENT_MUTATION = `
  mutation MinimizeComment($subjectId: ID!, $classifier: ReportedContentClassifiers!) {
    minimizeComment(input: { subjectId: $subjectId, classifier: $classifier }) {
      minimizedComment { isMinimized minimizedReason }
    }
  }
`;

const UNMINIMIZE_COMMENT_MUTATION = `
  mutation UnminimizeComment($subjectId: ID!) {
    unminimizeComment(input: { subjectId: $subjectId }) {
      unminimizedComment { isMinimized }
    }
  }
`;

const MARK_READY_MUTATION = `
  mutation MarkReady($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest { number isDraft }
    }
  }
`;

const CONVERT_TO_DRAFT_MUTATION = `
  mutation ConvertToDraft($pullRequestId: ID!) {
    convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
      pullRequest { number isDraft }
    }
  }
`;

const ADD_REVIEW_THREAD_MUTATION = `
  mutation AddReviewThread($input: AddPullRequestReviewThreadInput!) {
    addPullRequestReviewThread(input: $input) {
      thread {
        id
        path
        line
        startLine
        comments(first: 1) {
          nodes { databaseId body state }
        }
      }
    }
  }
`;

const ADD_REVIEW_THREAD_REPLY_MUTATION = `
  mutation AddReviewThreadReply($input: AddPullRequestReviewThreadReplyInput!) {
    addPullRequestReviewThreadReply(input: $input) {
      comment { databaseId body path state }
    }
  }
`;

// =========== MCP SERVER ===========
class GitHubServer {
  private readonly server: Server;
  private readonly octokit: Octokit;
  private readonly config: GitHubConfig;
  private readonly paginator: GitHubPaginator;
  private readonly repoMoves = new RepoMoveCache();
  private authenticatedLogin?: string;
  private readonly dangerousToolNames = new Set<string>([
    "deletePullRequestTask",
  ]);
  private isDangerousTool(name: string): boolean {
    return this.dangerousToolNames.has(name);
  }

  constructor() {
    this.server = new Server(
      {
        name: "github-mcp-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Configuration from environment variables, with `gh auth token` as the
    // token fallback when GITHUB_TOKEN is unset.
    const token = resolveGitHubToken();
    if (!token) {
      throw new Error(
        "GitHub token is required. Set GITHUB_TOKEN, or install and log in to the GitHub CLI (`gh auth login`) so the server can use `gh auth token`."
      );
    }

    const allowDangerousCommands = isTruthyEnv(
      process.env.GITHUB_ENABLE_DANGEROUS ?? process.env.GITHUB_ALLOW_DANGEROUS
    );

    this.config = {
      baseUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
      token,
      defaultOwner: process.env.GITHUB_OWNER,
      defaultRepo: process.env.GITHUB_REPO,
      allowDangerousCommands,
    };

    this.octokit = new Octokit({
      auth: this.config.token,
      baseUrl: this.config.baseUrl.replace(/\/+$/, ""),
      userAgent: "github-mcp",
    });

    // Renamed/transferred repositories: GETs follow GitHub's redirect
    // transparently, but requests with a body fail with a content-length
    // mismatch because the body cannot be replayed. Rewrite such requests to
    // the repository's current location and retry once. The rewrite mutates
    // the options object in place: before-after-hook pre-binds that object
    // through the whole wrap chain, so arguments passed to `request` are
    // ignored and in-place mutation is the only way to change the request.
    this.octokit.hook.wrap("request", async (request, options) => {
      const params = options as unknown as Record<string, unknown>;
      this.applyKnownRepoMove(params);
      try {
        return await request(options);
      } catch (error) {
        if (!isContentLengthMismatchError(error)) throw error;
        const moved = await this.rewriteMovedRepo(params);
        if (!moved) throw error;
        return await request(options);
      }
    });

    this.paginator = new GitHubPaginator(logger);

    this.setupToolHandlers();

    // Add error handler - CRITICAL for stability
    this.server.onerror = (error) => logger.error("[MCP Error]", error);
  }

  /** Resolve owner/repo from arguments or GITHUB_OWNER/GITHUB_REPO. */
  private resolveContext(
    owner?: string,
    repo?: string
  ): { owner: string; repo: string } {
    const resolvedOwner = owner || this.config.defaultOwner;
    const resolvedRepo = repo || this.config.defaultRepo;
    if (!resolvedOwner || !resolvedRepo) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "owner and repo must be provided either as parameters or through the GITHUB_OWNER / GITHUB_REPO environment variables"
      );
    }
    return { owner: resolvedOwner, repo: resolvedRepo };
  }

  /** Rewrite a request's owner/repo in place through any known move. */
  private applyKnownRepoMove(options: Record<string, unknown>): void {
    if (typeof options.owner !== "string" || typeof options.repo !== "string") {
      return;
    }
    const moved = this.repoMoves.resolve({
      owner: options.owner,
      repo: options.repo,
    });
    if (!moved) return;
    options.owner = moved.owner;
    options.repo = moved.repo;
  }

  /**
   * Look up where a request's repository lives now; when it has moved,
   * record the move and rewrite the request's owner/repo in place. Returns
   * false when the repository has not moved (or the lookup itself fails),
   * meaning the original error stands.
   */
  private async rewriteMovedRepo(
    options: Record<string, unknown>
  ): Promise<boolean> {
    if (typeof options.owner !== "string" || typeof options.repo !== "string") {
      return false;
    }
    const from: RepoSlug = { owner: options.owner, repo: options.repo };
    let fullName: unknown;
    try {
      fullName = (
        await this.octokit.rest.repos.get({
          owner: from.owner,
          repo: from.repo,
        })
      ).data.full_name;
    } catch {
      return false;
    }
    const to = parseFullName(fullName);
    if (!to || sameSlug(from, to)) return false;
    this.repoMoves.record(from, to);
    this.adoptMovedDefaults(from, to);
    logger.warn("Repository moved; retrying request at its new location", {
      from: `${from.owner}/${from.repo}`,
      to: `${to.owner}/${to.repo}`,
    });
    options.owner = to.owner;
    options.repo = to.repo;
    return true;
  }

  /** Update GITHUB_OWNER/GITHUB_REPO defaults that point at a moved repo. */
  private adoptMovedDefaults(from: RepoSlug, to: RepoSlug): void {
    if (this.config.defaultOwner?.toLowerCase() !== from.owner.toLowerCase()) {
      return;
    }
    if (this.config.defaultRepo?.toLowerCase() === from.repo.toLowerCase()) {
      this.config.defaultRepo = to.repo;
    }
    this.config.defaultOwner = to.owner;
  }

  private async getAuthenticatedLogin(): Promise<string> {
    if (this.authenticatedLogin) return this.authenticatedLogin;
    const response = await this.octokit.rest.users.getAuthenticated();
    this.authenticatedLogin = response.data.login;
    return this.authenticatedLogin;
  }

  private json(result: unknown) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private text(value: string) {
    return {
      content: [
        {
          type: "text",
          text: value,
        },
      ],
    };
  }

  /** Wrap an implementation with template-style logging + error mapping. */
  private async guard<T>(
    description: string,
    context: Record<string, unknown>,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      logger.info(description, context);
      return await fn();
    } catch (error) {
      logger.error(`Error: ${description}`, { error, ...context });
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        formatGitHubError(error, `Failed: ${description}`)
      );
    }
  }

  private setupToolHandlers() {
    // Register the list tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "listRepositories",
          description:
            "List repositories for an owner (organization or user). Supports a client-side partial name filter.",
          inputSchema: {
            type: "object",
            properties: {
              owner: OWNER_REPO_SCHEMA.owner,
              name: {
                type: "string",
                description:
                  "Filter repositories by name (partial match, case-insensitive)",
              },
              ...PAGINATION_BASE_SCHEMA,
              all: PAGINATION_ALL_SCHEMA,
            },
          },
        },
        {
          name: "getRepository",
          description: "Get repository details",
          inputSchema: {
            type: "object",
            properties: { ...OWNER_REPO_SCHEMA },
          },
        },
        {
          name: "getPullRequests",
          description:
            "Get pull requests for a repository. Supports an optional `author` filter (GitHub login) and a `state` filter (open, closed, merged, all). Author and merged filters are pushed server-side via the GitHub search API so callers avoid fetching every PR and filtering client-side.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              state: {
                type: "string",
                enum: ["open", "closed", "merged", "all"],
                description:
                  "Pull request state. `closed` includes merged PRs; `merged` matches only merged PRs (search API). Defaults to open.",
              },
              author: {
                type: "string",
                description:
                  "Optional author filter: a GitHub login (with or without a leading @). Server-side via the search API.",
              },
              ...PAGINATION_BASE_SCHEMA,
              all: PAGINATION_ALL_SCHEMA,
            },
          },
        },
        {
          name: "createPullRequest",
          description: "Create a new pull request",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              title: { type: "string", description: "Pull request title" },
              body: {
                type: "string",
                description: "Pull request description (markdown)",
              },
              head: {
                type: "string",
                description:
                  "Source branch name (use `user:branch` for cross-fork PRs)",
              },
              base: { type: "string", description: "Target branch name" },
              reviewers: {
                type: "array",
                items: { type: "string" },
                description: "List of reviewer logins to request",
              },
              draft: {
                type: "boolean",
                description: "Whether to create the pull request as a draft",
              },
            },
            required: ["title", "head", "base"],
          },
        },
        {
          name: "createDraftPullRequest",
          description: "Create a new draft pull request",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              title: { type: "string", description: "Pull request title" },
              body: {
                type: "string",
                description: "Pull request description (markdown)",
              },
              head: { type: "string", description: "Source branch name" },
              base: { type: "string", description: "Target branch name" },
              reviewers: {
                type: "array",
                items: { type: "string" },
                description: "List of reviewer logins to request",
              },
            },
            required: ["title", "head", "base"],
          },
        },
        {
          name: "publishDraftPullRequest",
          description:
            "Mark a draft pull request as ready for review (GraphQL markPullRequestReadyForReview)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "convertToDraft",
          description:
            "Convert a pull request back to a draft (GraphQL convertPullRequestToDraft)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPullRequest",
          description: "Get details for a specific pull request",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "updatePullRequest",
          description:
            "Update a pull request's title, body, or base branch",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              title: { type: "string", description: "New pull request title" },
              body: {
                type: "string",
                description: "New pull request description",
              },
              base: { type: "string", description: "New base branch name" },
            },
            required: ["pull_number"],
          },
        },
        {
          name: "mergePullRequest",
          description: "Merge a pull request",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              merge_method: {
                type: "string",
                enum: ["merge", "squash", "rebase"],
                description: "Merge method (defaults to merge)",
              },
              commit_title: {
                type: "string",
                description: "Title for the merge commit",
              },
              commit_message: {
                type: "string",
                description: "Message body for the merge commit",
              },
            },
            required: ["pull_number"],
          },
        },
        {
          name: "closePullRequest",
          description:
            "Close a pull request without merging (GitHub's analog of declining). Optionally posts a closing comment first.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              message: {
                type: "string",
                description:
                  "Optional comment posted on the PR before closing it",
              },
            },
            required: ["pull_number"],
          },
        },
        {
          name: "approvePullRequest",
          description:
            "Approve a pull request by submitting an APPROVE review. An existing empty pending review is submitted as the approval; a pending review with draft content must be submitted (submitPullRequestReview) or discarded (deletePendingReview) first.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              body: {
                type: "string",
                description: "Optional review body to include with the approval",
              },
            },
            required: ["pull_number"],
          },
        },
        {
          name: "unapprovePullRequest",
          description:
            "Remove the authenticated user's approval by dismissing their most recent APPROVED review",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              message: {
                type: "string",
                description:
                  "Dismissal message (defaults to 'Approval withdrawn')",
              },
            },
            required: ["pull_number"],
          },
        },
        {
          name: "createPullRequestReview",
          description:
            "Create a pull request review, optionally with multiple inline comments, published as ONE review (a single notification) instead of separate immediate comments. With `event` set the review is published in one shot; with `event` omitted the review is created PENDING (a draft, invisible to everyone else) for later submitPullRequestReview.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              body: {
                type: "string",
                description:
                  "Optional overall review summary (required by GitHub when event is COMMENT or REQUEST_CHANGES)",
              },
              event: {
                type: "string",
                enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"],
                description:
                  "Review action. When omitted, the review is created PENDING and must be submitted later with submitPullRequestReview.",
              },
              commit_id: {
                type: "string",
                description:
                  "Commit SHA to anchor the review to (defaults to the PR head)",
              },
              comments: {
                type: "array",
                description:
                  "Inline comments to include in the review, each anchored to a diff line",
                items: {
                  type: "object",
                  properties: {
                    path: {
                      type: "string",
                      description: "File path the comment applies to",
                    },
                    body: {
                      type: "string",
                      description: "Comment text (markdown)",
                    },
                    line: {
                      type: "number",
                      description:
                        "Line number in the diff (the end of the range for multi-line comments)",
                    },
                    side: {
                      type: "string",
                      enum: ["LEFT", "RIGHT"],
                      description:
                        "LEFT for deletions (old file), RIGHT for additions/context (new file). Defaults to RIGHT.",
                    },
                    start_line: {
                      type: "number",
                      description:
                        "Multi-line mode: first line of the range (must be <= line)",
                    },
                    start_side: {
                      type: "string",
                      enum: ["LEFT", "RIGHT"],
                      description: "Multi-line mode: side of start_line",
                    },
                  },
                  required: ["path", "body", "line"],
                },
              },
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPendingReview",
          description:
            "Get the authenticated user's pending (draft) review on a pull request, including its draft comments. Pending reviews are visible only to the account that owns them, so when that account differs from the one used in the browser this tool is the only way to inspect drafts before submitting.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "addCommentToPendingReview",
          description:
            "Add a single draft comment to the authenticated user's existing pending review (GraphQL addPullRequestReviewThread). Two modes: new inline thread (body + path + line) or a reply to an existing review comment thread (body + in_reply_to). Fails if no pending review exists; start one with createPullRequestReview (omit event).",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              body: { type: "string", description: "Comment text (markdown)" },
              path: {
                type: "string",
                description: "Inline mode: file path the comment applies to",
              },
              line: {
                type: "number",
                description:
                  "Inline mode: line number in the diff (the end of the range for multi-line comments)",
              },
              side: {
                type: "string",
                enum: ["LEFT", "RIGHT"],
                description:
                  "Inline mode: LEFT for deletions (old file), RIGHT for additions/context (new file). Defaults to RIGHT.",
              },
              start_line: {
                type: "number",
                description:
                  "Inline multi-line mode: first line of the range (must be <= line)",
              },
              start_side: {
                type: "string",
                enum: ["LEFT", "RIGHT"],
                description: "Inline multi-line mode: side of start_line",
              },
              in_reply_to: {
                type: "number",
                description:
                  "Reply mode: id of an existing review comment; the draft reply is added to that comment's thread",
              },
            },
            required: ["pull_number", "body"],
          },
        },
        {
          name: "submitPullRequestReview",
          description:
            "Submit (publish) a pending review, sending all of its draft comments as one review with a single notification. When review_id is omitted, the authenticated user's pending review on the PR is resolved automatically.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              event: {
                type: "string",
                enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"],
                description: "Review action to publish the pending review as",
              },
              body: {
                type: "string",
                description:
                  "Optional overall review summary (required by GitHub when event is COMMENT or REQUEST_CHANGES)",
              },
              review_id: {
                type: "number",
                description:
                  "Pending review id (defaults to the authenticated user's pending review on the PR)",
              },
            },
            required: ["pull_number", "event"],
          },
        },
        {
          name: "deletePendingReview",
          description:
            "Discard a pending (draft) review and its draft comments without publishing anything. Only works on PENDING reviews; GitHub rejects deleting submitted ones. When review_id is omitted, the authenticated user's pending review on the PR is resolved automatically.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              review_id: {
                type: "number",
                description:
                  "Pending review id (defaults to the authenticated user's pending review on the PR)",
              },
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPendingReviewPRs",
          description:
            "List open pull requests where the given user (defaults to the authenticated user) is requested as a reviewer. Uses the search API (`is:pr is:open review-requested:`). Optionally scoped to an owner or an explicit repository list.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description:
                  "Optional organization/user scope (defaults to GITHUB_OWNER; pass an empty string to search across all of GitHub)",
              },
              reviewer: {
                type: "string",
                description:
                  "Reviewer login (defaults to @me, the authenticated user)",
              },
              repositoryList: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional list of repositories to check (bare names use the resolved owner; `owner/name` works too)",
              },
              limit: {
                type: "number",
                description: "Maximum number of PRs to return (default 50)",
              },
            },
          },
        },
        {
          name: "getPullRequestActivity",
          description:
            "Get the timeline of events for a pull request (reviews, commits, labels, etc.)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              ...PAGINATION_BASE_SCHEMA,
              all: PAGINATION_ALL_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPullRequestComments",
          description:
            "Get all comments on a pull request: top-level conversation (issue) comments plus inline review comments grouped into threads, with thread resolution status when available.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPullRequestComment",
          description:
            "Get a single PR comment by id. Tries review (inline) comments first, then issue (top-level) comments; pass comment_type to skip detection.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              comment_id: {
                type: "number",
                description: "Comment id",
              },
              comment_type: {
                type: "string",
                enum: ["review", "issue"],
                description:
                  "Comment kind: review (inline) or issue (top-level). Auto-detected when omitted.",
              },
            },
            required: ["comment_id"],
          },
        },
        {
          name: "addPullRequestComment",
          description:
            "Add a comment to a pull request. Three modes: top-level conversation comment (body only), inline review comment on a diff line (body + path + line), or a reply to an existing review comment thread (body + in_reply_to).",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              body: { type: "string", description: "Comment text (markdown)" },
              path: {
                type: "string",
                description:
                  "Inline mode: file path the comment applies to",
              },
              line: {
                type: "number",
                description:
                  "Inline mode: line number in the diff the comment applies to (the end of the range for multi-line comments)",
              },
              side: {
                type: "string",
                enum: ["LEFT", "RIGHT"],
                description:
                  "Inline mode: LEFT for deletions (old file), RIGHT for additions/context (new file). Defaults to RIGHT.",
              },
              start_line: {
                type: "number",
                description:
                  "Inline multi-line mode: first line of the range (must be <= line)",
              },
              start_side: {
                type: "string",
                enum: ["LEFT", "RIGHT"],
                description: "Inline multi-line mode: side of start_line",
              },
              in_reply_to: {
                type: "number",
                description:
                  "Reply mode: id of the review comment being replied to",
              },
              commit_id: {
                type: "string",
                description:
                  "Inline mode: commit SHA to anchor the comment to (defaults to the PR head)",
              },
            },
            required: ["pull_number", "body"],
          },
        },
        {
          name: "updatePullRequestComment",
          description:
            "Update the text of a PR comment (review or issue comment; auto-detected unless comment_type is passed)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              comment_id: { type: "number", description: "Comment id" },
              body: { type: "string", description: "New comment text" },
              comment_type: {
                type: "string",
                enum: ["review", "issue"],
                description:
                  "Comment kind: review (inline) or issue (top-level). Auto-detected when omitted.",
              },
            },
            required: ["comment_id", "body"],
          },
        },
        {
          name: "deletePullRequestComment",
          description:
            "Delete a PR comment (review or issue comment; auto-detected unless comment_type is passed)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              comment_id: { type: "number", description: "Comment id" },
              comment_type: {
                type: "string",
                enum: ["review", "issue"],
                description:
                  "Comment kind: review (inline) or issue (top-level). Auto-detected when omitted.",
              },
            },
            required: ["comment_id"],
          },
        },
        {
          name: "resolveComment",
          description:
            "Resolve the review thread containing the given review comment (GraphQL resolveReviewThread)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              comment_id: {
                type: "number",
                description: "Id of any review comment in the thread",
              },
            },
            required: ["pull_number", "comment_id"],
          },
        },
        {
          name: "reopenComment",
          description:
            "Unresolve the review thread containing the given review comment (GraphQL unresolveReviewThread)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              comment_id: {
                type: "number",
                description: "Id of any review comment in the thread",
              },
            },
            required: ["pull_number", "comment_id"],
          },
        },
        {
          name: "minimizePullRequestComment",
          description:
            "Minimize (collapse/hide) a comment with a classification reason, matching the web UI 'Hide' action (GraphQL minimizeComment). Works on conversation/issue comments and PR review comments; the numeric id is auto-resolved to its node id.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              comment_id: {
                type: "number",
                description:
                  "Numeric comment id (issue/conversation or PR review comment). Auto-resolved to a GraphQL node id.",
              },
              comment_type: {
                type: "string",
                enum: ["review", "issue"],
                description:
                  "Comment kind: review (inline) or issue (top-level/conversation). Auto-detected when omitted.",
              },
              reason: {
                type: "string",
                enum: [...MINIMIZE_REASONS],
                description:
                  "Classification reason (ReportedContentClassifiers). Case-insensitive. Defaults to OUTDATED.",
              },
              node_id: {
                type: "string",
                description:
                  "GraphQL node id to minimize directly, bypassing numeric-id resolution.",
              },
            },
            required: [],
          },
        },
        {
          name: "unminimizePullRequestComment",
          description:
            "Unminimize (un-collapse) a previously minimized comment (GraphQL unminimizeComment). Works on conversation/issue comments and PR review comments; the numeric id is auto-resolved to its node id.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              comment_id: {
                type: "number",
                description:
                  "Numeric comment id (issue/conversation or PR review comment). Auto-resolved to a GraphQL node id.",
              },
              comment_type: {
                type: "string",
                enum: ["review", "issue"],
                description:
                  "Comment kind: review (inline) or issue (top-level/conversation). Auto-detected when omitted.",
              },
              node_id: {
                type: "string",
                description:
                  "GraphQL node id to unminimize directly, bypassing numeric-id resolution.",
              },
            },
            required: [],
          },
        },
        {
          name: "checkPrReplies",
          description:
            "Check PR comment threads for replies. Default (self) mode finds threads where the given user has commented and someone else replied after their last comment. `all` mode returns every thread that has at least one reply. Identity defaults to the authenticated user's login.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_numbers: {
                type: "array",
                items: { type: "number" },
                description: "Pull request numbers to check",
              },
              self: {
                type: "string",
                description:
                  "GitHub login to treat as 'self' (defaults to the authenticated user)",
              },
              all: {
                type: "boolean",
                description:
                  "Return all threads with replies instead of only those with new replies to self",
              },
            },
            required: ["pull_numbers"],
          },
        },
        {
          name: "getPullRequestTasks",
          description:
            "List PR tasks. GitHub has no native PR task object; tasks are emulated as a markdown checklist in a dedicated, marker-tagged PR comment.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "createPullRequestTask",
          description:
            "Create a PR task (appends a checklist item to the managed tasks comment, creating the comment if needed)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              content: { type: "string", description: "Task text" },
              state: {
                type: "string",
                enum: ["OPEN", "RESOLVED"],
                description: "Initial task state (defaults to OPEN)",
              },
            },
            required: ["pull_number", "content"],
          },
        },
        {
          name: "getPullRequestTask",
          description: "Get a single PR task by id (1-based checklist position)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              task_id: { type: "number", description: "Task id" },
            },
            required: ["pull_number", "task_id"],
          },
        },
        {
          name: "updatePullRequestTask",
          description:
            "Update a PR task's content and/or state (OPEN/RESOLVED toggles the checkbox)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              task_id: { type: "number", description: "Task id" },
              content: { type: "string", description: "New task text" },
              state: {
                type: "string",
                enum: ["OPEN", "RESOLVED"],
                description: "New task state",
              },
            },
            required: ["pull_number", "task_id"],
          },
        },
        {
          name: "deletePullRequestTask",
          description:
            "Delete a PR task from the managed checklist comment. Task ids after the deleted one are renumbered.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              task_id: { type: "number", description: "Task id" },
            },
            required: ["pull_number", "task_id"],
          },
        },
        {
          name: "getPullRequestDiff",
          description: "Get the unified diff for a pull request",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPullRequestPatch",
          description: "Get the patch (git format-patch style) for a pull request",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPullRequestDiffStat",
          description:
            "Get per-file change statistics for a pull request (filename, status, additions, deletions)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              ...PAGINATION_BASE_SCHEMA,
              all: PAGINATION_ALL_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPullRequestDiffChunks",
          description:
            "Get the diff hunk map for a pull request: each changed file mapped to its hunks (old/new start lines and counts). Useful for placing inline comments. Optionally filtered to one path.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              path: {
                type: "string",
                description: "Optional path filter (exact or suffix match)",
              },
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPullRequestCommits",
          description: "List the commits on a pull request",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
              ...PAGINATION_BASE_SCHEMA,
              all: PAGINATION_ALL_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "getPullRequestStatuses",
          description:
            "Get CI state for a pull request's head commit: the combined commit status plus check runs (GitHub Actions and other check suites)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              pull_number: PULL_NUMBER_SCHEMA,
            },
            required: ["pull_number"],
          },
        },
        {
          name: "listWorkflows",
          description: "List GitHub Actions workflows defined in a repository",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              ...PAGINATION_BASE_SCHEMA,
              all: PAGINATION_ALL_SCHEMA,
            },
          },
        },
        {
          name: "listWorkflowRuns",
          description:
            "List GitHub Actions workflow runs for a repository, optionally filtered by workflow, branch, status, event, or actor",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              workflow_id: {
                type: "string",
                description:
                  "Optional workflow id or file name (e.g. ci.yml) to scope runs to one workflow",
              },
              branch: {
                type: "string",
                description: "Filter runs by head branch",
              },
              status: {
                type: "string",
                enum: [
                  "queued",
                  "in_progress",
                  "completed",
                  "success",
                  "failure",
                  "cancelled",
                  "timed_out",
                  "action_required",
                  "neutral",
                  "skipped",
                  "stale",
                  "requested",
                  "waiting",
                  "pending",
                ],
                description: "Filter runs by status or conclusion",
              },
              event: {
                type: "string",
                description:
                  "Filter runs by trigger event (e.g. push, pull_request, workflow_dispatch, schedule)",
              },
              actor: {
                type: "string",
                description: "Filter runs by the login that triggered them",
              },
              ...PAGINATION_BASE_SCHEMA,
              all: PAGINATION_ALL_SCHEMA,
            },
          },
        },
        {
          name: "getWorkflowRun",
          description: "Get details for a single GitHub Actions workflow run",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              run_id: { type: "number", description: "Workflow run id" },
            },
            required: ["run_id"],
          },
        },
        {
          name: "listWorkflowJobs",
          description:
            "List the jobs for a GitHub Actions workflow run (with per-step status)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              run_id: { type: "number", description: "Workflow run id" },
              filter: {
                type: "string",
                enum: ["latest", "all"],
                description:
                  "latest (default) returns jobs from the most recent attempt; all returns jobs from every attempt",
              },
              ...PAGINATION_BASE_SCHEMA,
              all: PAGINATION_ALL_SCHEMA,
            },
            required: ["run_id"],
          },
        },
        {
          name: "getWorkflowJob",
          description: "Get details for a single GitHub Actions job",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              job_id: { type: "number", description: "Job id" },
            },
            required: ["job_id"],
          },
        },
        {
          name: "getWorkflowJobLogs",
          description:
            "Get the plain-text logs for a GitHub Actions job, with truncation and filtering controls (max_lines, tail, errors_only, search_term) and an option to save the full log to a temporary file.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              job_id: { type: "number", description: "Job id" },
              max_lines: {
                type: "number",
                description:
                  "Maximum number of lines to return (default 500, cap 5000)",
              },
              tail: {
                type: "boolean",
                description:
                  "Return the last lines instead of the first lines",
              },
              errors_only: {
                type: "boolean",
                description:
                  "Only return lines matching common error patterns (error, failed, exception, ...)",
              },
              search_term: {
                type: "string",
                description:
                  "Only return lines containing this term (case-insensitive)",
              },
              save_to_file: {
                type: "boolean",
                description:
                  "Save the full, unfiltered log to a temporary file and include its path in the response",
              },
            },
            required: ["job_id"],
          },
        },
        {
          name: "runWorkflow",
          description:
            "Trigger a workflow_dispatch event for a workflow (requires the workflow to declare `on: workflow_dispatch` and the token to have the workflow scope)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              workflow_id: {
                type: "string",
                description: "Workflow id or file name (e.g. ci.yml)",
              },
              ref: {
                type: "string",
                description:
                  "Git ref (branch or tag) to run the workflow on",
              },
              inputs: {
                type: "object",
                description:
                  "Optional workflow_dispatch inputs as key/value pairs",
              },
            },
            required: ["workflow_id", "ref"],
          },
        },
        {
          name: "cancelWorkflowRun",
          description: "Cancel an in-progress GitHub Actions workflow run",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              run_id: { type: "number", description: "Workflow run id" },
            },
            required: ["run_id"],
          },
        },
        {
          name: "getBranchProtection",
          description:
            "Get the branch protection rules for a branch (defaults to the repository's default branch)",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              branch: {
                type: "string",
                description:
                  "Branch name (defaults to the repository default branch)",
              },
            },
          },
        },
        {
          name: "getCodeowners",
          description:
            "Fetch and parse the repository's CODEOWNERS file (checked in .github/, the repo root, then docs/). GitHub's closest analog to Bitbucket's effective default reviewers.",
          inputSchema: {
            type: "object",
            properties: {
              ...OWNER_REPO_SCHEMA,
              ref: {
                type: "string",
                description:
                  "Git ref to read CODEOWNERS from (defaults to the default branch)",
              },
            },
          },
        },
      ].filter(
        (tool) =>
          this.config.allowDangerousCommands === true ||
          !this.isDangerousTool(tool.name)
      ),
    }));

    // Register the call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        logger.info(`Called tool: ${request.params.name}`, {
          arguments: request.params.arguments,
        });
        const args = request.params.arguments ?? {};
        const toolName = request.params.name;

        // Guard dangerous tools when not enabled
        if (
          this.isDangerousTool(toolName) &&
          this.config.allowDangerousCommands !== true
        ) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool ${toolName} is disabled. Set GITHUB_ENABLE_DANGEROUS=true to enable.`
          );
        }

        switch (toolName) {
          case "listRepositories":
            return await this.listRepositories(
              args.owner as string | undefined,
              args.name as string | undefined,
              args.per_page as number | undefined,
              args.page as number | undefined,
              args.all as boolean | undefined
            );
          case "getRepository":
            return await this.getRepository(
              args.owner as string | undefined,
              args.repo as string | undefined
            );
          case "getPullRequests":
            return await this.getPullRequests(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.state as PullRequestStateFilter | undefined,
              args.author as string | undefined,
              args.per_page as number | undefined,
              args.page as number | undefined,
              args.all as boolean | undefined
            );
          case "createPullRequest":
            return await this.createPullRequest(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.title as string,
              args.body as string | undefined,
              args.head as string,
              args.base as string,
              args.reviewers as string[] | undefined,
              args.draft as boolean | undefined
            );
          case "createDraftPullRequest":
            return await this.createPullRequest(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.title as string,
              args.body as string | undefined,
              args.head as string,
              args.base as string,
              args.reviewers as string[] | undefined,
              true
            );
          case "publishDraftPullRequest":
            return await this.setDraftState(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              false
            );
          case "convertToDraft":
            return await this.setDraftState(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              true
            );
          case "getPullRequest":
            return await this.getPullRequest(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number
            );
          case "updatePullRequest":
            return await this.updatePullRequest(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.title as string | undefined,
              args.body as string | undefined,
              args.base as string | undefined
            );
          case "mergePullRequest":
            return await this.mergePullRequest(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.merge_method as "merge" | "squash" | "rebase" | undefined,
              args.commit_title as string | undefined,
              args.commit_message as string | undefined
            );
          case "closePullRequest":
            return await this.closePullRequest(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.message as string | undefined
            );
          case "approvePullRequest":
            return await this.approvePullRequest(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.body as string | undefined
            );
          case "unapprovePullRequest":
            return await this.unapprovePullRequest(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.message as string | undefined
            );
          case "createPullRequestReview":
            return await this.createPullRequestReview(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.body as string | undefined,
              args.event as
                | "COMMENT"
                | "APPROVE"
                | "REQUEST_CHANGES"
                | undefined,
              args.commit_id as string | undefined,
              args.comments as ReviewCommentDraft[] | undefined
            );
          case "getPendingReview":
            return await this.getPendingReview(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number
            );
          case "addCommentToPendingReview":
            return await this.addCommentToPendingReview(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.body as string,
              {
                path: args.path as string | undefined,
                line: args.line as number | undefined,
                side: args.side as "LEFT" | "RIGHT" | undefined,
                start_line: args.start_line as number | undefined,
                start_side: args.start_side as "LEFT" | "RIGHT" | undefined,
                in_reply_to: args.in_reply_to as number | undefined,
              }
            );
          case "submitPullRequestReview":
            return await this.submitPullRequestReview(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.event as "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
              args.body as string | undefined,
              args.review_id as number | undefined
            );
          case "deletePendingReview":
            return await this.deletePendingReview(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.review_id as number | undefined
            );
          case "getPendingReviewPRs":
            return await this.getPendingReviewPRs(
              args.owner as string | undefined,
              args.reviewer as string | undefined,
              args.repositoryList as string[] | undefined,
              args.limit as number | undefined
            );
          case "getPullRequestActivity":
            return await this.getPullRequestActivity(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.per_page as number | undefined,
              args.page as number | undefined,
              args.all as boolean | undefined
            );
          case "getPullRequestComments":
            return await this.getPullRequestComments(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number
            );
          case "getPullRequestComment":
            return await this.getPullRequestComment(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.comment_id as number,
              args.comment_type as "review" | "issue" | undefined
            );
          case "addPullRequestComment":
            return await this.addPullRequestComment(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.body as string,
              {
                path: args.path as string | undefined,
                line: args.line as number | undefined,
                side: args.side as "LEFT" | "RIGHT" | undefined,
                start_line: args.start_line as number | undefined,
                start_side: args.start_side as "LEFT" | "RIGHT" | undefined,
                in_reply_to: args.in_reply_to as number | undefined,
                commit_id: args.commit_id as string | undefined,
              }
            );
          case "updatePullRequestComment":
            return await this.updatePullRequestComment(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.comment_id as number,
              args.body as string,
              args.comment_type as "review" | "issue" | undefined
            );
          case "deletePullRequestComment":
            return await this.deletePullRequestComment(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.comment_id as number,
              args.comment_type as "review" | "issue" | undefined
            );
          case "resolveComment":
            return await this.setCommentResolved(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.comment_id as number,
              true
            );
          case "reopenComment":
            return await this.setCommentResolved(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.comment_id as number,
              false
            );
          case "minimizePullRequestComment":
            return await this.minimizePullRequestComment(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.comment_id as number | undefined,
              args.reason as string | undefined,
              args.comment_type as "review" | "issue" | undefined,
              args.node_id as string | undefined
            );
          case "unminimizePullRequestComment":
            return await this.unminimizePullRequestComment(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.comment_id as number | undefined,
              args.comment_type as "review" | "issue" | undefined,
              args.node_id as string | undefined
            );
          case "checkPrReplies":
            return await this.checkPrReplies(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_numbers as number[],
              args.self as string | undefined,
              args.all as boolean | undefined
            );
          case "getPullRequestTasks":
            return await this.getPullRequestTasks(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number
            );
          case "createPullRequestTask":
            return await this.createPullRequestTask(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.content as string,
              args.state as TaskState | undefined
            );
          case "getPullRequestTask":
            return await this.getPullRequestTask(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.task_id as number
            );
          case "updatePullRequestTask":
            return await this.updatePullRequestTask(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.task_id as number,
              args.content as string | undefined,
              args.state as TaskState | undefined
            );
          case "deletePullRequestTask":
            return await this.deletePullRequestTask(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.task_id as number
            );
          case "getPullRequestDiff":
            return await this.getPullRequestDiff(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number
            );
          case "getPullRequestPatch":
            return await this.getPullRequestPatch(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number
            );
          case "getPullRequestDiffStat":
            return await this.getPullRequestDiffStat(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.per_page as number | undefined,
              args.page as number | undefined,
              args.all as boolean | undefined
            );
          case "getPullRequestDiffChunks":
            return await this.getPullRequestDiffChunks(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.path as string | undefined
            );
          case "getPullRequestCommits":
            return await this.getPullRequestCommits(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number,
              args.per_page as number | undefined,
              args.page as number | undefined,
              args.all as boolean | undefined
            );
          case "getPullRequestStatuses":
            return await this.getPullRequestStatuses(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.pull_number as number
            );
          case "listWorkflows":
            return await this.listWorkflows(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.per_page as number | undefined,
              args.page as number | undefined,
              args.all as boolean | undefined
            );
          case "listWorkflowRuns":
            return await this.listWorkflowRuns(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.workflow_id as string | undefined,
              args.branch as string | undefined,
              args.status as string | undefined,
              args.event as string | undefined,
              args.actor as string | undefined,
              args.per_page as number | undefined,
              args.page as number | undefined,
              args.all as boolean | undefined
            );
          case "getWorkflowRun":
            return await this.getWorkflowRun(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.run_id as number
            );
          case "listWorkflowJobs":
            return await this.listWorkflowJobs(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.run_id as number,
              args.filter as "latest" | "all" | undefined,
              args.per_page as number | undefined,
              args.page as number | undefined,
              args.all as boolean | undefined
            );
          case "getWorkflowJob":
            return await this.getWorkflowJob(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.job_id as number
            );
          case "getWorkflowJobLogs":
            return await this.getWorkflowJobLogs(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.job_id as number,
              args.max_lines as number | undefined,
              args.tail as boolean | undefined,
              args.errors_only as boolean | undefined,
              args.search_term as string | undefined,
              args.save_to_file as boolean | undefined
            );
          case "runWorkflow":
            return await this.runWorkflow(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.workflow_id as string,
              args.ref as string,
              args.inputs as Record<string, unknown> | undefined
            );
          case "cancelWorkflowRun":
            return await this.cancelWorkflowRun(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.run_id as number
            );
          case "getBranchProtection":
            return await this.getBranchProtection(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.branch as string | undefined
            );
          case "getCodeowners":
            return await this.getCodeowners(
              args.owner as string | undefined,
              args.repo as string | undefined,
              args.ref as string | undefined
            );
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        logger.error("Tool execution error", { error });
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          formatGitHubError(error, "GitHub API error")
        );
      }
    });
  }

  // =========== REPOSITORY METHODS ===========

  async listRepositories(
    owner?: string,
    name?: string,
    per_page?: number,
    page?: number,
    all?: boolean
  ) {
    const resolvedOwner = owner || this.config.defaultOwner;
    if (!resolvedOwner) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "owner must be provided either as a parameter or through the GITHUB_OWNER environment variable"
      );
    }
    return this.guard(
      "listRepositories",
      { owner: resolvedOwner, name, per_page, page, all },
      async () => {
        const ownerInfo = await this.octokit.rest.users.getByUsername({
          username: resolvedOwner,
        });
        const isOrg = ownerInfo.data.type === "Organization";

        const result = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            isOrg
              ? (
                  await this.octokit.rest.repos.listForOrg({
                    org: resolvedOwner,
                    per_page: pp,
                    page: p,
                    sort: "updated",
                  })
                ).data
              : (
                  await this.octokit.rest.repos.listForUser({
                    username: resolvedOwner,
                    per_page: pp,
                    page: p,
                    sort: "updated",
                  })
                ).data,
          { per_page, page, all, description: "listRepositories" }
        );

        let repos = result.values;
        if (name) {
          const needle = name.toLowerCase();
          repos = repos.filter((r: any) =>
            String(r.name).toLowerCase().includes(needle)
          );
        }

        return this.json(
          repos.map((r: any) => ({
            name: r.name,
            full_name: r.full_name,
            private: r.private,
            description: r.description,
            default_branch: r.default_branch,
            language: r.language,
            archived: r.archived,
            updated_at: r.updated_at,
            html_url: r.html_url,
          }))
        );
      }
    );
  }

  async getRepository(owner?: string, repo?: string) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard("getRepository", { ...ctx }, async () => {
      const response = await this.octokit.rest.repos.get({
        owner: ctx.owner,
        repo: ctx.repo,
      });
      return this.json(response.data);
    });
  }

  // =========== PULL REQUEST METHODS ===========

  async getPullRequests(
    owner?: string,
    repo?: string,
    state?: PullRequestStateFilter,
    author?: string,
    per_page?: number,
    page?: number,
    all?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequests",
      { ...ctx, state, author, per_page, page, all },
      async () => {
        const hasAuthor = !!(author && author.trim().length > 0);

        // The REST list endpoint has no author filter and cannot distinguish
        // merged from closed; both cases route through the search API.
        if (hasAuthor || state === "merged") {
          const q = buildPullRequestSearchQuery(ctx.owner, ctx.repo, {
            author,
            state,
          });
          const result = await this.paginator.fetchValues<any>(
            async (p, pp) =>
              (
                await this.octokit.rest.search.issuesAndPullRequests({
                  q,
                  per_page: pp,
                  page: p,
                  sort: "updated",
                  order: "desc",
                  advanced_search: "true",
                } as any)
              ).data.items,
            { per_page, page, all, description: "getPullRequests(search)" }
          );
          return this.json(result.values.map(summarizeSearchItem));
        }

        const restState =
          state === "all" ? "all" : state === "closed" ? "closed" : "open";
        const result = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            (
              await this.octokit.rest.pulls.list({
                owner: ctx.owner,
                repo: ctx.repo,
                state: restState,
                per_page: pp,
                page: p,
                sort: "updated",
                direction: "desc",
              })
            ).data,
          { per_page, page, all, description: "getPullRequests" }
        );
        return this.json(result.values.map(summarizePullRequest));
      }
    );
  }

  async createPullRequest(
    owner: string | undefined,
    repo: string | undefined,
    title: string,
    body: string | undefined,
    head: string,
    base: string,
    reviewers?: string[],
    draft?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "createPullRequest",
      { ...ctx, title, head, base, draft },
      async () => {
        const response = await this.octokit.rest.pulls.create({
          owner: ctx.owner,
          repo: ctx.repo,
          title,
          body,
          head,
          base,
          draft: draft === true,
        });

        let reviewerWarning: string | undefined;
        const requested = (reviewers ?? [])
          .map((login) => login.trim().replace(/^@/, ""))
          .filter((login) => login.length > 0);
        if (requested.length > 0) {
          try {
            await this.octokit.rest.pulls.requestReviewers({
              owner: ctx.owner,
              repo: ctx.repo,
              pull_number: response.data.number,
              reviewers: requested,
            });
          } catch (error) {
            reviewerWarning = formatGitHubError(
              error,
              "PR created, but requesting reviewers failed"
            );
            logger.warn("Requesting reviewers failed", { error });
          }
        }

        return this.json({
          ...summarizePullRequest(response.data),
          body: response.data.body,
          ...(reviewerWarning ? { reviewer_warning: reviewerWarning } : {}),
        });
      }
    );
  }

  /** Toggle draft state via GraphQL (REST cannot publish/convert drafts). */
  async setDraftState(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    draft: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      draft ? "convertToDraft" : "publishDraftPullRequest",
      { ...ctx, pull_number },
      async () => {
        const pr = await this.octokit.rest.pulls.get({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number,
        });
        const mutation = draft
          ? CONVERT_TO_DRAFT_MUTATION
          : MARK_READY_MUTATION;
        const response: any = await this.octokit.graphql(mutation, {
          pullRequestId: pr.data.node_id,
        });
        const result = draft
          ? response?.convertPullRequestToDraft?.pullRequest
          : response?.markPullRequestReadyForReview?.pullRequest;
        return this.json({
          number: result?.number ?? pull_number,
          is_draft: result?.isDraft ?? draft,
        });
      }
    );
  }

  async getPullRequest(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard("getPullRequest", { ...ctx, pull_number }, async () => {
      const response = await this.octokit.rest.pulls.get({
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number,
      });
      const pr = response.data;
      return this.json({
        ...summarizePullRequest(pr),
        body: pr.body,
        mergeable: pr.mergeable,
        mergeable_state: pr.mergeable_state,
        merged_by: pr.merged_by?.login,
        comments: pr.comments,
        review_comments: pr.review_comments,
        commits: pr.commits,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        labels: pr.labels?.map((l: any) => l.name),
        node_id: pr.node_id,
      });
    });
  }

  async updatePullRequest(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    title?: string,
    body?: string,
    base?: string
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "updatePullRequest",
      { ...ctx, pull_number, title, base },
      async () => {
        const response = await this.octokit.rest.pulls.update({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number,
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(base !== undefined ? { base } : {}),
        });
        return this.json({
          ...summarizePullRequest(response.data),
          body: response.data.body,
        });
      }
    );
  }

  async mergePullRequest(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    merge_method?: "merge" | "squash" | "rebase",
    commit_title?: string,
    commit_message?: string
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "mergePullRequest",
      { ...ctx, pull_number, merge_method },
      async () => {
        const response = await this.octokit.rest.pulls.merge({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number,
          merge_method: merge_method ?? "merge",
          ...(commit_title !== undefined ? { commit_title } : {}),
          ...(commit_message !== undefined ? { commit_message } : {}),
        });
        return this.json(response.data);
      }
    );
  }

  async closePullRequest(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    message?: string
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "closePullRequest",
      { ...ctx, pull_number },
      async () => {
        if (message && message.trim().length > 0) {
          await this.octokit.rest.issues.createComment({
            owner: ctx.owner,
            repo: ctx.repo,
            issue_number: pull_number,
            body: message,
          });
        }
        const response = await this.octokit.rest.pulls.update({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number,
          state: "closed",
        });
        return this.json(summarizePullRequest(response.data));
      }
    );
  }

  async approvePullRequest(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    body?: string
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "approvePullRequest",
      { ...ctx, pull_number },
      async () => {
        // An existing pending review blocks review creation, so handle it
        // first: submit an empty draft as the approval, refuse to silently
        // publish one that has content.
        const existing = await this.findOwnPendingReview(
          ctx.owner,
          ctx.repo,
          pull_number
        );
        if (existing) {
          const commentCount = await this.countReviewComments(
            ctx,
            pull_number,
            existing.id
          );
          const plan = planApprovalWithPendingReview(
            existing,
            commentCount,
            pull_number
          );
          if (plan.action === "block") {
            throw new McpError(ErrorCode.InvalidParams, plan.reason);
          }
          return await this.submitApproval(
            ctx,
            pull_number,
            existing.id,
            body,
            "Submitted an existing empty pending review as the approval."
          );
        }

        try {
          const response = await this.octokit.rest.pulls.createReview({
            owner: ctx.owner,
            repo: ctx.repo,
            pull_number,
            event: "APPROVE",
            ...(body !== undefined ? { body } : {}),
          });
          return this.json({
            review_id: response.data.id,
            state: response.data.state,
            author: response.data.user?.login,
            submitted_at: response.data.submitted_at,
          });
        } catch (error) {
          // A failed create may still have created the pending review on
          // GitHub's side. Finish the approval by submitting that orphan,
          // or discard it so a retry isn't blocked by it.
          const orphan = await this.findOwnPendingReview(
            ctx.owner,
            ctx.repo,
            pull_number
          ).catch(() => undefined);
          if (orphan) {
            try {
              return await this.submitApproval(
                ctx,
                pull_number,
                orphan.id,
                body,
                "Recovered by submitting the pending review left by a failed review creation."
              );
            } catch {
              await this.octokit.rest.pulls
                .deletePendingReview({
                  owner: ctx.owner,
                  repo: ctx.repo,
                  pull_number,
                  review_id: orphan.id,
                })
                .catch(() => undefined);
            }
          }
          throw error;
        }
      }
    );
  }

  /**
   * Find the authenticated user's pending review on a PR, or undefined when
   * there is none. Throws InvalidParams when the lookup is ambiguous.
   */
  private async findOwnPendingReview(
    owner: string,
    repo: string,
    pull_number: number
  ): Promise<PendingReviewCandidate | undefined> {
    const login = await this.getAuthenticatedLogin();
    const reviews = await this.listAllReviews(owner, repo, pull_number);
    const resolution = resolvePendingReview(reviews, login);
    if (resolution.kind === "ambiguous") {
      throw new McpError(
        ErrorCode.InvalidParams,
        describePendingReviewFailure(resolution, login, pull_number)
      );
    }
    return resolution.kind === "found" ? resolution.review : undefined;
  }

  /** Count a review's comments (first page only; up to 100). */
  private async countReviewComments(
    ctx: { owner: string; repo: string },
    pull_number: number,
    review_id: number
  ): Promise<number> {
    const response = await this.octokit.rest.pulls.listCommentsForReview({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number,
      review_id,
      per_page: 100,
      page: 1,
    });
    return response.data.length;
  }

  /** Submit a pending review as an APPROVE event. */
  private async submitApproval(
    ctx: { owner: string; repo: string },
    pull_number: number,
    review_id: number,
    body: string | undefined,
    note: string
  ) {
    const response = await this.octokit.rest.pulls.submitReview({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number,
      review_id,
      event: "APPROVE",
      ...(body !== undefined ? { body } : {}),
    });
    return this.json({
      review_id: response.data.id,
      state: response.data.state,
      author: response.data.user?.login,
      submitted_at: response.data.submitted_at,
      note,
    });
  }

  async unapprovePullRequest(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    message?: string
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "unapprovePullRequest",
      { ...ctx, pull_number },
      async () => {
        const login = await this.getAuthenticatedLogin();
        const reviews = await this.listAllReviews(
          ctx.owner,
          ctx.repo,
          pull_number
        );

        const myApprovals = reviews.filter(
          (review: any) =>
            review.user?.login === login && review.state === "APPROVED"
        );
        if (myApprovals.length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No approving review by ${login} found on PR #${pull_number}`
          );
        }

        const latest = myApprovals[myApprovals.length - 1];
        const response = await this.octokit.rest.pulls.dismissReview({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number,
          review_id: latest.id,
          message: message ?? "Approval withdrawn",
        });
        return this.json({
          dismissed_review_id: latest.id,
          state: response.data.state,
        });
      }
    );
  }

  // =========== REVIEW BATCHING METHODS ===========

  /** Fetch every review on a pull request (all pages). */
  private async listAllReviews(
    owner: string,
    repo: string,
    pull_number: number
  ): Promise<any[]> {
    const result = await this.paginator.fetchValues<any>(
      async (p, pp) =>
        (
          await this.octokit.rest.pulls.listReviews({
            owner,
            repo,
            pull_number,
            per_page: pp,
            page: p,
          })
        ).data,
      { all: true, per_page: 100, description: "listReviews" }
    );
    return result.values;
  }

  /**
   * Resolve the authenticated user's single pending review on a PR, throwing
   * an InvalidParams error when none exists or the lookup is ambiguous.
   */
  private async requirePendingReview(
    owner: string,
    repo: string,
    pull_number: number
  ): Promise<PendingReviewCandidate> {
    const login = await this.getAuthenticatedLogin();
    const reviews = await this.listAllReviews(owner, repo, pull_number);
    const resolution = resolvePendingReview(reviews, login);
    if (resolution.kind !== "found") {
      throw new McpError(
        ErrorCode.InvalidParams,
        describePendingReviewFailure(resolution, login, pull_number)
      );
    }
    return resolution.review;
  }

  async createPullRequestReview(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    body?: string,
    event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
    commit_id?: string,
    comments?: ReviewCommentDraft[]
  ) {
    const ctx = this.resolveContext(owner, repo);
    // Sign the top-level review summary only; never the inline comments[].
    body = applySignature(body);
    return this.guard(
      "createPullRequestReview",
      { ...ctx, pull_number, event, comment_count: comments?.length ?? 0 },
      async () => {
        if (comments && comments.length > 0) {
          const problems = validateReviewCommentDrafts(comments);
          if (problems.length > 0) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid review comments: ${problems.join("; ")}`
            );
          }
        }
        const response = await this.octokit.rest.pulls.createReview({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number,
          ...(body !== undefined ? { body } : {}),
          ...(event !== undefined ? { event } : {}),
          ...(commit_id !== undefined ? { commit_id } : {}),
          ...(comments && comments.length > 0
            ? {
                comments: comments.map((comment) => ({
                  path: comment.path,
                  body: comment.body,
                  line: comment.line,
                  side: comment.side ?? "RIGHT",
                  ...(comment.start_line !== undefined
                    ? {
                        start_line: comment.start_line,
                        start_side:
                          comment.start_side ?? comment.side ?? "RIGHT",
                      }
                    : {}),
                })),
              }
            : {}),
        });
        const state = response.data.state;
        return this.json({
          review_id: response.data.id,
          state,
          pending: state === "PENDING",
          author: response.data.user?.login,
          submitted_at: response.data.submitted_at,
          comment_count: comments?.length ?? 0,
          html_url: response.data.html_url,
          ...(state === "PENDING"
            ? {
                note: "Review is an unpublished draft. Add comments with addCommentToPendingReview, publish with submitPullRequestReview, or discard with deletePendingReview.",
              }
            : {}),
        });
      }
    );
  }

  async getPendingReview(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPendingReview",
      { ...ctx, pull_number },
      async () => {
        const login = await this.getAuthenticatedLogin();
        const reviews = await this.listAllReviews(
          ctx.owner,
          ctx.repo,
          pull_number
        );
        const resolution = resolvePendingReview(reviews, login);
        if (resolution.kind === "none") {
          return this.json({
            pending_review: null,
            message: describePendingReviewFailure(
              resolution,
              login,
              pull_number
            ),
          });
        }
        if (resolution.kind === "ambiguous") {
          throw new McpError(
            ErrorCode.InvalidParams,
            describePendingReviewFailure(resolution, login, pull_number)
          );
        }

        const review = resolution.review;
        const comments = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            (
              await this.octokit.rest.pulls.listCommentsForReview({
                owner: ctx.owner,
                repo: ctx.repo,
                pull_number,
                review_id: review.id,
                per_page: pp,
                page: p,
              })
            ).data,
          { all: true, per_page: 100, description: "listCommentsForReview" }
        );

        return this.json({
          pending_review: {
            review_id: review.id,
            node_id: review.node_id,
            author: login,
            state: "PENDING",
            body: review.body || undefined,
            commit_id: review.commit_id,
            html_url: review.html_url,
            comment_count: comments.values.length,
            comments: comments.values.map((comment: any) => ({
              id: comment.id,
              path: comment.path,
              line: comment.line ?? comment.original_line,
              start_line: comment.start_line ?? comment.original_start_line,
              side: comment.side,
              start_side: comment.start_side,
              in_reply_to_id: comment.in_reply_to_id,
              body: comment.body,
            })),
          },
        });
      }
    );
  }

  async addCommentToPendingReview(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    body: string,
    options: {
      path?: string;
      line?: number;
      side?: "LEFT" | "RIGHT";
      start_line?: number;
      start_side?: "LEFT" | "RIGHT";
      in_reply_to?: number;
    } = {}
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "addCommentToPendingReview",
      { ...ctx, pull_number, ...options },
      async () => {
        const review = await this.requirePendingReview(
          ctx.owner,
          ctx.repo,
          pull_number
        );
        if (!review.node_id) {
          throw new McpError(
            ErrorCode.InternalError,
            `Pending review ${review.id} has no GraphQL node id`
          );
        }

        // Reply mode: a draft reply on an existing review-comment thread.
        if (options.in_reply_to !== undefined) {
          const threadMap = await this.fetchReviewThreadMap(
            ctx.owner,
            ctx.repo,
            pull_number
          );
          const entry = threadMap.get(options.in_reply_to);
          if (!entry) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `No review thread found containing comment ${options.in_reply_to} on PR #${pull_number}`
            );
          }
          const response: any = await this.octokit.graphql(
            ADD_REVIEW_THREAD_REPLY_MUTATION,
            {
              input: {
                pullRequestReviewId: review.node_id,
                pullRequestReviewThreadId: entry.threadId,
                body,
              },
            }
          );
          const comment = response?.addPullRequestReviewThreadReply?.comment;
          return this.json({
            mode: "reply",
            review_id: review.id,
            comment_id: comment?.databaseId,
            path: comment?.path,
            state: comment?.state,
            body: comment?.body,
          });
        }

        // Inline mode: a new draft thread on a diff line.
        if (options.path === undefined || options.line === undefined) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "addCommentToPendingReview requires path and line (new thread) or in_reply_to (reply)"
          );
        }
        const response: any = await this.octokit.graphql(
          ADD_REVIEW_THREAD_MUTATION,
          {
            input: {
              pullRequestReviewId: review.node_id,
              path: options.path,
              line: options.line,
              side: options.side ?? "RIGHT",
              ...(options.start_line !== undefined
                ? {
                    startLine: options.start_line,
                    startSide: options.start_side ?? options.side ?? "RIGHT",
                  }
                : {}),
              body,
            },
          }
        );
        const thread = response?.addPullRequestReviewThread?.thread;
        const comment = thread?.comments?.nodes?.[0];
        return this.json({
          mode: "inline",
          review_id: review.id,
          thread_id: thread?.id,
          comment_id: comment?.databaseId,
          path: thread?.path,
          line: thread?.line,
          start_line: thread?.startLine,
          state: comment?.state,
          body: comment?.body,
        });
      }
    );
  }

  async submitPullRequestReview(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
    body?: string,
    review_id?: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    body = applySignature(body);
    return this.guard(
      "submitPullRequestReview",
      { ...ctx, pull_number, event, review_id },
      async () => {
        const resolvedId =
          review_id ??
          (await this.requirePendingReview(ctx.owner, ctx.repo, pull_number))
            .id;
        const response = await this.octokit.rest.pulls.submitReview({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number,
          review_id: resolvedId,
          event,
          ...(body !== undefined ? { body } : {}),
        });
        return this.json({
          review_id: response.data.id,
          state: response.data.state,
          author: response.data.user?.login,
          submitted_at: response.data.submitted_at,
          html_url: response.data.html_url,
        });
      }
    );
  }

  async deletePendingReview(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    review_id?: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "deletePendingReview",
      { ...ctx, pull_number, review_id },
      async () => {
        const resolvedId =
          review_id ??
          (await this.requirePendingReview(ctx.owner, ctx.repo, pull_number))
            .id;
        try {
          const response = await this.octokit.rest.pulls.deletePendingReview({
            owner: ctx.owner,
            repo: ctx.repo,
            pull_number,
            review_id: resolvedId,
          });
          return this.json({
            deleted_review_id: resolvedId,
            state: response.data.state,
          });
        } catch (error) {
          if (isRequestError(error) && error.status === 422) {
            throw new McpError(
              ErrorCode.InvalidParams,
              formatGitHubError(
                error,
                `Review ${resolvedId} could not be deleted (only PENDING reviews can be deleted; submitted reviews cannot)`
              )
            );
          }
          throw error;
        }
      }
    );
  }

  async getPendingReviewPRs(
    owner?: string,
    reviewer?: string,
    repositoryList?: string[],
    limit?: number
  ) {
    // An explicit empty-string owner searches across all of GitHub.
    const scopeOwner =
      owner === "" ? undefined : owner || this.config.defaultOwner;
    const resolvedLimit =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : 50;
    return this.guard(
      "getPendingReviewPRs",
      { owner: scopeOwner, reviewer, repositoryList, limit: resolvedLimit },
      async () => {
        const q = buildPendingReviewQuery({
          reviewer,
          owner: scopeOwner,
          repositoryList,
        });
        const result = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            (
              await this.octokit.rest.search.issuesAndPullRequests({
                q,
                per_page: pp,
                page: p,
                sort: "updated",
                order: "desc",
                advanced_search: "true",
              } as any)
            ).data.items,
          {
            all: true,
            per_page: Math.min(resolvedLimit, GITHUB_MAX_PER_PAGE),
            maxItems: resolvedLimit,
            description: "getPendingReviewPRs",
          }
        );
        return this.json({
          pending_review_prs: result.values.map(summarizeSearchItem),
          total_found: result.totalFetched,
          query: q,
        });
      }
    );
  }

  async getPullRequestActivity(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    per_page?: number,
    page?: number,
    all?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestActivity",
      { ...ctx, pull_number, per_page, page, all },
      async () => {
        const result = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            (
              await this.octokit.rest.issues.listEventsForTimeline({
                owner: ctx.owner,
                repo: ctx.repo,
                issue_number: pull_number,
                per_page: pp,
                page: p,
              })
            ).data,
          { per_page, page, all, description: "getPullRequestActivity" }
        );

        const events = result.values.map((event: any) => ({
          event: event.event,
          actor: event.actor?.login ?? event.user?.login,
          created_at: event.created_at ?? event.submitted_at,
          state: event.state,
          label: event.label?.name,
          requested_reviewer: event.requested_reviewer?.login,
          sha: event.sha,
          body:
            typeof event.body === "string" && event.body.length > 500
              ? `${event.body.slice(0, 500)}…`
              : event.body,
        }));
        return this.json(events);
      }
    );
  }

  // =========== COMMENT METHODS ===========

  /** Fetch all review (inline) and issue (top-level) comments for a PR. */
  private async fetchAllPrComments(
    owner: string,
    repo: string,
    pull_number: number
  ): Promise<{
    issueComments: ThreadComment[];
    reviewComments: ThreadComment[];
    rawIssue: any[];
    rawReview: any[];
  }> {
    const review = await this.paginator.fetchValues<any>(
      async (p, pp) =>
        (
          await this.octokit.rest.pulls.listReviewComments({
            owner,
            repo,
            pull_number,
            per_page: pp,
            page: p,
          })
        ).data,
      { all: true, per_page: 100, description: "listReviewComments" }
    );
    const issue = await this.paginator.fetchValues<any>(
      async (p, pp) =>
        (
          await this.octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: pull_number,
            per_page: pp,
            page: p,
          })
        ).data,
      { all: true, per_page: 100, description: "listIssueComments" }
    );

    const toThreadComment = (comment: any): ThreadComment => ({
      id: comment.id,
      in_reply_to_id: comment.in_reply_to_id ?? null,
      user: { login: comment.user?.login ?? "unknown" },
      body: comment.body ?? "",
      created_at: comment.created_at,
      path: comment.path,
      line: comment.line ?? comment.original_line ?? null,
      start_line: comment.start_line ?? comment.original_start_line ?? null,
    });

    return {
      issueComments: issue.values.map(toThreadComment),
      reviewComments: review.values.map(toThreadComment),
      rawIssue: issue.values,
      rawReview: review.values,
    };
  }

  /**
   * Map review-comment database ids to their GraphQL review thread id and
   * resolution state. Thread resolution only exists in the GraphQL API.
   */
  private async fetchReviewThreadMap(
    owner: string,
    repo: string,
    pull_number: number
  ): Promise<Map<number, { threadId: string; isResolved: boolean }>> {
    const map = new Map<number, { threadId: string; isResolved: boolean }>();
    let cursor: string | null = null;
    for (;;) {
      const response: any = await this.octokit.graphql(REVIEW_THREADS_QUERY, {
        owner,
        repo,
        number: pull_number,
        cursor,
      });
      const threads = response?.repository?.pullRequest?.reviewThreads;
      if (!threads) break;
      for (const node of threads.nodes ?? []) {
        for (const comment of node.comments?.nodes ?? []) {
          if (typeof comment?.databaseId === "number") {
            map.set(comment.databaseId, {
              threadId: node.id,
              isResolved: node.isResolved === true,
            });
          }
        }
      }
      if (!threads.pageInfo?.hasNextPage) break;
      cursor = threads.pageInfo.endCursor;
    }
    return map;
  }

  async getPullRequestComments(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestComments",
      { ...ctx, pull_number },
      async () => {
        const { reviewComments, rawIssue, rawReview } =
          await this.fetchAllPrComments(ctx.owner, ctx.repo, pull_number);

        let resolution = new Map<
          number,
          { threadId: string; isResolved: boolean }
        >();
        try {
          resolution = await this.fetchReviewThreadMap(
            ctx.owner,
            ctx.repo,
            pull_number
          );
        } catch (error) {
          logger.warn("Could not fetch review thread resolution state", {
            error,
          });
        }

        const rawById = new Map(rawReview.map((c: any) => [c.id, c]));
        const threads = buildReviewThreads(reviewComments).map((thread) => ({
          thread_id: thread.thread_id,
          location: thread.location,
          is_resolved: resolution.get(thread.thread_id)?.isResolved,
          comments: thread.comments.map((c) =>
            summarizeComment(rawById.get(c.id) ?? c)
          ),
        }));

        return this.json({
          issue_comments: rawIssue.map(summarizeComment),
          review_threads: threads,
          counts: {
            issue_comments: rawIssue.length,
            review_comments: rawReview.length,
            review_threads: threads.length,
          },
        });
      }
    );
  }

  async getPullRequestComment(
    owner: string | undefined,
    repo: string | undefined,
    comment_id: number,
    comment_type?: "review" | "issue"
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestComment",
      { ...ctx, comment_id, comment_type },
      async () => {
        if (comment_type !== "issue") {
          try {
            const response = await this.octokit.rest.pulls.getReviewComment({
              owner: ctx.owner,
              repo: ctx.repo,
              comment_id,
            });
            return this.json({
              comment_type: "review",
              ...summarizeComment(response.data),
            });
          } catch (error) {
            const canFallBack =
              comment_type === undefined &&
              isRequestError(error) &&
              error.status === 404;
            if (!canFallBack) throw error;
          }
        }
        const response = await this.octokit.rest.issues.getComment({
          owner: ctx.owner,
          repo: ctx.repo,
          comment_id,
        });
        return this.json({
          comment_type: "issue",
          ...summarizeComment(response.data),
        });
      }
    );
  }

  async addPullRequestComment(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    body: string,
    options: {
      path?: string;
      line?: number;
      side?: "LEFT" | "RIGHT";
      start_line?: number;
      start_side?: "LEFT" | "RIGHT";
      in_reply_to?: number;
      commit_id?: string;
    } = {}
  ) {
    const ctx = this.resolveContext(owner, repo);
    // Sign once, before mode dispatch, so every mode posts the signed body.
    body = applySignature(body);
    return this.guard(
      "addPullRequestComment",
      { ...ctx, pull_number, ...options },
      async () => {
        const plan = planCommentMode(options);
        if ("error" in plan) {
          throw new McpError(ErrorCode.InvalidParams, plan.error);
        }

        // Reply mode: continue an existing review-comment thread.
        if (plan.mode === "reply") {
          const response =
            await this.octokit.rest.pulls.createReplyForReviewComment({
              owner: ctx.owner,
              repo: ctx.repo,
              pull_number,
              comment_id: plan.in_reply_to,
              body,
            });
          return this.json({
            mode: "reply",
            ...summarizeComment(response.data),
          });
        }

        // Inline mode: comment on a diff line.
        if (plan.mode === "inline") {
          let commitId = options.commit_id;
          if (!commitId) {
            const pr = await this.octokit.rest.pulls.get({
              owner: ctx.owner,
              repo: ctx.repo,
              pull_number,
            });
            commitId = pr.data.head.sha;
          }
          const response = await this.octokit.rest.pulls.createReviewComment({
            owner: ctx.owner,
            repo: ctx.repo,
            pull_number,
            body,
            commit_id: commitId,
            path: plan.path,
            line: plan.line,
            side: plan.side,
            ...(plan.start_line !== undefined
              ? {
                  start_line: plan.start_line,
                  start_side: plan.start_side,
                }
              : {}),
          });
          return this.json({
            mode: "inline",
            ...summarizeComment(response.data),
          });
        }

        // Top-level mode: PR conversation comment.
        const response = await this.octokit.rest.issues.createComment({
          owner: ctx.owner,
          repo: ctx.repo,
          issue_number: pull_number,
          body,
        });
        return this.json({
          mode: "top-level",
          ...summarizeComment(response.data),
        });
      }
    );
  }

  async updatePullRequestComment(
    owner: string | undefined,
    repo: string | undefined,
    comment_id: number,
    body: string,
    comment_type?: "review" | "issue"
  ) {
    const ctx = this.resolveContext(owner, repo);
    // Sign once, before mode dispatch, so both review and issue edits post the
    // signed body — matching the create/reply paths.
    body = applySignature(body);
    return this.guard(
      "updatePullRequestComment",
      { ...ctx, comment_id, comment_type },
      async () => {
        if (comment_type !== "issue") {
          try {
            const response = await this.octokit.rest.pulls.updateReviewComment(
              {
                owner: ctx.owner,
                repo: ctx.repo,
                comment_id,
                body,
              }
            );
            return this.json({
              comment_type: "review",
              ...summarizeComment(response.data),
            });
          } catch (error) {
            const canFallBack =
              comment_type === undefined &&
              isRequestError(error) &&
              error.status === 404;
            if (!canFallBack) throw error;
          }
        }
        const response = await this.octokit.rest.issues.updateComment({
          owner: ctx.owner,
          repo: ctx.repo,
          comment_id,
          body,
        });
        return this.json({
          comment_type: "issue",
          ...summarizeComment(response.data),
        });
      }
    );
  }

  async deletePullRequestComment(
    owner: string | undefined,
    repo: string | undefined,
    comment_id: number,
    comment_type?: "review" | "issue"
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "deletePullRequestComment",
      { ...ctx, comment_id, comment_type },
      async () => {
        if (comment_type !== "issue") {
          try {
            await this.octokit.rest.pulls.deleteReviewComment({
              owner: ctx.owner,
              repo: ctx.repo,
              comment_id,
            });
            return this.json({
              deleted: true,
              comment_id,
              comment_type: "review",
            });
          } catch (error) {
            const canFallBack =
              comment_type === undefined &&
              isRequestError(error) &&
              error.status === 404;
            if (!canFallBack) throw error;
          }
        }
        await this.octokit.rest.issues.deleteComment({
          owner: ctx.owner,
          repo: ctx.repo,
          comment_id,
        });
        return this.json({ deleted: true, comment_id, comment_type: "issue" });
      }
    );
  }

  async setCommentResolved(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    comment_id: number,
    resolved: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      resolved ? "resolveComment" : "reopenComment",
      { ...ctx, pull_number, comment_id },
      async () => {
        const map = await this.fetchReviewThreadMap(
          ctx.owner,
          ctx.repo,
          pull_number
        );
        const entry = map.get(comment_id);
        if (!entry) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No review thread found containing comment ${comment_id} on PR #${pull_number}`
          );
        }
        const mutation = resolved
          ? RESOLVE_THREAD_MUTATION
          : UNRESOLVE_THREAD_MUTATION;
        const response: any = await this.octokit.graphql(mutation, {
          threadId: entry.threadId,
        });
        const thread = resolved
          ? response?.resolveReviewThread?.thread
          : response?.unresolveReviewThread?.thread;
        return this.json({
          comment_id,
          thread_id: entry.threadId,
          is_resolved: thread?.isResolved ?? resolved,
        });
      }
    );
  }

  /**
   * Resolve a numeric comment id to its GraphQL node id. Tries the PR review
   * comment endpoint first, falling back to the issue/conversation comment
   * endpoint, unless comment_type narrows the lookup.
   */
  private async resolveCommentNodeId(
    owner: string,
    repo: string,
    comment_id: number,
    comment_type?: "review" | "issue"
  ): Promise<string> {
    if (comment_type !== "issue") {
      try {
        const response = await this.octokit.rest.pulls.getReviewComment({
          owner,
          repo,
          comment_id,
        });
        return response.data.node_id;
      } catch (error) {
        const canFallBack =
          comment_type === undefined &&
          isRequestError(error) &&
          error.status === 404;
        if (!canFallBack) throw error;
      }
    }
    const response = await this.octokit.rest.issues.getComment({
      owner,
      repo,
      comment_id,
    });
    return response.data.node_id;
  }

  async minimizePullRequestComment(
    owner: string | undefined,
    repo: string | undefined,
    comment_id: number | undefined,
    reason?: string,
    comment_type?: "review" | "issue",
    node_id?: string
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "minimizePullRequestComment",
      { ...ctx, comment_id, reason, comment_type, node_id },
      async () => {
        const classifier = (reason ?? "OUTDATED").trim().toUpperCase();
        if (!(MINIMIZE_REASONS as readonly string[]).includes(classifier)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid reason '${reason}'. Expected one of: ${MINIMIZE_REASONS.join(
              ", "
            )}`
          );
        }
        const subjectId = await this.resolveSubjectId(
          ctx.owner,
          ctx.repo,
          comment_id,
          comment_type,
          node_id
        );
        const response: any = await this.octokit.graphql(
          MINIMIZE_COMMENT_MUTATION,
          { subjectId, classifier }
        );
        const minimized = response?.minimizeComment?.minimizedComment;
        return this.json({
          comment_id,
          isMinimized: minimized?.isMinimized ?? true,
          minimizedReason: minimized?.minimizedReason ?? classifier.toLowerCase(),
        });
      }
    );
  }

  async unminimizePullRequestComment(
    owner: string | undefined,
    repo: string | undefined,
    comment_id: number | undefined,
    comment_type?: "review" | "issue",
    node_id?: string
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "unminimizePullRequestComment",
      { ...ctx, comment_id, comment_type, node_id },
      async () => {
        const subjectId = await this.resolveSubjectId(
          ctx.owner,
          ctx.repo,
          comment_id,
          comment_type,
          node_id
        );
        const response: any = await this.octokit.graphql(
          UNMINIMIZE_COMMENT_MUTATION,
          { subjectId }
        );
        const unminimized = response?.unminimizeComment?.unminimizedComment;
        return this.json({
          comment_id,
          isMinimized: unminimized?.isMinimized ?? false,
        });
      }
    );
  }

  /** Pick a GraphQL subject id from an explicit node id or a numeric comment id. */
  private async resolveSubjectId(
    owner: string,
    repo: string,
    comment_id: number | undefined,
    comment_type?: "review" | "issue",
    node_id?: string
  ): Promise<string> {
    if (node_id && node_id.trim().length > 0) return node_id.trim();
    if (typeof comment_id !== "number") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Either comment_id (numeric) or node_id must be provided"
      );
    }
    return this.resolveCommentNodeId(owner, repo, comment_id, comment_type);
  }

  async checkPrReplies(
    owner: string | undefined,
    repo: string | undefined,
    pull_numbers: number[],
    self?: string,
    all?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "checkPrReplies",
      { ...ctx, pull_numbers, self, all },
      async () => {
        const selfLogin =
          self && self.trim().length > 0
            ? self.trim().replace(/^@/, "")
            : await this.getAuthenticatedLogin();

        const results: Record<string, unknown> = {};

        for (const prNumber of pull_numbers) {
          const { issueComments, reviewComments } =
            await this.fetchAllPrComments(ctx.owner, ctx.repo, prNumber);

          const reviewThreads = buildReviewThreads(reviewComments);
          const discussion = buildDiscussionThread(issueComments);
          const allThreads = discussion
            ? [...reviewThreads, discussion]
            : reviewThreads;

          if (all) {
            const activeThreads = allThreads
              .filter((thread) => thread.comments.length >= 2)
              .map((thread) => {
                const root = thread.comments[0];
                return {
                  thread_id: thread.thread_id,
                  kind: thread.kind,
                  location: thread.location,
                  root_comment: {
                    author: root.user.login,
                    content: root.body,
                    created_at: root.created_at,
                  },
                  replies: thread.comments.slice(1).map((c) => ({
                    id: c.id,
                    author: c.user.login,
                    content: c.body,
                    created_at: c.created_at,
                  })),
                  total_comments: thread.comments.length,
                };
              });

            results[prNumber] = {
              mode: "all",
              total_threads: allThreads.length,
              active_threads: activeThreads.length,
              threads: activeThreads,
            };
          } else {
            const summary = findThreadsWithNewReplies(allThreads, selfLogin);
            results[prNumber] = {
              mode: "self",
              self: selfLogin,
              total_threads: allThreads.length,
              ...summary,
            };
          }
        }

        return this.json(results);
      }
    );
  }

  // =========== TASK METHODS (markdown checklist emulation) ===========

  private async findTasksComment(
    owner: string,
    repo: string,
    pull_number: number
  ): Promise<{ id: number; body: string } | undefined> {
    const result = await this.paginator.fetchValues<any>(
      async (p, pp) =>
        (
          await this.octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: pull_number,
            per_page: pp,
            page: p,
          })
        ).data,
      { all: true, per_page: 100, description: "findTasksComment" }
    );
    const comment = result.values.find((c: any) => isTasksComment(c.body));
    return comment ? { id: comment.id, body: comment.body ?? "" } : undefined;
  }

  private async saveTasks(
    owner: string,
    repo: string,
    pull_number: number,
    existingCommentId: number | undefined,
    tasks: ReturnType<typeof parseTasks>
  ): Promise<number> {
    const body = serializeTasks(tasks);
    if (existingCommentId !== undefined) {
      const response = await this.octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingCommentId,
        body,
      });
      return response.data.id;
    }
    const response = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pull_number,
      body,
    });
    return response.data.id;
  }

  async getPullRequestTasks(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestTasks",
      { ...ctx, pull_number },
      async () => {
        const existing = await this.findTasksComment(
          ctx.owner,
          ctx.repo,
          pull_number
        );
        const tasks = existing ? parseTasks(existing.body) : [];
        return this.json({
          tasks,
          tasks_comment_id: existing?.id ?? null,
        });
      }
    );
  }

  async createPullRequestTask(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    content: string,
    state?: TaskState
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "createPullRequestTask",
      { ...ctx, pull_number, content, state },
      async () => {
        const existing = await this.findTasksComment(
          ctx.owner,
          ctx.repo,
          pull_number
        );
        const tasks = existing ? parseTasks(existing.body) : [];
        const updated = addTask(tasks, content, state ?? "OPEN");
        const commentId = await this.saveTasks(
          ctx.owner,
          ctx.repo,
          pull_number,
          existing?.id,
          updated
        );
        return this.json({
          task: updated[updated.length - 1],
          tasks_comment_id: commentId,
        });
      }
    );
  }

  async getPullRequestTask(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    task_id: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestTask",
      { ...ctx, pull_number, task_id },
      async () => {
        const existing = await this.findTasksComment(
          ctx.owner,
          ctx.repo,
          pull_number
        );
        const tasks = existing ? parseTasks(existing.body) : [];
        const task = tasks.find((t) => t.id === task_id);
        if (!task) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Task ${task_id} not found on PR #${pull_number}`
          );
        }
        return this.json({ task, tasks_comment_id: existing?.id ?? null });
      }
    );
  }

  async updatePullRequestTask(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    task_id: number,
    content?: string,
    state?: TaskState
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "updatePullRequestTask",
      { ...ctx, pull_number, task_id, content, state },
      async () => {
        const existing = await this.findTasksComment(
          ctx.owner,
          ctx.repo,
          pull_number
        );
        if (!existing) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No tasks comment found on PR #${pull_number}`
          );
        }
        const updated = updateTask(parseTasks(existing.body), task_id, {
          content,
          state,
        });
        if (!updated) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Task ${task_id} not found on PR #${pull_number}`
          );
        }
        await this.saveTasks(
          ctx.owner,
          ctx.repo,
          pull_number,
          existing.id,
          updated
        );
        return this.json({
          task: updated.find((t) => t.id === task_id),
          tasks_comment_id: existing.id,
        });
      }
    );
  }

  async deletePullRequestTask(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    task_id: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "deletePullRequestTask",
      { ...ctx, pull_number, task_id },
      async () => {
        const existing = await this.findTasksComment(
          ctx.owner,
          ctx.repo,
          pull_number
        );
        if (!existing) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No tasks comment found on PR #${pull_number}`
          );
        }
        const updated = deleteTask(parseTasks(existing.body), task_id);
        if (!updated) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Task ${task_id} not found on PR #${pull_number}`
          );
        }
        await this.saveTasks(
          ctx.owner,
          ctx.repo,
          pull_number,
          existing.id,
          updated
        );
        return this.json({
          deleted: true,
          task_id,
          remaining_tasks: updated,
          tasks_comment_id: existing.id,
        });
      }
    );
  }

  // =========== DIFF METHODS ===========

  private async fetchPullRequestRaw(
    owner: string,
    repo: string,
    pull_number: number,
    format: "diff" | "patch"
  ): Promise<string> {
    const response = await this.octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number,
        mediaType: { format },
      }
    );
    return typeof response.data === "string"
      ? response.data
      : String(response.data ?? "");
  }

  async getPullRequestDiff(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestDiff",
      { ...ctx, pull_number },
      async () => {
        const diff = await this.fetchPullRequestRaw(
          ctx.owner,
          ctx.repo,
          pull_number,
          "diff"
        );
        return this.text(diff);
      }
    );
  }

  async getPullRequestPatch(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestPatch",
      { ...ctx, pull_number },
      async () => {
        const patch = await this.fetchPullRequestRaw(
          ctx.owner,
          ctx.repo,
          pull_number,
          "patch"
        );
        return this.text(patch);
      }
    );
  }

  async getPullRequestDiffStat(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    per_page?: number,
    page?: number,
    all?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestDiffStat",
      { ...ctx, pull_number, per_page, page, all },
      async () => {
        const result = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            (
              await this.octokit.rest.pulls.listFiles({
                owner: ctx.owner,
                repo: ctx.repo,
                pull_number,
                per_page: pp,
                page: p,
              })
            ).data,
          { per_page, page, all, description: "getPullRequestDiffStat" }
        );
        return this.json(
          result.values.map((file: any) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            previous_filename: file.previous_filename,
          }))
        );
      }
    );
  }

  async getPullRequestDiffChunks(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    pathFilter?: string
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestDiffChunks",
      { ...ctx, pull_number, pathFilter },
      async () => {
        const diff = await this.fetchPullRequestRaw(
          ctx.owner,
          ctx.repo,
          pull_number,
          "diff"
        );
        let chunks = parseDiffChunks(diff);
        if (pathFilter) {
          chunks = filterChunksByPath(chunks, pathFilter);
        }
        return this.json(chunks);
      }
    );
  }

  async getPullRequestCommits(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number,
    per_page?: number,
    page?: number,
    all?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestCommits",
      { ...ctx, pull_number, per_page, page, all },
      async () => {
        const result = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            (
              await this.octokit.rest.pulls.listCommits({
                owner: ctx.owner,
                repo: ctx.repo,
                pull_number,
                per_page: pp,
                page: p,
              })
            ).data,
          { per_page, page, all, description: "getPullRequestCommits" }
        );
        return this.json(
          result.values.map((commit: any) => ({
            sha: commit.sha,
            author: commit.author?.login ?? commit.commit?.author?.name,
            date: commit.commit?.author?.date,
            message: commit.commit?.message,
            html_url: commit.html_url,
          }))
        );
      }
    );
  }

  // =========== STATUS METHODS ===========

  async getPullRequestStatuses(
    owner: string | undefined,
    repo: string | undefined,
    pull_number: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getPullRequestStatuses",
      { ...ctx, pull_number },
      async () => {
        const pr = await this.octokit.rest.pulls.get({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number,
        });
        const sha = pr.data.head.sha;

        const combined = await this.octokit.rest.repos.getCombinedStatusForRef(
          {
            owner: ctx.owner,
            repo: ctx.repo,
            ref: sha,
          }
        );
        const checks = await this.octokit.rest.checks.listForRef({
          owner: ctx.owner,
          repo: ctx.repo,
          ref: sha,
          per_page: 100,
        });

        return this.json({
          head_sha: sha,
          combined_status: {
            state: combined.data.state,
            total_count: combined.data.total_count,
            statuses: combined.data.statuses.map((status: any) => ({
              context: status.context,
              state: status.state,
              description: status.description,
              target_url: status.target_url,
              updated_at: status.updated_at,
            })),
          },
          check_runs: checks.data.check_runs.map((check: any) => ({
            id: check.id,
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            started_at: check.started_at,
            completed_at: check.completed_at,
            app: check.app?.slug,
            html_url: check.html_url,
          })),
        });
      }
    );
  }

  // =========== GITHUB ACTIONS METHODS ===========

  async listWorkflows(
    owner?: string,
    repo?: string,
    per_page?: number,
    page?: number,
    all?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "listWorkflows",
      { ...ctx, per_page, page, all },
      async () => {
        const result = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            (
              await this.octokit.rest.actions.listRepoWorkflows({
                owner: ctx.owner,
                repo: ctx.repo,
                per_page: pp,
                page: p,
              })
            ).data.workflows,
          { per_page, page, all, description: "listWorkflows" }
        );
        return this.json(
          result.values.map((workflow: any) => ({
            id: workflow.id,
            name: workflow.name,
            path: workflow.path,
            state: workflow.state,
            html_url: workflow.html_url,
          }))
        );
      }
    );
  }

  async listWorkflowRuns(
    owner?: string,
    repo?: string,
    workflow_id?: string,
    branch?: string,
    status?: string,
    event?: string,
    actor?: string,
    per_page?: number,
    page?: number,
    all?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "listWorkflowRuns",
      { ...ctx, workflow_id, branch, status, event, actor, per_page, page, all },
      async () => {
        const filters: Record<string, unknown> = {};
        if (branch) filters.branch = branch;
        if (status) filters.status = status;
        if (event) filters.event = event;
        if (actor) filters.actor = actor;

        const result = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            workflow_id
              ? (
                  await this.octokit.rest.actions.listWorkflowRuns({
                    owner: ctx.owner,
                    repo: ctx.repo,
                    workflow_id,
                    per_page: pp,
                    page: p,
                    ...filters,
                  } as any)
                ).data.workflow_runs
              : (
                  await this.octokit.rest.actions.listWorkflowRunsForRepo({
                    owner: ctx.owner,
                    repo: ctx.repo,
                    per_page: pp,
                    page: p,
                    ...filters,
                  } as any)
                ).data.workflow_runs,
          { per_page, page, all, description: "listWorkflowRuns" }
        );
        return this.json(result.values.map(summarizeWorkflowRun));
      }
    );
  }

  async getWorkflowRun(
    owner: string | undefined,
    repo: string | undefined,
    run_id: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard("getWorkflowRun", { ...ctx, run_id }, async () => {
      const response = await this.octokit.rest.actions.getWorkflowRun({
        owner: ctx.owner,
        repo: ctx.repo,
        run_id,
      });
      const run = response.data;
      return this.json({
        ...summarizeWorkflowRun(run),
        run_attempt: run.run_attempt,
        run_started_at: run.run_started_at,
        display_title: run.display_title,
        triggering_actor: run.triggering_actor?.login,
      });
    });
  }

  async listWorkflowJobs(
    owner: string | undefined,
    repo: string | undefined,
    run_id: number,
    filter?: "latest" | "all",
    per_page?: number,
    page?: number,
    all?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "listWorkflowJobs",
      { ...ctx, run_id, filter, per_page, page, all },
      async () => {
        const result = await this.paginator.fetchValues<any>(
          async (p, pp) =>
            (
              await this.octokit.rest.actions.listJobsForWorkflowRun({
                owner: ctx.owner,
                repo: ctx.repo,
                run_id,
                filter: filter ?? "latest",
                per_page: pp,
                page: p,
              })
            ).data.jobs,
          { per_page, page, all, description: "listWorkflowJobs" }
        );
        return this.json(result.values.map(summarizeJob));
      }
    );
  }

  async getWorkflowJob(
    owner: string | undefined,
    repo: string | undefined,
    job_id: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard("getWorkflowJob", { ...ctx, job_id }, async () => {
      const response = await this.octokit.rest.actions.getJobForWorkflowRun({
        owner: ctx.owner,
        repo: ctx.repo,
        job_id,
      });
      return this.json(summarizeJob(response.data));
    });
  }

  async getWorkflowJobLogs(
    owner: string | undefined,
    repo: string | undefined,
    job_id: number,
    maxLines?: number,
    tail?: boolean,
    errorsOnly?: boolean,
    searchTerm?: string,
    saveToFile?: boolean
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "getWorkflowJobLogs",
      { ...ctx, job_id, maxLines, tail, errorsOnly, searchTerm, saveToFile },
      async () => {
        // The logs endpoint replies with a redirect to short-lived blob
        // storage; Octokit follows it and yields the plain-text body.
        const response =
          await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({
            owner: ctx.owner,
            repo: ctx.repo,
            job_id,
          });
        const data: unknown = response.data;
        const rawLog =
          typeof data === "string"
            ? data
            : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : data === undefined || data === null
            ? ""
            : String(data);

        const filtered = filterLogLines(rawLog, {
          maxLines,
          tail,
          errorsOnly,
          searchTerm,
        });

        const summaryParts: string[] = [filtered.summary];

        if (saveToFile) {
          try {
            const tempDir = fs.mkdtempSync(
              path.join(os.tmpdir(), "github-mcp-")
            );
            const safeFileName = `job-${job_id}.log`.replace(
              /[^a-zA-Z0-9._-]/g,
              "_"
            );
            const filePath = path.join(tempDir, safeFileName);
            fs.writeFileSync(filePath, rawLog, "utf8");
            summaryParts.push(`Full log saved to: ${filePath}`);
          } catch (fileError) {
            logger.warn("Failed to save job log to file", {
              error: fileError,
            });
            summaryParts.push(
              "Attempted to save the full log to a temporary file, but writing failed."
            );
          }
        }

        if (!saveToFile && filtered.wasTruncated) {
          summaryParts.push(
            "Use max_lines, tail, search_term, or save_to_file to refine or download the full log."
          );
        }

        const summary = summaryParts.join(" ");
        const textContent =
          filtered.lines.length > 0
            ? `${summary}\n\n${filtered.lines.join("\n")}`
            : summary;
        return this.text(textContent);
      }
    );
  }

  async runWorkflow(
    owner: string | undefined,
    repo: string | undefined,
    workflow_id: string,
    ref: string,
    inputs?: Record<string, unknown>
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard(
      "runWorkflow",
      { ...ctx, workflow_id, ref, inputs },
      async () => {
        await this.octokit.rest.actions.createWorkflowDispatch({
          owner: ctx.owner,
          repo: ctx.repo,
          workflow_id,
          ref,
          ...(inputs ? { inputs: inputs as Record<string, any> } : {}),
        });
        return this.json({
          dispatched: true,
          workflow_id,
          ref,
          note: "GitHub does not return the run id for workflow_dispatch; use listWorkflowRuns with event=workflow_dispatch to find the new run.",
        });
      }
    );
  }

  async cancelWorkflowRun(
    owner: string | undefined,
    repo: string | undefined,
    run_id: number
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard("cancelWorkflowRun", { ...ctx, run_id }, async () => {
      await this.octokit.rest.actions.cancelWorkflowRun({
        owner: ctx.owner,
        repo: ctx.repo,
        run_id,
      });
      return this.json({ cancelled: true, run_id });
    });
  }

  // =========== BRANCH PROTECTION / REVIEWER METHODS ===========

  async getBranchProtection(
    owner?: string,
    repo?: string,
    branch?: string
  ) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard("getBranchProtection", { ...ctx, branch }, async () => {
      let branchName = branch;
      if (!branchName) {
        const repoInfo = await this.octokit.rest.repos.get({
          owner: ctx.owner,
          repo: ctx.repo,
        });
        branchName = repoInfo.data.default_branch;
      }
      try {
        const response = await this.octokit.rest.repos.getBranchProtection({
          owner: ctx.owner,
          repo: ctx.repo,
          branch: branchName,
        });
        return this.json({
          branch: branchName,
          protected: true,
          protection: response.data,
        });
      } catch (error) {
        if (isRequestError(error) && error.status === 404) {
          return this.json({
            branch: branchName,
            protected: false,
            message:
              "Branch protection is not enabled for this branch (or the token lacks access).",
          });
        }
        throw error;
      }
    });
  }

  async getCodeowners(owner?: string, repo?: string, ref?: string) {
    const ctx = this.resolveContext(owner, repo);
    return this.guard("getCodeowners", { ...ctx, ref }, async () => {
      for (const location of CODEOWNERS_LOCATIONS) {
        try {
          const response = await this.octokit.rest.repos.getContent({
            owner: ctx.owner,
            repo: ctx.repo,
            path: location,
            ...(ref ? { ref } : {}),
          });
          const data: any = response.data;
          if (data && typeof data.content === "string") {
            const content = Buffer.from(data.content, "base64").toString(
              "utf8"
            );
            return this.json({
              path: location,
              rules: parseCodeowners(content),
            });
          }
        } catch (error) {
          if (isRequestError(error) && error.status === 404) continue;
          throw error;
        }
      }
      return this.json({
        path: null,
        rules: [],
        message:
          "No CODEOWNERS file found in .github/, the repository root, or docs/.",
      });
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info("GitHub MCP server running on stdio");
  }
}

// Create and start the server
const server = new GitHubServer();
server.run().catch((error) => {
  logger.error("Server error", error);
  process.exit(1);
});
