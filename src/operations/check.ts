import { Config } from "../config";
import { parseClaVersion, sha256 } from "../cla";
import { GitHubClient } from "../github";
import { applyClaims, collectPrContributors } from "../contributors";
import {
    acceptancePath,
    agreementDir,
    readJson,
    validateAcceptance,
    validateAgreement,
} from "../registry";
import {
    AcceptanceRecord,
    AgreementMetadata,
    CheckResult,
    ContributorSet,
} from "../types";
import { readEvent, repository, shortSha } from "../runtime";

const COMMENT_MARKER = "<!-- cattr-cla-bot -->";
const CHECK_NAME = "Cattr CLA";

function prNumberFromEvent(): number {
    const override = process.env.CLA_PR_NUMBER;

    if (override && /^[0-9]+$/.test(override)) {
        return Number(override);
    }

    const event = readEvent<any>();
    const value = event?.pull_request?.number ?? event?.issue?.number;

    if (!Number.isSafeInteger(Number(value))) {
        throw new Error("Unable to determine pull request number");
    }

    return Number(value);
}

function message(result: CheckResult): string {
    return `${COMMENT_MARKER}\n${result.body.trim()}\n`;
}

async function report(
    github: GitHubClient,
    repositoryName: string,
    prNumber: number,
    headSha: string,
    appSlug: string,
    claUrl: string,
    result: CheckResult,
): Promise<void> {
    const body = message(result);

    await github.upsertCheck(
        repositoryName,
        headSha,
        appSlug,
        CHECK_NAME,
        result.conclusion,
        result.title,
        claUrl,
        body,
    );

    await github.upsertBotComment(
        repositoryName,
        prNumber,
        appSlug,
        COMMENT_MARKER,
        body,
    );
}

function renderContributorStatus(
    accepted: string[],
    missing: string[],
    contributors: ContributorSet,
    version: number,
    digest: string,
    claUrl: string,
): string {
    const lines: string[] = [
        "### Contributor License Agreement",
        "",
        `This pull request is governed by [Cattr CLA version ${version}](${claUrl}).`,
        "",
    ];

    if (accepted.length > 0) {
        lines.push("**Accepted:**", "");
        for (const login of accepted) {
            lines.push(`- ✅ @${login}`);
        }
        lines.push("");
    }

    if (missing.length > 0) {
        lines.push("**Still needs to accept:**", "");
        for (const login of missing) {
            lines.push(`- ⏳ @${login}`);
        }
        lines.push(
            "",
            "Each contributor above must post:",
            "",
            "```text",
            `/cla-sign ${version}`,
            "```",
            "",
        );
    }

    if (contributors.unresolved.length > 0) {
        lines.push("**Unresolved commit authors:**", "");

        for (const actor of contributors.unresolved) {
            lines.push(
                `- ⚠️ \`${actor.name}\` — commit \`${shortSha(actor.commit)}\``,
                `  - Claim: \`/cla-claim ${shortSha(actor.commit)} ${actor.identityKey.slice(0, 12)}\``,
            );
        }

        lines.push(
            "",
            "Only claim an identity if you actually authored or co-authored that commit.",
            "A claim identifies the contributor; it does not itself accept the CLA.",
            "",
        );
    }

    lines.push(`CLA SHA-256: \`${digest}\``);
    return lines.join("\n");
}

export async function runCheck(config: Config): Promise<void> {
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

    const claUrl = `https://github.com/${sourceRepository}/blob/${pr.baseSha}/${config.claPath}`;
    const cla = await github.getFile(sourceRepository, config.claPath, pr.baseSha);

    if (cla === null) {
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
                    "❌ The CLA could not be loaded from the trusted base revision of this pull request.",
                    "",
                    "Maintainer action is required.",
                ].join("\n"),
            },
        );
        return;
    }

    let version: number;

    try {
        version = parseClaVersion(cla);
    } catch (error) {
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
                    `❌ \`${config.claPath}\` must contain exactly one valid \`cattr-cla-version\` marker.`,
                    "",
                    "Maintainer action is required.",
                ].join("\n"),
            },
        );
        return;
    }

    const digest = sha256(cla);
    const metadata = await readJson<AgreementMetadata>(
        github,
        config.registryRepository,
        `${agreementDir(pr.repositoryId, version)}/metadata.json`,
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
                    `❌ CLA version **${version}** is not registered in the Cattr CLA registry.`,
                    "",
                    "Maintainer action is required.",
                ].join("\n"),
            },
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
                    `❌ The registered CLA metadata does not match the effective \`${config.claPath}\`.`,
                    "",
                    `Version: **${version}**`,
                    `SHA-256: \`${digest}\``,
                    "",
                    "Maintainer action is required.",
                ].join("\n"),
            },
        );
        return;
    }

    const raw = await collectPrContributors(
        github,
        sourceRepository,
        prNumber,
        config.exemptLogins,
    );

    const contributors = await applyClaims(
        github,
        config.registryRepository,
        pr.repositoryId,
        raw,
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
                    "❌ Conflicting or invalid authorship claims were detected.",
                    "",
                    "Maintainer action is required.",
                ].join("\n"),
            },
        );
        return;
    }

    if (
        contributors.contributors.length === 0 &&
        contributors.unresolved.length === 0 &&
        contributors.exempt.length > 0
    ) {
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
                    "✅ CLA acceptance is not required for this pull request.",
                    "",
                    "**Exempt automation:**",
                    "",
                    ...contributors.exempt.map(
                        contributor => `- 🤖 \`${contributor.githubLogin}\``,
                    ),
                ].join("\n"),
            },
        );
        return;
    }

    if (
        contributors.contributors.length === 0 &&
        contributors.unresolved.length === 0 &&
        contributors.exempt.length === 0
    ) {
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
                    "❌ No contributors could be determined for this pull request.",
                    "",
                    "Maintainer action is required.",
                ].join("\n"),
            },
        );
        return;
    }

    const accepted: string[] = [];
    const missing: string[] = [];
    const invalid: string[] = [];

    for (const contributor of contributors.contributors) {
        const path = acceptancePath(
            contributor.githubUserId,
            pr.repositoryId,
            version,
        );

        const acceptance = await readJson<AcceptanceRecord>(
            github,
            config.registryRepository,
            path,
        );

        if (!acceptance) {
            missing.push(contributor.githubLogin);
            continue;
        }

        if (
            !validateAcceptance(
                acceptance,
                contributor.githubUserId,
                pr.repositoryId,
                version,
                digest,
            )
        ) {
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
                    "❌ One or more CLA acceptance records are inconsistent.",
                    "",
                    "Affected contributors:",
                    "",
                    ...invalid.map(login => `- @${login}`),
                    "",
                    "Maintainer action is required.",
                ].join("\n"),
            },
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
                    claUrl,
                ),
            },
        );
        return;
    }

    const lines = [
        "### Contributor License Agreement",
        "",
        `✅ Every human contributor has accepted [Cattr CLA version ${version}](${claUrl}).`,
        "",
        ...accepted.map(login => `- ✅ @${login}`),
    ];

    if (contributors.exempt.length > 0) {
        lines.push("", "**Exempt automation:**", "");
        for (const exempt of contributors.exempt) {
            lines.push(`- 🤖 \`${exempt.githubLogin}\``);
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
            body: lines.join("\n"),
        },
    );
}
