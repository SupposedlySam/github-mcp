// CODEOWNERS parsing.
//
// GitHub's closest analog to Bitbucket's effective default reviewers is the
// CODEOWNERS file: owners of matched paths are requested as reviewers on
// every PR touching those paths. This parses the file into ordered rules
// (later rules take precedence on GitHub).

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

export const CODEOWNERS_LOCATIONS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [pattern, ...owners] = parts;
    rules.push({ pattern, owners });
  }
  return rules;
}

function stripComment(line: string): string {
  const index = line.indexOf("#");
  return index === -1 ? line : line.slice(0, index);
}
