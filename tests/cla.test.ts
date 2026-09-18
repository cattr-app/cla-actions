import test from "node:test";
import assert from "node:assert/strict";

import { identityKey, parseClaVersion, sha256 } from "../src/cla";

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
