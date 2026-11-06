/**
 * The per-call `signature` argument: a caller that signs its own posts can
 * replace GITHUB_COMMENT_SIGNATURE for one call, or pass "" to post the body
 * exactly as given.
 *
 * Reported from a consumer: a body ending in its own owner-agent line came
 * back with the configured signature stacked beneath it, on create AND on
 * every edit, so no MCP call could repair it.
 */
import { jest } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { applySignature } from "../src/signature.js";

// Generic placeholders only; no real identities in fixtures.
const SIG = "— 🤖 Example MCP Bot";
const OWN = "— 🤖 example owner agent";

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "test-token";
process.env.GITHUB_COMMENT_SIGNATURE = SIG;

const SIGNING_TOOLS = [
  "closePullRequest",
  "approvePullRequest",
  "unapprovePullRequest",
  "createPullRequestReview",
  "submitPullRequestReview",
  "addPullRequestComment",
  "updatePullRequestComment",
  "addIssueComment",
  "updateIssueComment",
];

describe("applySignature override", () => {
  const env = { GITHUB_COMMENT_SIGNATURE: SIG };

  it("uses the configured signature when no override is given", () => {
    expect(applySignature("Hi", env, undefined)).toBe(`Hi\n\n${SIG}`);
  });

  it("replaces the configured signature with the override", () => {
    expect(applySignature("Hi", env, OWN)).toBe(`Hi\n\n${OWN}`);
  });

  it("appends an override even when nothing is configured", () => {
    expect(applySignature("Hi", {}, OWN)).toBe(`Hi\n\n${OWN}`);
  });

  it("does not re-append an override the body already ends with", () => {
    const body = `Hi\n\n${OWN}`;
    expect(applySignature(body, env, OWN)).toBe(body);
  });

  it.each(["", "   "])("posts the body verbatim for an empty override (%j)", (o) => {
    const body = `Hi\n\n${OWN}`;
    expect(applySignature(body, env, o)).toBe(body);
  });

  it("keeps an undefined body undefined under an override", () => {
    expect(applySignature(undefined, env, OWN)).toBeUndefined();
  });
});

describe("signature argument through tools/call", () => {
  let GitHubServer: any;
  beforeAll(async () => {
    ({ GitHubServer } = await import("../src/index.js"));
  });

  async function connect() {
    const server: any = new GitHubServer();
    server.getAuthenticatedLogin = async () => "test-user";
    const createComment = jest.fn(async (_p: any) => ({ data: { id: 3 } }));
    const updateComment = jest.fn(async (_p: any) => ({ data: { id: 3 } }));
    server.octokit.rest.issues.createComment = createComment;
    server.octokit.rest.issues.updateComment = updateComment;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    return { client, createComment, updateComment };
  }

  it("is declared on every tool that signs (else argValidation rejects it)", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const declared = tools
      .filter((t: any) => t.inputSchema?.properties?.signature)
      .map((t: any) => t.name)
      .sort();
    expect(declared).toEqual([...SIGNING_TOOLS].sort());
  });

  it("the reported case: an edit with signature \"\" keeps only the caller's line", async () => {
    const { client, updateComment } = await connect();
    const body = `Re-signed.\n\n${OWN}`;
    const result: any = await client.callTool({
      name: "updateIssueComment",
      arguments: { owner: "example-org", repo: "example", comment_id: 9, body, signature: "" },
    });
    expect(result.isError).toBeFalsy();
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(updateComment.mock.calls[0][0].body).toBe(body);
  });

  it("a create with the caller's own signature appends it instead of the configured one", async () => {
    const { client, createComment } = await connect();
    await client.callTool({
      name: "addIssueComment",
      arguments: { owner: "example-org", repo: "example", issue_number: 1, body: "Hi", signature: OWN },
    });
    expect(createComment.mock.calls[0][0].body).toBe(`Hi\n\n${OWN}`);
  });

  it("omitting signature still signs with the configured one (positive control)", async () => {
    const { client, createComment } = await connect();
    await client.callTool({
      name: "addIssueComment",
      arguments: { owner: "example-org", repo: "example", issue_number: 1, body: "Hi" },
    });
    expect(createComment.mock.calls[0][0].body).toBe(`Hi\n\n${SIG}`);
  });

  it("refuses a non-string signature before calling GitHub", async () => {
    const { client, createComment } = await connect();
    const result: any = await client.callTool({
      name: "addIssueComment",
      arguments: { owner: "example-org", repo: "example", issue_number: 1, body: "Hi", signature: false },
    }).catch((e: any) => ({ isError: true, content: [{ text: String(e) }] }));
    expect(result.isError).toBe(true);
    expect(createComment).not.toHaveBeenCalled();
  });
});

describe("signature override on the other signing paths", () => {
  let GitHubServer: any;
  beforeAll(async () => {
    ({ GitHubServer } = await import("../src/index.js"));
  });

  function makeServer(): any {
    const server: any = new GitHubServer();
    server.getAuthenticatedLogin = async () => "test-user";
    return server;
  }

  it("updatePullRequestComment honours an empty override on an issue comment", async () => {
    const server = makeServer();
    const updateComment = jest.fn(async (_p: any) => ({ data: { id: 3 } }));
    server.octokit.rest.issues.updateComment = updateComment;
    const body = `Edited.\n\n${OWN}`;
    await server.updatePullRequestComment("o", "r", 3, body, "issue", "");
    expect(updateComment.mock.calls[0][0].body).toBe(body);
  });

  it("closePullRequest signs its close comment with the override", async () => {
    const server = makeServer();
    const createComment = jest.fn(async (_p: any) => ({ data: { id: 3 } }));
    server.octokit.rest.issues.createComment = createComment;
    server.octokit.rest.pulls.update = async () => ({
      data: { number: 7, state: "closed", user: { login: "x" }, head: {}, base: {} },
    });
    await server.closePullRequest("o", "r", 7, "Superseded", OWN);
    expect(createComment.mock.calls[0][0].body).toBe(`Superseded\n\n${OWN}`);
  });

  it("unapprovePullRequest signs the default dismissal message with the override", async () => {
    const server = makeServer();
    server.listAllReviews = async () => [
      { id: 5, state: "APPROVED", user: { login: "test-user" } },
    ];
    const dismissReview = jest.fn(async (_p: any) => ({ data: { id: 5, state: "DISMISSED" } }));
    server.octokit.rest.pulls.dismissReview = dismissReview;
    await server.unapprovePullRequest("o", "r", 7, undefined, OWN);
    expect(dismissReview.mock.calls[0][0].message).toBe(`Approval withdrawn\n\n${OWN}`);
  });
});
