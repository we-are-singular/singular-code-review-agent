import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { filterUnifiedDiff } from "./diff-filter.mjs";

const execFileAsync = promisify(execFile);

export function splitRepository(repository) {
  const [owner, repo] = String(repository || "").split("/", 2);
  if (!owner || !repo) {
    throw new Error("repository must use owner/name format");
  }
  return { owner, repo };
}

export async function resolveGitHubToken(env = process.env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) {
    return env.GH_TOKEN || env.GITHUB_TOKEN;
  }
  const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf8" });
  const token = stdout.trim();
  if (!token) {
    throw new Error("GH_TOKEN, GITHUB_TOKEN, or `gh auth token` is required");
  }
  return token;
}

export async function loadPullRequestInput(input, token) {
  const { owner, repo } = splitRepository(input.repository);
  const octokit = new Octokit({
    auth: token,
    userAgent: "singular-code-review-eval",
  });

  const [prResponse, diffResponse, commits] = await Promise.all([
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: input.number,
    }),
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: input.number,
      mediaType: { format: "diff" },
    }),
    octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
      owner,
      repo,
      pull_number: input.number,
      per_page: 100,
    }),
  ]);

  const pr = prResponse.data;
  const filteredDiff = filterUnifiedDiff(String(diffResponse.data || ""));
  const context = {
    repository: input.repository,
    number: input.number,
    url: input.url,
    label: input.label,
    notes: input.notes,
    ignoreHistory: input.ignoreHistory,
    baseSha: input.baseSha || pr.base.sha || null,
    headSha: input.headSha || pr.head.sha || null,
    title: pr.title || "",
    body: pr.body || "",
    author: pr.user?.login || null,
    baseRef: pr.base.ref || null,
    headRef: pr.head.ref || null,
    isDraft: Boolean(pr.draft),
    commits: commits.map((commit) => ({
      sha: commit.sha,
      message: String(commit.commit?.message || "").split(/\r?\n/u)[0],
      author: commit.author?.login || commit.commit?.author?.name || null,
    })),
    history: input.ignoreHistory
      ? {
          ignored: true,
          issueComments: [],
          reviewComments: [],
          reviews: [],
        }
      : {
          ignored: false,
          note: "History capture is intentionally not implemented in the new eval runner yet.",
          issueComments: [],
          reviewComments: [],
          reviews: [],
        },
    diff: {
      ignoredFiles: filteredDiff.ignoredFiles,
    },
  };

  return {
    context,
    diffText: filteredDiff.text,
  };
}

export async function preparePullRequestWorkspace(input, workspace) {
  await execFileAsync("gh", ["repo", "clone", input.repository, workspace, "--", "--filter=blob:none"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  await execFileAsync("git", ["-C", workspace, "fetch", "origin", `pull/${input.number}/head:refs/remotes/eval/pr-${input.number}`], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const checkoutRef = input.headSha || `refs/remotes/eval/pr-${input.number}`;
  await execFileAsync("git", ["-C", workspace, "checkout", "--detach", checkoutRef], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}
