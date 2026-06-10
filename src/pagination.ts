import type winston from "winston";

export const GITHUB_DEFAULT_PER_PAGE = 30;
export const GITHUB_MAX_PER_PAGE = 100;
export const GITHUB_ALL_ITEMS_CAP = 1000;

export interface PaginationRequestOptions {
  per_page?: number;
  page?: number;
  all?: boolean;
  defaultPerPage?: number;
  maxItems?: number;
  description?: string;
}

export interface PaginatedValuesResult<T> {
  values: T[];
  page?: number;
  per_page: number;
  fetchedPages: number;
  totalFetched: number;
  hasMore: boolean;
}

export type PageFetcher<T> = (page: number, perPage: number) => Promise<T[]>;

export class GitHubPaginator {
  constructor(private readonly logger: winston.Logger) {}

  /**
   * Fetch one page, or — when `all` is true and no explicit `page` is given —
   * walk pages until a short page is returned or `maxItems` is reached.
   */
  async fetchValues<T>(
    fetchPage: PageFetcher<T>,
    options: PaginationRequestOptions = {}
  ): Promise<PaginatedValuesResult<T>> {
    const {
      per_page,
      page,
      all = false,
      defaultPerPage = GITHUB_DEFAULT_PER_PAGE,
      maxItems = GITHUB_ALL_ITEMS_CAP,
      description,
    } = options;

    const resolvedPerPage = this.normalizePerPage(per_page ?? defaultPerPage);
    const shouldFetchAll = all === true && page === undefined;

    if (!shouldFetchAll) {
      const requestedPage = page ?? 1;
      this.logger.debug("Calling GitHub API page", {
        description,
        page: requestedPage,
        per_page: resolvedPerPage,
      });
      const values = await fetchPage(requestedPage, resolvedPerPage);
      return {
        values,
        page: requestedPage,
        per_page: resolvedPerPage,
        fetchedPages: 1,
        totalFetched: values.length,
        hasMore: values.length === resolvedPerPage,
      };
    }

    const aggregated: T[] = [];
    let fetchedPages = 0;
    let currentPage = 1;
    let hasMore = false;
    const pageSize = this.normalizePerPage(per_page ?? GITHUB_MAX_PER_PAGE);

    for (;;) {
      this.logger.debug("Calling GitHub API page", {
        description,
        page: currentPage,
        per_page: pageSize,
      });
      const values = await fetchPage(currentPage, pageSize);
      fetchedPages += 1;
      aggregated.push(...values);

      if (values.length < pageSize) {
        hasMore = false;
        break;
      }
      if (aggregated.length >= maxItems) {
        this.logger.debug("GitHub pagination cap reached", {
          description,
          maxItems,
        });
        hasMore = true;
        break;
      }
      currentPage += 1;
    }

    if (aggregated.length > maxItems) {
      aggregated.length = maxItems;
    }

    return {
      values: aggregated,
      page: 1,
      per_page: pageSize,
      fetchedPages,
      totalFetched: aggregated.length,
      hasMore,
    };
  }

  private normalizePerPage(value?: number): number {
    if (value === undefined || Number.isNaN(value)) {
      return GITHUB_DEFAULT_PER_PAGE;
    }
    const integer = Math.floor(value);
    if (!Number.isFinite(integer) || integer < 1) {
      return 1;
    }
    return Math.min(integer, GITHUB_MAX_PER_PAGE);
  }
}
