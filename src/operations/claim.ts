import { Config } from "../config";
import { GitHubClient, GitHubHttpError } from "../github";
import { collectPrContributors } from "../contributors";
import {
    claimPath,
    readJson,
    validateClaim,
} from "../registry";
import { ClaimRecord, IssueCommentEvent } from "../types";
import { readEvent, repository, shortSha } from "../runtime";
import { runCheck } from "./check";

async function reply(
    github: GitHubClient,
    repositoryName: string,
    prNumber: number,
    body: string,
): Promise<void> {
    await github.postComment(repositoryName, prNumber, body);
}

export async function runClaim(config: Config): Promise<void> {
    if (!config.botToken || !config.botAppSlug || !config.registryToken) {
        throw new Error("claim requires bot-token, bot-app-slug, and registry-token");
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

    const sourceRepository = repository();
    const bot = new GitHubClient(config.botToken);
    const writer = new GitHubClient(config.registryToken);

    if (config.exemptLogins.has(commenterLogin)) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            `@${commenterLogin} cannot create an authorship claim.`,
        );
        return;
    }

    const match = body.match(
        /^\/cla-claim\s+([0-9a-fA-F]{7,40})(?:\s+([0-9a-fA-F]{6,64}))?\s*$/,
    );

    if (!match) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            "Invalid claim command. Use `/cla-claim <commit> [identity]`.",
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
        config.exemptLogins,
    );

    const matchingCommits = [
        ...new Set(
            raw.unresolved
                .filter(actor => actor.commit.toLowerCase().startsWith(commitPrefix))
                .map(actor => actor.commit),
        ),
    ];

    if (matchingCommits.length === 0) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            `No unresolved contributor identity matches commit \`${commitPrefix}\`.`,
        );
        return;
    }

    if (matchingCommits.length !== 1) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            `Commit prefix \`${commitPrefix}\` is ambiguous. Use a longer commit SHA.`,
        );
        return;
    }

    const commitSha = matchingCommits[0];
    let actors = raw.unresolved.filter(actor => actor.commit === commitSha);

    if (identityPrefix) {
        actors = actors.filter(actor =>
            actor.identityKey.toLowerCase().startsWith(identityPrefix),
        );
    }

    if (actors.length === 0) {
        await reply(
            bot,
            sourceRepository,
            prNumber,
            "No unresolved identity matches the supplied claim selector.",
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
                actor =>
                    `- \`${actor.name}\`: \`/cla-claim ${shortSha(commitSha)} ${actor.identityKey.slice(0, 12)}\``,
            ),
        ];

        await reply(bot, sourceRepository, prNumber, lines.join("\n"));
        return;
    }

    const actor = actors[0];
    const path = claimPath(
        pr.repositoryId,
        commitSha,
        actor.identityKey,
        commenterId,
    );

    const existing = await readJson<ClaimRecord>(
        bot,
        config.registryRepository,
        path,
    );

    if (existing) {
        if (
            !validateClaim(
                existing,
                commenterId,
                pr.repositoryId,
                commitSha,
                actor.identityKey,
            )
        ) {
            await reply(
                bot,
                sourceRepository,
                prNumber,
                "Your existing authorship claim is inconsistent. Maintainer action is required.",
            );
            process.exitCode = 1;
            return;
        }

        console.log(`Claim already exists for @${commenterLogin}.`);
        process.env.CLA_PR_NUMBER = String(prNumber);
        await runCheck(config);
        return;
    }

    const claim: ClaimRecord = {
        github_user_id: commenterId,
        github_login: commenterLogin,
        repository_id: pr.repositoryId,
        repository: sourceRepository,
        commit_sha: commitSha,
        identity: {
            key: actor.identityKey,
            name: actor.name,
        },
        claimed_at: commentCreatedAt,
        evidence: {
            pull_request: prNumber,
            comment_id: commentId,
            comment_url: commentUrl,
            command: body,
        },
    };

    try {
        await writer.createFile(
            config.registryRepository,
            path,
            `${JSON.stringify(claim, null, 2)}\n`,
            `chore(cla): record authorship claim by ${commenterLogin}`,
        );
    } catch (error) {
        if (!(error instanceof GitHubHttpError) || ![409, 422].includes(error.status)) {
            throw error;
        }

        const raced = await readJson<ClaimRecord>(
            bot,
            config.registryRepository,
            path,
        );

        if (
            !raced ||
            !validateClaim(
                raced,
                commenterId,
                pr.repositoryId,
                commitSha,
                actor.identityKey,
            )
        ) {
            await reply(
                bot,
                sourceRepository,
                prNumber,
                "The authorship claim path was created concurrently with different data. Maintainer action is required.",
            );
            process.exitCode = 1;
            return;
        }
    }

    await reply(
        bot,
        sourceRepository,
        prNumber,
        `@${commenterLogin} claimed authorship of \`${shortSha(commitSha)}\` as \`${actor.name}\`. This identifies the contributor but does not itself accept the CLA. If required, now post \`/cla-sign <version>\`.`,
    );

    process.env.CLA_PR_NUMBER = String(prNumber);
    await runCheck(config);
}
