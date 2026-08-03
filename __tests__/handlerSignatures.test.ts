/**
 * Handler-level signature wiring tests.
 *
 * Every tool that posts user-visible prose to GitHub must run it through
 * applySignature. These tests call the real handler methods on a
 * GitHubServer instance with the Octokit endpoints stubbed, and assert on
 * the body/message each stub receives.
 */
import { jest } from "@jest/globals";

const SIG = "— 🤖 Example MCP Bot";

// Must be set before importing src/index.ts: the module resolves its config
// (token) at construction and reads the signature from process.env at each
// call site. loadDotEnv never overrides variables that are already set.
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "test-token";
process.env.GITHUB_COMMENT_SIGNATURE = SIG;

let GitHubServer: any;

beforeAll(async () => {
  ({ GitHubServer } = await import("../src/index.js"));
});

/** A server whose auth lookup is stubbed; no network is ever touched. */
function makeServer(): any {
  const server: any = new GitHubServer();
  server.getAuthenticatedLogin = async () => "test-user";
  return server;
}

function okReview(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 1,
      state: "APPROVED",
      user: { login: "test-user" },
      submitted_at: "2026-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

describe("approvePullRequest signature", () => {
  it("signs the approval body", async () => {
    const server = makeServer();
    server.listAllReviews = async () => [];
    const createReview = jest.fn(async (_params: any) => okReview());
    server.octokit.rest.pulls.createReview = createReview;

    await server.approvePullRequest("o", "r", 7, "LGTM");

    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({ body: `LGTM\n\n${SIG}` })
    );
  });

  it("posts no body at all when none is given (never a bare signature)", async () => {
    const server = makeServer();
    server.listAllReviews = async () => [];
    const createReview = jest.fn(async (_params: any) => okReview());
    server.octokit.rest.pulls.createReview = createReview;

    await server.approvePullRequest("o", "r", 7, undefined);

    expect(createReview).toHaveBeenCalledTimes(1);
    expect((createReview.mock.calls[0] as any[])[0]).not.toHaveProperty(
      "body"
    );
  });

  it("signs the body when submitting an existing empty pending review", async () => {
    const server = makeServer();
    server.listAllReviews = async () => [
      { id: 9, node_id: "N9", state: "PENDING", user: { login: "test-user" } },
    ];
    server.octokit.rest.pulls.listCommentsForReview = jest.fn(
      async (_params: any) => ({ data: [] })
    );
    const submitReview = jest.fn(async (_params: any) => okReview({ id: 9 }));
    server.octokit.rest.pulls.submitReview = submitReview;

    await server.approvePullRequest("o", "r", 7, "Ship it");

    expect(submitReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "APPROVE", body: `Ship it\n\n${SIG}` })
    );
  });
});

describe("closePullRequest signature", () => {
  function makeCloseServer() {
    const server = makeServer();
    const createComment = jest.fn(async (_params: any) => ({
      data: { id: 2 },
    }));
    server.octokit.rest.issues.createComment = createComment;
    server.octokit.rest.pulls.update = jest.fn(async (_params: any) => ({
      data: { number: 7, state: "closed" },
    }));
    return { server, createComment };
  }

  it("signs the close comment", async () => {
    const { server, createComment } = makeCloseServer();

    await server.closePullRequest("o", "r", 7, "Superseded by #8");

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: `Superseded by #8\n\n${SIG}` })
    );
  });

  it("posts no comment for a whitespace-only message", async () => {
    const { server, createComment } = makeCloseServer();

    await server.closePullRequest("o", "r", 7, "   ");

    expect(createComment).not.toHaveBeenCalled();
  });
});

describe("unapprovePullRequest signature", () => {
  function makeDismissServer() {
    const server = makeServer();
    server.listAllReviews = async () => [
      { id: 5, state: "APPROVED", user: { login: "test-user" } },
    ];
    const dismissReview = jest.fn(async (_params: any) => ({
      data: { state: "DISMISSED" },
    }));
    server.octokit.rest.pulls.dismissReview = dismissReview;
    return { server, dismissReview };
  }

  it("signs the dismissal message", async () => {
    const { server, dismissReview } = makeDismissServer();

    await server.unapprovePullRequest("o", "r", 7, "Changes needed after all");

    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `Changes needed after all\n\n${SIG}`,
      })
    );
  });

  it("signs the default dismissal message too", async () => {
    const { server, dismissReview } = makeDismissServer();

    await server.unapprovePullRequest("o", "r", 7, undefined);

    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ message: `Approval withdrawn\n\n${SIG}` })
    );
  });
});

describe("already-signed tools stay signed (regression anchors)", () => {
  it("addIssueComment signs the body", async () => {
    const server = makeServer();
    const createComment = jest.fn(async (_params: any) => ({
      data: { id: 3 },
    }));
    server.octokit.rest.issues.createComment = createComment;

    await server.addIssueComment("o", "r", 1, "Hello");

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: `Hello\n\n${SIG}` })
    );
  });

  it("submitPullRequestReview signs the body", async () => {
    const server = makeServer();
    const submitReview = jest.fn(async (_params: any) => okReview());
    server.octokit.rest.pulls.submitReview = submitReview;

    await server.submitPullRequestReview("o", "r", 7, "COMMENT", "Done", 4);

    expect(submitReview).toHaveBeenCalledWith(
      expect.objectContaining({ body: `Done\n\n${SIG}` })
    );
  });
});
