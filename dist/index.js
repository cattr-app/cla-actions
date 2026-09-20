"use strict";

// src/runtime.ts
var fs = require("fs");
function getInput(name, required = false, fallback = "") {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = process.env[key]?.trim() ?? fallback;
  if (required && value === "") {
    throw new Error(`Required action input is missing: ${name}`);
  }
  return value;
}
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable is missing: ${name}`);
  }
  return value;
}
function readEvent() {
  const path = requiredEnv("GITHUB_EVENT_PATH");
  return JSON.parse(fs.readFileSync(path, "utf8"));
}
function repository() {
  return requiredEnv("GITHUB_REPOSITORY");
}
function workflowRunId() {
  return Number(requiredEnv("GITHUB_RUN_ID"));
}
function workflowRunAttempt() {
  return Number(requiredEnv("GITHUB_RUN_ATTEMPT"));
}
function error(message2) {
  console.error(`::error::${message2}`);
}
function shortSha(sha, length = 12) {
  return sha.slice(0, length);
}

// src/config.ts
function loadConfig() {
  const exempt = (process.env.CLA_EXEMPT_LOGINS?.trim() || "dependabot[bot]").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  return {
    operation: getInput("operation", true),
    botToken: getInput("bot-token"),
    botAppSlug: getInput("bot-app-slug"),
    registryToken: getInput("registry-token"),
    sourceToken: getInput("source-token"),
    registryRepository: getInput(
      "registry-repository",
      false,
      "cattr-app/cla-registry"
    ),
    claPath: getInput("cla-path", false, "CLA.md"),
    exemptLogins: new Set(exempt)
  };
}

// src/cla.ts
var crypto = require("crypto");
var VERSION_PATTERN = /cattr-cla-version:\s*([0-9]+)/g;
function parseClaVersion(content) {
  const matches = [...content.matchAll(VERSION_PATTERN)];
  if (matches.length !== 1) {
    throw new Error("CLA.md must contain exactly one cattr-cla-version marker");
  }
  const version = Number(matches[0][1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("cattr-cla-version must be a positive integer");
  }
  return version;
}
function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
function identityKey(name, email) {
  const hash = crypto.createHash("sha256");
  hash.update(name, "utf8");
  hash.update(Buffer.from("\0", "utf8"));
  hash.update(email, "utf8");
  return hash.digest("hex");
}
async function resolveEffectiveCla(github, repository2, claPath, pr) {
  let sourceSha = pr.baseSha;
  let content = await github.getFile(repository2, claPath, sourceSha);
  if (content === null) {
    const currentBase = await github.getCommit(repository2, pr.baseRef);
    sourceSha = currentBase.sha;
    content = await github.getFile(repository2, claPath, sourceSha);
  }
  if (content === null) {
    return null;
  }
  return {
    content,
    sourceSha,
    sourceUrl: `https://github.com/${repository2}/blob/${sourceSha}/${claPath}`
  };
}

// src/github.ts
var GitHubHttpError = class extends Error {
  status;
  body;
  constructor(status, body, message2) {
    super(message2 ?? `GitHub API request failed with HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
};
function encodeContentPath(path) {
  return path.split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}
var GitHubClient = class {
  token;
  constructor(token) {
    if (!token) {
      throw new Error("GitHub token is required");
    }
    this.token = token;
  }
  async request(method, path, body, accept = "application/vnd.github+json") {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "cattr-cla-actions",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      const acceptedPermissions = response.headers.get("x-accepted-github-permissions");
      let apiMessage = text.trim();
      if (text !== "") {
        try {
          const payload = JSON.parse(text);
          if (payload && typeof payload === "object" && typeof payload.message === "string") {
            apiMessage = payload.message;
          }
        } catch {
        }
      }
      const details = [
        `GitHub API ${method} ${path} failed with HTTP ${response.status}`,
        apiMessage ? `message=${apiMessage}` : "",
        acceptedPermissions ? `accepted-permissions=${acceptedPermissions}` : ""
      ].filter(Boolean);
      throw new GitHubHttpError(
        response.status,
        text,
        details.join("; ")
      );
    }
    return text === "" ? null : JSON.parse(text);
  }
  async graphql(query, variables) {
    const result = await this.request("POST", "/graphql", { query, variables });
    if (Array.isArray(result?.errors) && result.errors.length > 0) {
      throw new Error(`GitHub GraphQL error: ${JSON.stringify(result.errors)}`);
    }
    return result.data;
  }
  async getPullRequest(repository2, number) {
    const pr = await this.request("GET", `/repos/${repository2}/pulls/${number}`);
    return {
      number,
      state: String(pr.state),
      headSha: String(pr.head.sha),
      baseSha: String(pr.base.sha),
      baseRef: String(pr.base.ref),
      repositoryId: Number(pr.base.repo.id)
    };
  }
  async getRepository(repository2) {
    const repo = await this.request("GET", `/repos/${repository2}`);
    return {
      id: Number(repo.id),
      defaultBranch: String(repo.default_branch)
    };
  }
  async getCommit(repository2, ref) {
    const commit = await this.request(
      "GET",
      `/repos/${repository2}/commits/${encodeURIComponent(ref)}`
    );
    return {
      sha: String(commit.sha),
      committedAt: String(commit.commit.committer.date)
    };
  }
  async getUserId(login) {
    const user = await this.request("GET", `/users/${encodeURIComponent(login)}`);
    const id = Number(user.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`GitHub returned an invalid user ID for ${login}`);
    }
    return id;
  }
  async getFile(repository2, path, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    try {
      const file = await this.request(
        "GET",
        `/repos/${repository2}/contents/${encodeContentPath(path)}${query}`
      );
      if (!file || Array.isArray(file) || typeof file.content !== "string") {
        throw new Error(`Expected file at ${repository2}:${path}`);
      }
      return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    } catch (error2) {
      if (error2 instanceof GitHubHttpError && error2.status === 404) {
        return null;
      }
      throw error2;
    }
  }
  async getDirectory(repository2, path) {
    try {
      const value = await this.request(
        "GET",
        `/repos/${repository2}/contents/${encodeContentPath(path)}`
      );
      if (!Array.isArray(value)) {
        throw new Error(`Expected directory at ${repository2}:${path}`);
      }
      return value.map((item) => ({
        name: String(item.name),
        path: String(item.path),
        type: String(item.type)
      }));
    } catch (error2) {
      if (error2 instanceof GitHubHttpError && error2.status === 404) {
        return null;
      }
      throw error2;
    }
  }
  async createFile(repository2, path, content, message2) {
    await this.request(
      "PUT",
      `/repos/${repository2}/contents/${encodeContentPath(path)}`,
      {
        message: message2,
        content: Buffer.from(content, "utf8").toString("base64")
      }
    );
  }
  async postComment(repository2, issueNumber, body) {
    await this.request(
      "POST",
      `/repos/${repository2}/issues/${issueNumber}/comments`,
      { body }
    );
  }
  async upsertBotComment(repository2, issueNumber, appSlug, marker, body) {
    const expectedLogin = `${appSlug}[bot]`;
    let page = 1;
    let commentId = null;
    while (commentId === null) {
      const comments = await this.request(
        "GET",
        `/repos/${repository2}/issues/${issueNumber}/comments?per_page=100&page=${page}`
      );
      for (const comment of comments) {
        if (comment?.user?.login === expectedLogin && typeof comment?.body === "string" && comment.body.includes(marker)) {
          commentId = Number(comment.id);
          break;
        }
      }
      if (commentId !== null || comments.length < 100) {
        break;
      }
      page += 1;
    }
    if (commentId !== null) {
      await this.request(
        "PATCH",
        `/repos/${repository2}/issues/comments/${commentId}`,
        { body }
      );
      return;
    }
    await this.postComment(repository2, issueNumber, body);
  }
  async upsertCheck(repository2, headSha, appSlug, name, conclusion, title, detailsUrl, summary) {
    const result = await this.request(
      "GET",
      `/repos/${repository2}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`,
      void 0,
      "application/vnd.github+json"
    );
    const existing = (result?.check_runs ?? []).find(
      (run) => run?.name === name && run?.app?.slug === appSlug
    );
    const body = {
      status: "completed",
      conclusion,
      details_url: detailsUrl,
      output: {
        title,
        summary
      }
    };
    if (existing) {
      await this.request(
        "PATCH",
        `/repos/${repository2}/check-runs/${Number(existing.id)}`,
        body
      );
      return;
    }
    await this.request(
      "POST",
      `/repos/${repository2}/check-runs`,
      {
        name,
        head_sha: headSha,
        ...body
      }
    );
  }
};

// src/registry.ts
function agreementDir(repositoryId, version) {
  return `agreements/${repositoryId}/${version}`;
}
function acceptancePath(userId, repositoryId, version) {
  return `acceptances/${userId}/${repositoryId}/${version}.json`;
}
function claimDir(repositoryId, commitSha, identityKey2) {
  return `claims/${repositoryId}/${commitSha}/${identityKey2}`;
}
function claimPath(repositoryId, commitSha, identityKey2, userId) {
  return `${claimDir(repositoryId, commitSha, identityKey2)}/${userId}.json`;
}
async function readJson(github, repository2, path) {
  const content = await github.getFile(repository2, path);
  if (content === null) {
    return null;
  }
  return JSON.parse(content);
}
function validateAgreement(value, repositoryId, version, digest) {
  return value.repository_id === repositoryId && value.version === version && value.sha256 === digest;
}
function validateAcceptance(value, userId, repositoryId, version, digest) {
  return value.github_user_id === userId && value.repository_id === repositoryId && value.cla_version === version && value.cla_sha256 === digest;
}
function validateClaim(value, userId, repositoryId, commitSha, identityKey2) {
  return value.github_user_id === userId && value.repository_id === repositoryId && value.commit_sha === commitSha && value.identity.key === identityKey2;
}

// src/contributors.ts
var PR_COMMITS_QUERY = `
query(
  $owner: String!
  $name: String!
  $number: Int!
  $after: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $after) {
        nodes {
          commit {
            oid
            authors(first: 100) {
              nodes {
                name
                email
                user {
                  login
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;
var COMMIT_AUTHORS_QUERY = `
query(
  $owner: String!
  $name: String!
  $oid: GitObjectID!
  $after: String
) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        oid
        authors(first: 100, after: $after) {
          nodes {
            name
            email
            user {
              login
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
}
`;
function splitRepository(repository2) {
  const index = repository2.indexOf("/");
  if (index <= 0 || index === repository2.length - 1) {
    throw new Error(`Invalid repository name: ${repository2}`);
  }
  return [repository2.slice(0, index), repository2.slice(index + 1)];
}
function mergeContributor(map, contributor) {
  const current = map.get(contributor.githubUserId);
  if (!current) {
    map.set(contributor.githubUserId, {
      githubUserId: contributor.githubUserId,
      githubLogin: contributor.githubLogin,
      names: [...new Set(contributor.names)],
      commits: [...new Set(contributor.commits)],
      claimedIdentities: [...new Set(contributor.claimedIdentities)]
    });
    return;
  }
  current.githubLogin = contributor.githubLogin;
  current.names = [.../* @__PURE__ */ new Set([...current.names, ...contributor.names])];
  current.commits = [.../* @__PURE__ */ new Set([...current.commits, ...contributor.commits])];
  current.claimedIdentities = [
    .../* @__PURE__ */ new Set([...current.claimedIdentities, ...contributor.claimedIdentities])
  ];
}
function pushActor(actors, commit, node) {
  actors.push({
    commit,
    name: String(node?.name ?? ""),
    email: String(node?.email ?? ""),
    login: node?.user?.login ? String(node.user.login) : null
  });
}
async function collectPrContributors(github, repository2, prNumber, exemptLogins) {
  const [owner, name] = splitRepository(repository2);
  const actors = [];
  let cursor = null;
  do {
    const page = await github.graphql(
      PR_COMMITS_QUERY,
      {
        owner,
        name,
        number: prNumber,
        after: cursor
      }
    );
    const pullRequest = page.repository.pullRequest;
    if (!pullRequest) {
      throw new Error(`Pull request #${prNumber} could not be queried`);
    }
    for (const node of pullRequest.commits.nodes) {
      const commit = node.commit;
      for (const actor of commit.authors.nodes) {
        pushActor(actors, commit.oid, actor);
      }
      let authorCursor = commit.authors.pageInfo.endCursor;
      while (commit.authors.pageInfo.hasNextPage && authorCursor) {
        const authorPage = await github.graphql(
          COMMIT_AUTHORS_QUERY,
          {
            owner,
            name,
            oid: commit.oid,
            after: authorCursor
          }
        );
        const object = authorPage.repository.object;
        if (!object) {
          throw new Error(`Commit ${commit.oid} could not be queried`);
        }
        for (const actor of object.authors.nodes) {
          pushActor(actors, commit.oid, actor);
        }
        if (!object.authors.pageInfo.hasNextPage) {
          break;
        }
        authorCursor = object.authors.pageInfo.endCursor;
      }
    }
    cursor = pullRequest.commits.pageInfo.hasNextPage ? pullRequest.commits.pageInfo.endCursor : null;
  } while (cursor);
  if (actors.length === 0) {
    throw new Error(`No contributors could be discovered for PR #${prNumber}`);
  }
  const contributorMap = /* @__PURE__ */ new Map();
  const unresolvedMap = /* @__PURE__ */ new Map();
  const exemptMap = /* @__PURE__ */ new Map();
  const resolvedLogins = [...new Set(
    actors.map((actor) => actor.login).filter((login) => login !== null)
  )];
  const userIds = /* @__PURE__ */ new Map();
  for (const login of resolvedLogins) {
    if (exemptLogins.has(login)) {
      continue;
    }
    try {
      userIds.set(login, await github.getUserId(login));
    } catch {
    }
  }
  for (const actor of actors) {
    if (actor.login && exemptLogins.has(actor.login)) {
      const current = exemptMap.get(actor.login) ?? {
        githubLogin: actor.login,
        commits: []
      };
      current.commits = [.../* @__PURE__ */ new Set([...current.commits, actor.commit])];
      exemptMap.set(actor.login, current);
      continue;
    }
    if (actor.login && userIds.has(actor.login)) {
      const id = userIds.get(actor.login);
      mergeContributor(contributorMap, {
        githubUserId: id,
        githubLogin: actor.login,
        names: actor.name ? [actor.name] : [],
        commits: [actor.commit],
        claimedIdentities: []
      });
      continue;
    }
    const key = identityKey(actor.name, actor.email);
    const composite = `${actor.commit}:${key}`;
    unresolvedMap.set(composite, {
      name: actor.name || "Unknown author",
      commit: actor.commit,
      identityKey: key
    });
  }
  return {
    contributors: [...contributorMap.values()],
    unresolved: [...unresolvedMap.values()],
    exempt: [...exemptMap.values()]
  };
}
async function applyClaims(github, registryRepository, repositoryId, raw) {
  const contributorMap = /* @__PURE__ */ new Map();
  for (const contributor of raw.contributors) {
    mergeContributor(contributorMap, contributor);
  }
  const unresolved = [];
  const claimConflicts = [];
  for (const actor of raw.unresolved) {
    const directory = claimDir(repositoryId, actor.commit, actor.identityKey);
    const entries = await github.getDirectory(registryRepository, directory);
    if (entries === null) {
      unresolved.push(actor);
      continue;
    }
    const files = entries.filter(
      (entry) => entry.type === "file" && entry.name.endsWith(".json")
    );
    if (files.length === 0) {
      unresolved.push(actor);
      continue;
    }
    if (files.length !== 1) {
      claimConflicts.push({
        commit: actor.commit,
        identityKey: actor.identityKey,
        reason: "multiple-claims"
      });
      continue;
    }
    const claim = await readJson(
      github,
      registryRepository,
      files[0].path
    );
    if (!claim || !validateClaim(
      claim,
      claim.github_user_id,
      repositoryId,
      actor.commit,
      actor.identityKey
    )) {
      claimConflicts.push({
        commit: actor.commit,
        identityKey: actor.identityKey,
        reason: "invalid-claim"
      });
      continue;
    }
    mergeContributor(contributorMap, {
      githubUserId: claim.github_user_id,
      githubLogin: claim.github_login,
      names: [actor.name],
      commits: [actor.commit],
      claimedIdentities: [actor.identityKey]
    });
  }
  return {
    contributors: [...contributorMap.values()],
    unresolved,
    exempt: raw.exempt,
    claimConflicts
  };
}

// src/operations/check.ts
var COMMENT_MARKER = "<!-- cattr-cla-bot -->";
var CHECK_NAME = "Cattr CLA";
function prNumberFromEvent() {
  const override = process.env.CLA_PR_NUMBER;
  if (override && /^[0-9]+$/.test(override)) {
    return Number(override);
  }
  const event = readEvent();
  const value = event?.pull_request?.number ?? event?.issue?.number;
  if (!Number.isSafeInteger(Number(value))) {
    throw new Error("Unable to determine pull request number");
  }
  return Number(value);
}
function message(result) {
  return `${COMMENT_MARKER}
${result.body.trim()}
`;
}
async function report(github, repositoryName, prNumber, headSha, appSlug, claUrl, result) {
  const body = message(result);
  await github.upsertCheck(
    repositoryName,
    headSha,
    appSlug,
    CHECK_NAME,
    result.conclusion,
    result.title,
    claUrl,
    body
  );
  await github.upsertBotComment(
    repositoryName,
    prNumber,
    appSlug,
    COMMENT_MARKER,
    body
  );
}
function renderContributorStatus(accepted, missing, contributors, version, digest, claUrl) {
  const lines = [
    "### Contributor License Agreement",
    "",
    `This pull request is governed by [Cattr CLA version ${version}](${claUrl}).`,
    ""
  ];
  if (accepted.length > 0) {
    lines.push("**Accepted:**", "");
    for (const login of accepted) {
      lines.push(`- \u2705 @${login}`);
    }
    lines.push("");
  }
  if (missing.length > 0) {
    lines.push("**Still needs to accept:**", "");
    for (const login of missing) {
      lines.push(`- \u23F3 @${login}`);
    }
    lines.push(
      "",
      "Each contributor above must post:",
      "",
      "```text",
      `/cla-sign ${version}`,
      "```",
      ""
    );
  }
  if (contributors.unresolved.length > 0) {
    lines.push("**Unresolved commit authors:**", "");
    for (const actor of contributors.unresolved) {
      lines.push(
        `- \u26A0\uFE0F \`${actor.name}\` \u2014 commit \`${shortSha(actor.commit)}\``,
        `  - Claim: \`/cla-claim ${shortSha(actor.commit)} ${actor.identityKey.slice(0, 12)}\``
      );
    }
    lines.push(
      "",
      "Only claim an identity if you actually authored or co-authored that commit.",
      "A claim identifies the contributor; it does not itself accept the CLA.",
      ""
    );
  }
  lines.push(`CLA SHA-256: \`${digest}\``);
  return lines.join("\n");
}
async function runCheck(config) {
  if (!config.botToken || !config.botAppSlug) {
    throw new Error("check requires bot-token and bot-app-slug");
  }
  const sourceRepository = repository();
  const prNumber = prNumberFromEvent();
  const github = new GitHubClient(config.botToken);
  const pr = await github.getPullRequest(sourceRepository, prNumber);
  if (pr.state !== "open") {
    console.log(`PR #${prNumber} is not open; skipping CLA evaluation.`);
    return;
  }
  const effectiveCla = await resolveEffectiveCla(
    github,
    sourceRepository,
    config.claPath,
    pr
  );
  const claUrl = effectiveCla?.sourceUrl ?? `https://github.com/${sourceRepository}/blob/${pr.baseSha}/${config.claPath}`;
  if (effectiveCla === null) {
    await report(
      github,
      sourceRepository,
      prNumber,
      pr.headSha,
      config.botAppSlug,
      claUrl,
      {
        conclusion: "failure",
        title: "CLA file is missing",
        body: [
          "### Contributor License Agreement",
          "",
          "\u274C The CLA could not be loaded from the trusted base revision or the current target branch of this pull request.",
          "",
          "Maintainer action is required."
        ].join("\n")
      }
    );
    return;
  }
  const cla = effectiveCla.content;
  let version;
  try {
    version = parseClaVersion(cla);
  } catch (error2) {
    await report(
      github,
      sourceRepository,
      prNumber,
      pr.headSha,
      config.botAppSlug,
      claUrl,
      {
        conclusion: "failure",
        title: "Invalid CLA metadata",
        body: [
          "### Contributor License Agreement",
          "",
          `\u274C \`${config.claPath}\` must contain exactly one valid \`cattr-cla-version\` marker.`,
          "",
          "Maintainer action is required."
        ].join("\n")
      }
    );
    return;
  }
  const digest = sha256(cla);
  const metadata = await readJson(
    github,
    config.registryRepository,
    `${agreementDir(pr.repositoryId, version)}/metadata.json`
  );
  if (!metadata) {
    await report(
      github,
      sourceRepository,
      prNumber,
      pr.headSha,
      config.botAppSlug,
      claUrl,
      {
        conclusion: "failure",
        title: "CLA registry is out of sync",
        body: [
          "### Contributor License Agreement",
          "",
          `\u274C CLA version **${version}** is not registered in the Cattr CLA registry.`,
          "",
          "Maintainer action is required."
        ].join("\n")
      }
    );
    return;
  }
  if (!validateAgreement(metadata, pr.repositoryId, version, digest)) {
    await report(
      github,
      sourceRepository,
      prNumber,
      pr.headSha,
      config.botAppSlug,
      claUrl,
      {
        conclusion: "failure",
        title: "CLA registry mismatch",
        body: [
          "### Contributor License Agreement",
          "",
          `\u274C The registered CLA metadata does not match the effective \`${config.claPath}\`.`,
          "",
          `Version: **${version}**`,
          `SHA-256: \`${digest}\``,
          "",
          "Maintainer action is required."
        ].join("\n")
      }
    );
    return;
  }
  const raw = await collectPrContributors(
    github,
    sourceRepository,
    prNumber,
    config.exemptLogins
  );
  const contributors = await applyClaims(
    github,
    config.registryRepository,
    pr.repositoryId,
    raw
  );
  if (contributors.claimConflicts.length > 0) {
    await report(
      github,
      sourceRepository,
      prNumber,
      pr.headSha,
      config.botAppSlug,
      claUrl,
      {
        conclusion: "failure",
        title: "Conflicting CLA authorship claims",
        body: [
          "### Contributor License Agreement",
          "",
          "\u274C Conflicting or invalid authorship claims were detected.",
          "",
          "Maintainer action is required."
        ].join("\n")
      }
    );
    return;
  }
  if (contributors.contributors.length === 0 && contributors.unresolved.length === 0 && contributors.exempt.length > 0) {
    await report(
      github,
      sourceRepository,
      prNumber,
      pr.headSha,
      config.botAppSlug,
      claUrl,
      {
        conclusion: "success",
        title: "CLA not required",
        body: [
          "### Contributor License Agreement",
          "",
          "\u2705 CLA acceptance is not required for this pull request.",
          "",
          "**Exempt automation:**",
          "",
          ...contributors.exempt.map(
            (contributor) => `- \u{1F916} \`${contributor.githubLogin}\``
          )
        ].join("\n")
      }
    );
    return;
  }
  if (contributors.contributors.length === 0 && contributors.unresolved.length === 0 && contributors.exempt.length === 0) {
    await report(
      github,
      sourceRepository,
      prNumber,
      pr.headSha,
      config.botAppSlug,
      claUrl,
      {
        conclusion: "failure",
        title: "No contributors found",
        body: [
          "### Contributor License Agreement",
          "",
          "\u274C No contributors could be determined for this pull request.",
          "",
          "Maintainer action is required."
        ].join("\n")
      }
    );
    return;
  }
  const accepted = [];
  const missing = [];
  const invalid = [];
  for (const contributor of contributors.contributors) {
    const path = acceptancePath(
      contributor.githubUserId,
      pr.repositoryId,
      version
    );
    const acceptance = await readJson(
      github,
      config.registryRepository,
      path
    );
    if (!acceptance) {
      missing.push(contributor.githubLogin);
      continue;
    }
    if (!validateAcceptance(
      acceptance,
      contributor.githubUserId,
      pr.repositoryId,
      version,
      digest
    )) {
      invalid.push(contributor.githubLogin);
      continue;
    }
    accepted.push(contributor.githubLogin);
  }
  if (invalid.length > 0) {
    await report(
      github,
      sourceRepository,
      prNumber,
      pr.headSha,
      config.botAppSlug,
      claUrl,
      {
        conclusion: "failure",
        title: "Invalid CLA acceptance record",
        body: [
          "### Contributor License Agreement",
          "",
          "\u274C One or more CLA acceptance records are inconsistent.",
          "",
          "Affected contributors:",
          "",
          ...invalid.map((login) => `- @${login}`),
          "",
          "Maintainer action is required."
        ].join("\n")
      }
    );
    return;
  }
  if (missing.length > 0 || contributors.unresolved.length > 0) {
    await report(
      github,
      sourceRepository,
      prNumber,
      pr.headSha,
      config.botAppSlug,
      claUrl,
      {
        conclusion: "action_required",
        title: "CLA action required",
        body: renderContributorStatus(
          accepted,
          missing,
          contributors,
          version,
          digest,
          claUrl
        )
      }
    );
    return;
  }
  const lines = [
    "### Contributor License Agreement",
    "",
    `\u2705 Every human contributor has accepted [Cattr CLA version ${version}](${claUrl}).`,
    "",
    ...accepted.map((login) => `- \u2705 @${login}`)
  ];
  if (contributors.exempt.length > 0) {
    lines.push("", "**Exempt automation:**", "");
    for (const exempt of contributors.exempt) {
      lines.push(`- \u{1F916} \`${exempt.githubLogin}\``);
    }
  }
  lines.push("", `CLA SHA-256: \`${digest}\``);
  await report(
    github,
    sourceRepository,
    prNumber,
    pr.headSha,
    config.botAppSlug,
    claUrl,
    {
      conclusion: "success",
      title: "CLA accepted by all contributors",
      body: lines.join("\n")
    }
  );
}

// src/operations/sign.ts
async function reply(github, repositoryName, prNumber, body) {
  await github.postComment(repositoryName, prNumber, body);
}
async function runSign(config) {
  if (!config.botToken || !config.botAppSlug || !config.registryToken) {
    throw new Error("sign requires bot-token, bot-app-slug, and registry-token");
  }
  const event = readEvent();
  const prNumber = Number(event.issue?.number);
  const commenterId = Number(event.comment?.user?.id);
  const commenterLogin = String(event.comment?.user?.login ?? "");
  const body = String(event.comment?.body ?? "");
  const commentId = Number(event.comment?.id);
  const commentUrl = String(event.comment?.html_url ?? "");
  const commentCreatedAt = String(event.comment?.created_at ?? "");
  if (!Number.isSafeInteger(prNumber) || !Number.isSafeInteger(commenterId)) {
    throw new Error("Unable to determine pull request/commenter");
  }
  const match = body.match(/^\/cla-sign\s+([0-9]+)\s*$/);
  const sourceRepository = repository();
  const bot = new GitHubClient(config.botToken);
  const writer = new GitHubClient(config.registryToken);
  if (!match) {
    await reply(
      bot,
      sourceRepository,
      prNumber,
      "Invalid CLA command. Use exactly: `/cla-sign <version>`."
    );
    return;
  }
  if (config.exemptLogins.has(commenterLogin)) {
    await reply(
      bot,
      sourceRepository,
      prNumber,
      `@${commenterLogin} is exempt from CLA acceptance.`
    );
    return;
  }
  const requestedVersion = Number(match[1]);
  const pr = await bot.getPullRequest(sourceRepository, prNumber);
  if (pr.state !== "open") {
    console.log(`PR #${prNumber} is not open; ignoring CLA command.`);
    return;
  }
  const raw = await collectPrContributors(
    bot,
    sourceRepository,
    prNumber,
    config.exemptLogins
  );
  const contributors = await applyClaims(
    bot,
    config.registryRepository,
    pr.repositoryId,
    raw
  );
  if (contributors.claimConflicts.length > 0) {
    await reply(
      bot,
      sourceRepository,
      prNumber,
      "Conflicting authorship claims exist for this pull request. Maintainer action is required."
    );
    process.exitCode = 1;
    return;
  }
  const contributor = contributors.contributors.find(
    (value) => value.githubUserId === commenterId
  );
  if (!contributor) {
    await reply(
      bot,
      sourceRepository,
      prNumber,
      `@${commenterLogin} is not currently associated with a contribution in this pull request. If your Git identity is unresolved, use the \`/cla-claim\` command shown by the CLA check first.`
    );
    return;
  }
  const effectiveCla = await resolveEffectiveCla(
    bot,
    sourceRepository,
    config.claPath,
    pr
  );
  const claUrl = effectiveCla?.sourceUrl ?? `https://github.com/${sourceRepository}/blob/${pr.baseSha}/${config.claPath}`;
  if (effectiveCla === null) {
    await reply(
      bot,
      sourceRepository,
      prNumber,
      "The CLA could not be loaded. Maintainer action is required."
    );
    process.exitCode = 1;
    return;
  }
  const cla = effectiveCla.content;
  let version;
  try {
    version = parseClaVersion(cla);
  } catch {
    await reply(
      bot,
      sourceRepository,
      prNumber,
      "The CLA contains invalid version metadata. Maintainer action is required."
    );
    process.exitCode = 1;
    return;
  }
  const digest = sha256(cla);
  if (requestedVersion !== version) {
    await reply(
      bot,
      sourceRepository,
      prNumber,
      `CLA version **${version}** is currently in effect for this pull request. Read [the agreement](${claUrl}) and use \`/cla-sign ${version}\`.`
    );
    return;
  }
  const metadata = await readJson(
    bot,
    config.registryRepository,
    `${agreementDir(pr.repositoryId, version)}/metadata.json`
  );
  if (!metadata || !validateAgreement(metadata, pr.repositoryId, version, digest)) {
    await reply(
      bot,
      sourceRepository,
      prNumber,
      "The effective CLA does not match its registered snapshot. Maintainer action is required."
    );
    process.exitCode = 1;
    return;
  }
  const path = acceptancePath(commenterId, pr.repositoryId, version);
  const existing = await readJson(
    bot,
    config.registryRepository,
    path
  );
  if (existing) {
    if (!validateAcceptance(
      existing,
      commenterId,
      pr.repositoryId,
      version,
      digest
    )) {
      await reply(
        bot,
        sourceRepository,
        prNumber,
        "An inconsistent CLA acceptance record already exists. Maintainer action is required."
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `CLA acceptance already exists for @${commenterLogin}; refreshing PR check.`
    );
    process.env.CLA_PR_NUMBER = String(prNumber);
    await runCheck(config);
    return;
  }
  const acceptance = {
    github_user_id: commenterId,
    github_login: commenterLogin,
    repository_id: pr.repositoryId,
    repository: sourceRepository,
    cla_version: version,
    cla_sha256: digest,
    accepted_at: commentCreatedAt,
    evidence: {
      pull_request: prNumber,
      comment_id: commentId,
      comment_url: commentUrl,
      command: body,
      source_commit: effectiveCla.sourceSha,
      source_path: config.claPath,
      source_url: claUrl,
      workflow_run_id: workflowRunId(),
      workflow_run_attempt: workflowRunAttempt()
    }
  };
  try {
    await writer.createFile(
      config.registryRepository,
      path,
      `${JSON.stringify(acceptance, null, 2)}
`,
      `chore(cla): record ${commenterLogin} acceptance for ${sourceRepository} v${version}`
    );
  } catch (error2) {
    if (!(error2 instanceof GitHubHttpError) || ![409, 422].includes(error2.status)) {
      throw error2;
    }
    const raced = await readJson(
      bot,
      config.registryRepository,
      path
    );
    if (!raced || !validateAcceptance(
      raced,
      commenterId,
      pr.repositoryId,
      version,
      digest
    )) {
      await reply(
        bot,
        sourceRepository,
        prNumber,
        "The CLA acceptance path was created concurrently with different data. Maintainer action is required."
      );
      process.exitCode = 1;
      return;
    }
  }
  console.log(`Recorded CLA acceptance for @${commenterLogin}.`);
  process.env.CLA_PR_NUMBER = String(prNumber);
  await runCheck(config);
}

// src/operations/claim.ts
async function reply2(github, repositoryName, prNumber, body) {
  await github.postComment(repositoryName, prNumber, body);
}
async function runClaim(config) {
  if (!config.botToken || !config.botAppSlug || !config.registryToken) {
    throw new Error("claim requires bot-token, bot-app-slug, and registry-token");
  }
  const event = readEvent();
  const prNumber = Number(event.issue?.number);
  const commenterId = Number(event.comment?.user?.id);
  const commenterLogin = String(event.comment?.user?.login ?? "");
  const body = String(event.comment?.body ?? "");
  const commentId = Number(event.comment?.id);
  const commentUrl = String(event.comment?.html_url ?? "");
  const commentCreatedAt = String(event.comment?.created_at ?? "");
  if (!Number.isSafeInteger(prNumber) || !Number.isSafeInteger(commenterId)) {
    throw new Error("Unable to determine pull request/commenter");
  }
  const sourceRepository = repository();
  const bot = new GitHubClient(config.botToken);
  const writer = new GitHubClient(config.registryToken);
  if (config.exemptLogins.has(commenterLogin)) {
    await reply2(
      bot,
      sourceRepository,
      prNumber,
      `@${commenterLogin} cannot create an authorship claim.`
    );
    return;
  }
  const match = body.match(
    /^\/cla-claim\s+([0-9a-fA-F]{7,40})(?:\s+([0-9a-fA-F]{6,64}))?\s*$/
  );
  if (!match) {
    await reply2(
      bot,
      sourceRepository,
      prNumber,
      "Invalid claim command. Use `/cla-claim <commit> [identity]`."
    );
    return;
  }
  const commitPrefix = match[1].toLowerCase();
  const identityPrefix = (match[2] ?? "").toLowerCase();
  const pr = await bot.getPullRequest(sourceRepository, prNumber);
  if (pr.state !== "open") {
    console.log(`PR #${prNumber} is not open; ignoring authorship claim.`);
    return;
  }
  const raw = await collectPrContributors(
    bot,
    sourceRepository,
    prNumber,
    config.exemptLogins
  );
  const matchingCommits = [
    ...new Set(
      raw.unresolved.filter((actor2) => actor2.commit.toLowerCase().startsWith(commitPrefix)).map((actor2) => actor2.commit)
    )
  ];
  if (matchingCommits.length === 0) {
    await reply2(
      bot,
      sourceRepository,
      prNumber,
      `No unresolved contributor identity matches commit \`${commitPrefix}\`.`
    );
    return;
  }
  if (matchingCommits.length !== 1) {
    await reply2(
      bot,
      sourceRepository,
      prNumber,
      `Commit prefix \`${commitPrefix}\` is ambiguous. Use a longer commit SHA.`
    );
    return;
  }
  const commitSha = matchingCommits[0];
  let actors = raw.unresolved.filter((actor2) => actor2.commit === commitSha);
  if (identityPrefix) {
    actors = actors.filter(
      (actor2) => actor2.identityKey.toLowerCase().startsWith(identityPrefix)
    );
  }
  if (actors.length === 0) {
    await reply2(
      bot,
      sourceRepository,
      prNumber,
      "No unresolved identity matches the supplied claim selector."
    );
    return;
  }
  if (actors.length > 1) {
    const lines = [
      "This commit contains multiple unresolved contributor identities.",
      "",
      "Use one of:",
      "",
      ...actors.map(
        (actor2) => `- \`${actor2.name}\`: \`/cla-claim ${shortSha(commitSha)} ${actor2.identityKey.slice(0, 12)}\``
      )
    ];
    await reply2(bot, sourceRepository, prNumber, lines.join("\n"));
    return;
  }
  const actor = actors[0];
  const path = claimPath(
    pr.repositoryId,
    commitSha,
    actor.identityKey,
    commenterId
  );
  const existing = await readJson(
    bot,
    config.registryRepository,
    path
  );
  if (existing) {
    if (!validateClaim(
      existing,
      commenterId,
      pr.repositoryId,
      commitSha,
      actor.identityKey
    )) {
      await reply2(
        bot,
        sourceRepository,
        prNumber,
        "Your existing authorship claim is inconsistent. Maintainer action is required."
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Claim already exists for @${commenterLogin}.`);
    process.env.CLA_PR_NUMBER = String(prNumber);
    await runCheck(config);
    return;
  }
  const claim = {
    github_user_id: commenterId,
    github_login: commenterLogin,
    repository_id: pr.repositoryId,
    repository: sourceRepository,
    commit_sha: commitSha,
    identity: {
      key: actor.identityKey,
      name: actor.name
    },
    claimed_at: commentCreatedAt,
    evidence: {
      pull_request: prNumber,
      comment_id: commentId,
      comment_url: commentUrl,
      command: body
    }
  };
  try {
    await writer.createFile(
      config.registryRepository,
      path,
      `${JSON.stringify(claim, null, 2)}
`,
      `chore(cla): record authorship claim by ${commenterLogin}`
    );
  } catch (error2) {
    if (!(error2 instanceof GitHubHttpError) || ![409, 422].includes(error2.status)) {
      throw error2;
    }
    const raced = await readJson(
      bot,
      config.registryRepository,
      path
    );
    if (!raced || !validateClaim(
      raced,
      commenterId,
      pr.repositoryId,
      commitSha,
      actor.identityKey
    )) {
      await reply2(
        bot,
        sourceRepository,
        prNumber,
        "The authorship claim path was created concurrently with different data. Maintainer action is required."
      );
      process.exitCode = 1;
      return;
    }
  }
  await reply2(
    bot,
    sourceRepository,
    prNumber,
    `@${commenterLogin} claimed authorship of \`${shortSha(commitSha)}\` as \`${actor.name}\`. This identifies the contributor but does not itself accept the CLA. If required, now post \`/cla-sign <version>\`.`
  );
  process.env.CLA_PR_NUMBER = String(prNumber);
  await runCheck(config);
}

// src/operations/sync.ts
async function runSync(config) {
  if (!config.sourceToken || !config.registryToken) {
    throw new Error("sync requires source-token and registry-token");
  }
  const sourceRepository = repository();
  const source = new GitHubClient(config.sourceToken);
  const writer = new GitHubClient(config.registryToken);
  const repo = await source.getRepository(sourceRepository);
  const current = await source.getCommit(sourceRepository, repo.defaultBranch);
  const cla = await source.getFile(
    sourceRepository,
    config.claPath,
    current.sha
  );
  if (cla === null) {
    throw new Error(
      `${config.claPath} does not exist on ${sourceRepository}:${repo.defaultBranch}`
    );
  }
  const version = parseClaVersion(cla);
  const digest = sha256(cla);
  const directory = agreementDir(repo.id, version);
  const snapshotPath = `${directory}/CLA.md`;
  const metadataPath = `${directory}/metadata.json`;
  const existingMetadata = await readJson(
    writer,
    config.registryRepository,
    metadataPath
  );
  const existingSnapshot = await writer.getFile(
    config.registryRepository,
    snapshotPath
  );
  if (existingMetadata) {
    if (!validateAgreement(existingMetadata, repo.id, version, digest)) {
      throw new Error(
        `CLA version ${version} is already registered with different metadata. Increment cattr-cla-version before changing ${config.claPath}.`
      );
    }
    if (existingSnapshot === null) {
      throw new Error(
        `CLA version ${version} has metadata but its CLA.md snapshot is missing`
      );
    }
    if (sha256(existingSnapshot) !== digest) {
      throw new Error(
        `CLA version ${version} is already registered with different content. Increment cattr-cla-version before changing ${config.claPath}.`
      );
    }
    console.log(
      `${sourceRepository} CLA v${version} is already registered (${digest}).`
    );
    return;
  }
  if (existingSnapshot !== null && sha256(existingSnapshot) !== digest) {
    throw new Error(
      `CLA snapshot for version ${version} already exists with different content`
    );
  }
  if (existingSnapshot === null) {
    try {
      await writer.createFile(
        config.registryRepository,
        snapshotPath,
        cla,
        `chore(cla): register ${sourceRepository} v${version}`
      );
    } catch (error2) {
      if (!(error2 instanceof GitHubHttpError) || ![409, 422].includes(error2.status)) {
        throw error2;
      }
      const raced = await writer.getFile(
        config.registryRepository,
        snapshotPath
      );
      if (raced === null || sha256(raced) !== digest) {
        throw new Error(
          "CLA snapshot was created concurrently with different content"
        );
      }
    }
  }
  const sourceUrl = `https://github.com/${sourceRepository}/blob/${current.sha}/${config.claPath}`;
  const metadata = {
    repository_id: repo.id,
    repository: sourceRepository,
    version,
    sha256: digest,
    source_commit: current.sha,
    source_path: config.claPath,
    source_url: sourceUrl,
    source_committed_at: current.committedAt,
    registered_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    await writer.createFile(
      config.registryRepository,
      metadataPath,
      `${JSON.stringify(metadata, null, 2)}
`,
      `chore(cla): index ${sourceRepository} v${version}`
    );
  } catch (error2) {
    if (!(error2 instanceof GitHubHttpError) || ![409, 422].includes(error2.status)) {
      throw error2;
    }
    const raced = await readJson(
      writer,
      config.registryRepository,
      metadataPath
    );
    if (!raced || !validateAgreement(raced, repo.id, version, digest)) {
      throw new Error(
        "CLA metadata was created concurrently with different data"
      );
    }
  }
  console.log(`Registered ${sourceRepository} CLA v${version} (${digest}).`);
}

// src/index.ts
async function main() {
  const config = loadConfig();
  switch (config.operation) {
    case "check":
      await runCheck(config);
      return;
    case "sign":
      await runSign(config);
      return;
    case "claim":
      await runClaim(config);
      return;
    case "sync":
      await runSync(config);
      return;
    default:
      throw new Error(`Unknown CLA operation: ${config.operation}`);
  }
}
main().catch((reason) => {
  const message2 = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  error(message2);
  process.exitCode = 1;
});
