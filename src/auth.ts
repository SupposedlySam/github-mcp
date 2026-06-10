// GitHub token resolution.
//
// Order of precedence:
//   1. GITHUB_TOKEN environment variable
//   2. `gh auth token` (GitHub CLI), when the CLI is installed and logged in
//
// Returns undefined when neither source yields a token so the server can
// produce a single, actionable startup error.

import { execFileSync } from "child_process";

export type ExecFileSyncLike = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout?: number }
) => string;

export function resolveGitHubToken(
  env: Record<string, string | undefined> = process.env,
  exec: ExecFileSyncLike = execFileSync as unknown as ExecFileSyncLike
): string | undefined {
  const envToken = env.GITHUB_TOKEN?.trim();
  if (envToken && envToken.length > 0) {
    return envToken;
  }

  try {
    const output = exec("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const token = output.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    // gh not installed, not logged in, or timed out — fall through.
    return undefined;
  }
}
