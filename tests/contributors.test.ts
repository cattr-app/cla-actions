import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config";
import { collectPrContributors } from "../src/contributors";
import { GitHubClient } from "../src/github";

function actor(name: string, email: string, login: string | null = null) {
    return { name, email, user: login ? { login } : null };
}

function makeGithub(
    commits: Array<{ oid: string; authors: ReturnType<typeof actor>[] }>,
) {
    const lookedUp: string[] = [];
    const github = {
        async graphql() {
            return {
                repository: {
                    pullRequest: {
                        commits: {
                            nodes: commits.map(commit => ({
                                commit: {
                                    oid: commit.oid,
                                    authors: {
                                        nodes: commit.authors,
                                        pageInfo: { hasNextPage: false, endCursor: null },
                                    },
                                },
                            })),
                            pageInfo: { hasNextPage: false, endCursor: null },
                        },
                    },
                },
            };
        },
        async getUserId(login: string) {
            lookedUp.push(login);
            return login === "human" ? 1 : 2;
        },
    };
    return { github: github as unknown as GitHubClient, lookedUp };
}

test("email whitelist skips only matching co-authors, resolved or unresolved", async () => {
    const { github, lookedUp } = makeGithub([{
        oid: "abc123",
        authors: [
            actor("Human", "human@example.com", "human"),
            actor("Codex", "NOREPLY@OPENAI.COM", "agent"),
            actor("Claude", "noreply@anthropic.com"),
            actor("Someone else", "other@example.com"),
        ],
    }]);

    const result = await collectPrContributors(
        github,
        "cattr-app/server-application",
        42,
        new Set(),
        new Set(["noreply@openai.com", "noreply@anthropic.com"]),
    );

    assert.deepEqual(lookedUp, ["human"]);
    assert.deepEqual(result.contributors.map(person => person.githubLogin), ["human"]);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0].name, "Someone else");
});

test("whitelisted email is still checked when it is the primary Git author", async () => {
    const { github } = makeGithub([{
        oid: "abc123",
        authors: [actor("Main author", "noreply@openai.com", "human")],
    }]);

    const result = await collectPrContributors(
        github,
        "cattr-app/server-application",
        42,
        new Set(),
        new Set(["noreply@openai.com"]),
    );

    assert.equal(result.contributors.length, 1);
    assert.equal(result.contributors[0].githubUserId, 1);
});

test("co-authors without an explicit exemption still require CLA", async () => {
    const { github } = makeGithub([{
        oid: "abc123",
        authors: [actor("Human", "human@example.com", "human"), actor("Codex", "noreply@openai.com", "agent")],
    }]);

    const result = await collectPrContributors(
        github,
        "cattr-app/server-application",
        42,
        new Set(),
        new Set(),
    );

    assert.deepEqual(result.contributors.map(person => person.githubLogin), ["human", "agent"]);
});

test("whitelisted co-author on a later authors page is excluded", async () => {
    const github = {
        async graphql(_query: string, variables: Record<string, unknown>) {
            if ("oid" in variables) {
                return {
                    repository: {
                        object: {
                            authors: {
                                nodes: [actor("Claude", "noreply@anthropic.com")],
                                pageInfo: { hasNextPage: false, endCursor: null },
                            },
                        },
                    },
                };
            }
            return {
                repository: {
                    pullRequest: {
                        commits: {
                            nodes: [{
                                commit: {
                                    oid: "abc123",
                                    authors: {
                                        nodes: [actor("Human", "human@example.com", "human")],
                                        pageInfo: { hasNextPage: true, endCursor: "page-2" },
                                    },
                                },
                            }],
                            pageInfo: { hasNextPage: false, endCursor: null },
                        },
                    },
                },
            };
        },
        async getUserId() { return 1; },
    } as unknown as GitHubClient;

    const result = await collectPrContributors(
        github, "cattr-app/server-application", 42, new Set(), new Set(["noreply@anthropic.com"]),
    );
    assert.deepEqual(result.contributors.map(person => person.githubLogin), ["human"]);
    assert.deepEqual(result.unresolved, []);
});

test("loadConfig normalizes newline-separated co-author addresses", () => {
    const oldOperation = process.env.INPUT_OPERATION;
    const oldEmails = process.env.CLA_EXEMPT_COAUTHOR_EMAILS;
    try {
        process.env.INPUT_OPERATION = "check";
        process.env.CLA_EXEMPT_COAUTHOR_EMAILS = "  NOREPLY@OPENAI.COM  \n\n cursoragent@cursor.com  ";
        assert.deepEqual([...loadConfig().exemptCoauthorEmails], ["noreply@openai.com", "cursoragent@cursor.com"]);
    } finally {
        if (oldOperation === undefined) delete process.env.INPUT_OPERATION;
        else process.env.INPUT_OPERATION = oldOperation;
        if (oldEmails === undefined) delete process.env.CLA_EXEMPT_COAUTHOR_EMAILS;
        else process.env.CLA_EXEMPT_COAUTHOR_EMAILS = oldEmails;
    }
});
