const GITHUB_URL_RE = /github\.com[:/]([^/\s"']+)\/([^/\s"']+)\/pull\/(\d+)/iu;
const BARE_PR_RE = /^([^/\s#]+)\/([^/\s#]+)\/(?:pull\/)?(\d+)$/iu;
const HASH_PR_RE = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/iu;
const COMMIT_RE = /^[0-9a-f]{7,40}$/iu;

export function slugify(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
}

function clean(value) {
  return String(value || "")
    .trim()
    .replace(/[,;]+$/u, "")
    .trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function optionalBoolean(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function optionalCommit(value, name) {
  const commit = optionalString(value, name);
  if (!commit) {
    return null;
  }
  const normalized = clean(commit);
  if (!COMMIT_RE.test(normalized)) {
    throw new Error(`${name} must be a 7-40 character commit SHA`);
  }
  return normalized;
}

export function parsePrReference(value) {
  const reference = clean(value);
  if (!reference) {
    return null;
  }

  const match = reference.match(GITHUB_URL_RE) || reference.match(BARE_PR_RE) || reference.match(HASH_PR_RE);
  if (!match) {
    return null;
  }

  const [, owner, repo, numberText] = match;
  const number = Number(numberText);
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }

  const repository = `${owner}/${repo}`;
  return {
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    ref: `${repository}#${number}`,
    slug: `${slugify(repository)}-pr-${number}`,
  };
}

export function normalizeEvalInput(value, index = 0) {
  const source = typeof value === "string" ? { pr: value } : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`eval input[${index}] must be a PR string or object`);
  }

  const reference = source.pr || source.ref || source.url || source.pullRequest;
  if (typeof reference !== "string") {
    throw new Error(`eval input[${index}] must include a string pr/ref/url`);
  }

  const parsed = parsePrReference(reference);
  if (!parsed) {
    throw new Error(`eval input[${index}] is not a supported GitHub PR reference`);
  }

  const baseSha = optionalCommit(source.base ?? source.baseSha, `eval input[${index}].base`);
  const headSha = optionalCommit(source.head ?? source.headSha, `eval input[${index}].head`);
  if ((baseSha && !headSha) || (!baseSha && headSha)) {
    throw new Error(`eval input[${index}] fixed revisions must include both base and head`);
  }

  const label = optionalString(source.label, `eval input[${index}].label`);
  const notes = optionalString(source.notes, `eval input[${index}].notes`);
  const ignoreHistory = optionalBoolean(
    source.ignoreHistory ?? source.ignore_history,
    `eval input[${index}].ignoreHistory`,
    true,
  );

  const revisionSlug = baseSha && headSha ? `-${baseSha.slice(0, 7)}-${headSha.slice(0, 7)}` : "";
  return {
    ...parsed,
    label,
    notes,
    ignoreHistory,
    baseSha,
    headSha,
    slug: `${parsed.slug}${revisionSlug}`,
  };
}

export function normalizeEvalInputs(inputs = []) {
  if (!Array.isArray(inputs)) {
    throw new Error("eval config input must be an array");
  }
  return inputs.map((input, index) => normalizeEvalInput(input, index));
}
