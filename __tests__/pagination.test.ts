import { jest } from "@jest/globals";
import {
  GitHubPaginator,
  GITHUB_DEFAULT_PER_PAGE,
  GITHUB_MAX_PER_PAGE,
} from "../src/pagination.js";

const createMockLogger = () =>
  ({
    debug: jest.fn(),
  }) as any;

describe("GitHubPaginator", () => {
  it("respects per_page and page arguments", async () => {
    const paginator = new GitHubPaginator(createMockLogger());
    const fetchPage = jest.fn(async () => [{ id: 1 }]);

    const result = await paginator.fetchValues(fetchPage as any, {
      per_page: 1,
      page: 3,
      description: "unit",
    });

    expect(fetchPage).toHaveBeenCalledWith(3, 1);
    expect(result.values).toHaveLength(1);
    expect(result.page).toBe(3);
    expect(result.fetchedPages).toBe(1);
  });

  it("defaults to page 1 and the default page size", async () => {
    const paginator = new GitHubPaginator(createMockLogger());
    const fetchPage = jest.fn(async () => [] as unknown[]);

    const result = await paginator.fetchValues(fetchPage as any, {});

    expect(fetchPage).toHaveBeenCalledWith(1, GITHUB_DEFAULT_PER_PAGE);
    expect(result.values).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("caps per_page to the GitHub maximum", async () => {
    const paginator = new GitHubPaginator(createMockLogger());
    const fetchPage = jest.fn(async () => [] as unknown[]);

    await paginator.fetchValues(fetchPage as any, {
      per_page: GITHUB_MAX_PER_PAGE + 25,
    });

    expect(fetchPage).toHaveBeenCalledWith(1, GITHUB_MAX_PER_PAGE);
  });

  it("walks pages when all=true and stops on a short page", async () => {
    const paginator = new GitHubPaginator(createMockLogger());
    const pageOne = Array.from({ length: GITHUB_MAX_PER_PAGE }, (_, i) => ({
      id: i,
    }));
    const pageTwo = [{ id: 100 }];
    const fetchPage = jest
      .fn<(page: number, perPage: number) => Promise<unknown[]>>()
      .mockResolvedValueOnce(pageOne)
      .mockResolvedValueOnce(pageTwo);

    const result = await paginator.fetchValues(fetchPage as any, {
      all: true,
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 1, GITHUB_MAX_PER_PAGE);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2, GITHUB_MAX_PER_PAGE);
    expect(result.totalFetched).toBe(GITHUB_MAX_PER_PAGE + 1);
    expect(result.hasMore).toBe(false);
  });

  it("stops at maxItems when all=true and reports hasMore", async () => {
    const paginator = new GitHubPaginator(createMockLogger());
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const fetchPage = jest.fn(async () => fullPage);

    const result = await paginator.fetchValues(fetchPage as any, {
      all: true,
      maxItems: 150,
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.values).toHaveLength(150);
    expect(result.hasMore).toBe(true);
  });

  it("ignores all=true when an explicit page is provided", async () => {
    const paginator = new GitHubPaginator(createMockLogger());
    const fetchPage = jest.fn(async () => [{ id: 1 }]);

    const result = await paginator.fetchValues(fetchPage as any, {
      all: true,
      page: 2,
      per_page: 1,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(2, 1);
    expect(result.fetchedPages).toBe(1);
  });
});
