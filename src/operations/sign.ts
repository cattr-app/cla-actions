import { Config } from "../config";
import { parseClaVersion, resolveEffectiveCla, sha256 } from "../cla";
import { GitHubClient, GitHubHttpError } from "../github";
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
    IssueCommentEvent,
} from "../types";
import {
    readEvent,
    repository,
    workflowRunAttempt,
    workflowRunId,
} from "../runtime";
import { runCheck } from "./check";

async function reply(
    github: GitHubClient,
    repositoryName: string,
    prNumber: number,
    body: string,
): Promise<void> {
    await github.postComment(repositoryName, prNumber, body);
}

export async function runSign(config: Config): Promise<void> {
    if (!config.botToken || !config.botAppSlug || !config.registryToken) {
        throw new Error("sign requires bot-token, bot-app-slug, and registry-token");
    }

    const event = readEvent<IssueCommentEvent>();
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
            "Invalid CLA command. Use exactly: `/cla-sign <version>`.",
        );
        return;
    }

    if (config.exemptLogins.has(commenterLogin)) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            `@${commenterLogin} is exempt from CLA acceptance.`,
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
        config.exemptLogins,
    );
    const contributors = await applyClaims(
        bot,
        config.registryRepository,
        pr.repositoryId,
        raw,
    );

    if (contributors.claimConflicts.length > 0) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            "Conflicting authorship claims exist for this pull request. Maintainer action is required.",
        );
        process.exitCode = 1;
        return;
    }

    const contributor = contributors.contributors.find(
        value => value.githubUserId === commenterId,
    );

    if (!contributor) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            `@${commenterLogin} is not currently associated with a contribution in this pull request. If your Git identity is unresolved, use the \`/cla-claim\` command shown by the CLA check first.`,
        );
        return;
    }

    const effectiveCla = await resolveEffectiveCla(
        bot,
        sourceRepository,
        config.claPath,
        pr,
    );
    const claUrl =
        effectiveCla?.sourceUrl ??
        `https://github.com/${sourceRepository}/blob/${pr.baseSha}/${config.claPath}`;

    if (effectiveCla === null) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            "The CLA could not be loaded. Maintainer action is required.",
        );
        process.exitCode = 1;
        return;
    }

    const cla = effectiveCla.content;
    let version: number;

    try {
        version = parseClaVersion(cla);
    } catch {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            "The CLA contains invalid version metadata. Maintainer action is required.",
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
            `CLA version **${version}** is currently in effect for this pull request. Read [the agreement](${claUrl}) and use \`/cla-sign ${version}\`.`,
        );
        return;
    }

    const metadata = await readJson<AgreementMetadata>(
        bot,
        config.registryRepository,
        `${agreementDir(pr.repositoryId, version)}/metadata.json`,
    );

    if (
        !metadata ||
        !validateAgreement(metadata, pr.repositoryId, version, digest)
    ) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            "The effective CLA does not match its registered snapshot. Maintainer action is required.",
        );
        process.exitCode = 1;
        return;
    }

    const path = acceptancePath(commenterId, pr.repositoryId, version);
    const existing = await readJson<AcceptanceRecord>(
        bot,
        config.registryRepository,
        path,
    );

    if (existing) {
        if (
            !validateAcceptance(
                existing,
                commenterId,
                pr.repositoryId,
                version,
                digest,
            )
        ) {
            await reply(
                bot,
                sourceRepository,
                prNumber,
                "An inconsistent CLA acceptance record already exists. Maintainer action is required.",
            );
            process.exitCode = 1;
            return;
        }

        console.log(
            `CLA acceptance already exists for @${commenterLogin}; refreshing PR check.`,
        );

        process.env.CLA_PR_NUMBER = String(prNumber);
        await runCheck(config);
        return;
    }

    const acceptance: AcceptanceRecord = {
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
            workflow_run_attempt: workflowRunAttempt(),
        },
    };

    try {
        await writer.createFile(
            config.registryRepository,
            path,
            `${JSON.stringify(acceptance, null, 2)}\n`,
            `chore(cla): record ${commenterLogin} acceptance for ${sourceRepository} v${version}`,
        );
    } catch (error) {
        if (!(error instanceof GitHubHttpError) || ![409, 422].includes(error.status)) {
            throw error;
        }

        const raced = await readJson<AcceptanceRecord>(
            bot,
            config.registryRepository,
            path,
        );

        if (
            !raced ||
            !validateAcceptance(
                raced,
                commenterId,
                pr.repositoryId,
                version,
                digest,
            )
        ) {
            await reply(
                bot,
                sourceRepository,
                prNumber,
                "The CLA acceptance path was created concurrently with different data. Maintainer action is required.",
            );
            process.exitCode = 1;
            return;
        }
    }

    console.log(`Recorded CLA acceptance for @${commenterLogin}.`);

    process.env.CLA_PR_NUMBER = String(prNumber);
    await runCheck(config);
}
