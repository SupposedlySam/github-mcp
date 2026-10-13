/**
 * End-to-end: tools/call through the real MCP request handler, over an
 * in-memory transport, with Octokit stubbed so no network is touched.
 */
import { jest } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "test-token";

let GitHubServer: any;

beforeAll(async () => {
  ({ GitHubServer } = await import("../src/index.js"));
});

const BAD_CALL = {
  owner: "example-org",
  repo: "example",
  pullNumber: "2491",
  event: "APPROVE",
};

const GOOD_CALLS: Record<string, Record<string, unknown>> = {
  createPullRequestReview: {
    owner: "example-org",
    repo: "example",
    pull_number: 2491,
    event: "APPROVE",
  },
  approvePullRequest: { owner: "example-org", repo: "example", pull_number: 2491 },
};

async function connect() {
  const server: any = new GitHubServer();
  server.getAuthenticatedLogin = async () => "test-user";
  server.listAllReviews = async () => [];
  const createReview = jest.fn(async (_params: any) => ({
    data: {
      id: 1,
      state: "APPROVED",
      user: { login: "test-user" },
      submitted_at: "2026-01-01T00:00:00Z",
    },
  }));
  server.octokit.rest.pulls.createReview = createReview;

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, createReview };
}

describe.each(["createPullRequestReview", "approvePullRequest"])(
  "%s argument validation",
  (toolName) => {
    it("rejects pullNumber before calling GitHub, naming pull_number", async () => {
      // The call as an agent sent it on 2026-10-13, which 404'd.
      const { client, createReview } = await connect();

      await expect(
        client.callTool({ name: toolName, arguments: BAD_CALL })
      ).rejects.toThrow(
        `Invalid arguments for ${toolName}: unknown parameter \`pullNumber\`; did you mean \`pull_number\`?`
      );
      expect(createReview).not.toHaveBeenCalled();
      await client.close();
    });

    it("passes a correct call through to GitHub with the PR number", async () => {
      const { client, createReview } = await connect();

      const result: any = await client.callTool({
        name: toolName,
        arguments: GOOD_CALLS[toolName],
      });

      expect(result.isError).toBeFalsy();
      expect(createReview).toHaveBeenCalledTimes(1);
      expect(createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "example-org",
          repo: "example",
          pull_number: 2491,
          event: "APPROVE",
        })
      );
      await client.close();
    });
  }
);
