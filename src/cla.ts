const crypto = require("crypto");

const VERSION_PATTERN = /cattr-cla-version:\s*([0-9]+)/g;

export function parseClaVersion(content: string): number {
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

export function sha256(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function identityKey(name: string, email: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(name, "utf8");
    hash.update(Buffer.from("\0", "utf8"));
    hash.update(email, "utf8");
    return hash.digest("hex");
}

interface ClaSourceReader {
    getFile(
        repository: string,
        path: string,
        ref?: string,
    ): Promise<string | null>;
    getCommit(
        repository: string,
        ref: string,
    ): Promise<{ sha: string; committedAt: string }>;
}

interface ClaPullRequestBase {
    baseSha: string;
    baseRef: string;
}

export interface EffectiveCla {
    content: string;
    sourceSha: string;
    sourceUrl: string;
}

export async function resolveEffectiveCla(
    github: ClaSourceReader,
    repository: string,
    claPath: string,
    pr: ClaPullRequestBase,
): Promise<EffectiveCla | null> {
    let sourceSha = pr.baseSha;
    let content = await github.getFile(repository, claPath, sourceSha);

    if (content === null) {
        const currentBase = await github.getCommit(repository, pr.baseRef);
        sourceSha = currentBase.sha;
        content = await github.getFile(repository, claPath, sourceSha);
    }

    if (content === null) {
        return null;
    }

    return {
        content,
        sourceSha,
        sourceUrl: `https://github.com/${repository}/blob/${sourceSha}/${claPath}`,
    };
}
