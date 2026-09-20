import test from "node:test";
import assert from "node:assert/strict";

import {
    identityKey,
    parseClaVersion,
    resolveEffectiveCla,
    sha256,
} from "../src/cla";

test("parseClaVersion reads exactly one positive integer marker", () => {
    assert.equal(
        parseClaVersion("<!-- cattr-cla-version: 7 -->\n# CLA\n"),
        7,
    );
});

test("parseClaVersion rejects multiple markers", () => {
    assert.throws(
        () =>
            parseClaVersion(
                "<!-- cattr-cla-version: 1 -->\n<!-- cattr-cla-version: 2 -->",
            ),
        /exactly one/,
    );
});

test("parseClaVersion rejects missing marker", () => {
    assert.throws(() => parseClaVersion("# CLA"), /exactly one/);
});

test("sha256 is deterministic", () => {
    assert.equal(sha256("abc"), sha256("abc"));
    assert.notEqual(sha256("abc"), sha256("abcd"));
});

test("identityKey separates name and email with a NUL byte", () => {
    assert.equal(
        identityKey("Alice", "alice@example.com"),
        identityKey("Alice", "alice@example.com"),
    );

    assert.notEqual(
        identityKey("Alice", "alice@example.com"),
        identityKey("Alicea", "lice@example.com"),
    );
});

test("resolveEffectiveCla uses the trusted PR base when CLA exists there", async () => {
    const calls: string[] = [];
    const github = {
        async getFile(_repository: string, _path: string, ref?: string) {
            calls.push(`file:${ref}`);
            return "# base CLA";
        },
        async getCommit(_repository: string, ref: string) {
            calls.push(`commit:${ref}`);
            return { sha: "current-base-sha", committedAt: "2026-09-20T00:00:00Z" };
        },
    };

    const result = await resolveEffectiveCla(
        github,
        "cattr-app/server-application",
        "CLA.md",
        { baseSha: "old-base-sha", baseRef: "main" },
    );

    assert.deepEqual(calls, ["file:old-base-sha"]);
    assert.equal(result?.content, "# base CLA");
    assert.equal(result?.sourceSha, "old-base-sha");
    assert.match(result?.sourceUrl ?? "", /blob\/old-base-sha\/CLA\.md$/);
});

test("resolveEffectiveCla falls back to a pinned current target branch commit", async () => {
    const calls: string[] = [];
    const github = {
        async getFile(_repository: string, _path: string, ref?: string) {
            calls.push(`file:${ref}`);
            return ref === "current-base-sha" ? "# current CLA" : null;
        },
        async getCommit(_repository: string, ref: string) {
            calls.push(`commit:${ref}`);
            return { sha: "current-base-sha", committedAt: "2026-09-20T00:00:00Z" };
        },
    };

    const result = await resolveEffectiveCla(
        github,
        "cattr-app/server-application",
        "CLA.md",
        { baseSha: "pre-cla-base-sha", baseRef: "main" },
    );

    assert.deepEqual(calls, [
        "file:pre-cla-base-sha",
        "commit:main",
        "file:current-base-sha",
    ]);
    assert.equal(result?.content, "# current CLA");
    assert.equal(result?.sourceSha, "current-base-sha");
    assert.match(result?.sourceUrl ?? "", /blob\/current-base-sha\/CLA\.md$/);
});

test("resolveEffectiveCla returns null when CLA is absent from base and target branch", async () => {
    const github = {
        async getFile() {
            return null;
        },
        async getCommit() {
            return { sha: "current-base-sha", committedAt: "2026-09-20T00:00:00Z" };
        },
    };

    const result = await resolveEffectiveCla(
        github,
        "cattr-app/server-application",
        "CLA.md",
        { baseSha: "pre-cla-base-sha", baseRef: "main" },
    );

    assert.equal(result, null);
});
