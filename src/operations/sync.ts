import { Config } from "../config";
import { parseClaVersion, sha256 } from "../cla";
import { GitHubClient, GitHubHttpError } from "../github";
import {
    agreementDir,
    readJson,
    validateAgreement,
} from "../registry";
import { AgreementMetadata } from "../types";
import { repository } from "../runtime";

export async function runSync(config: Config): Promise<void> {
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
        current.sha,
    );

    if (cla === null) {
        throw new Error(
            `${config.claPath} does not exist on ${sourceRepository}:${repo.defaultBranch}`,
        );
    }

    const version = parseClaVersion(cla);
    const digest = sha256(cla);
    const directory = agreementDir(repo.id, version);
    const snapshotPath = `${directory}/CLA.md`;
    const metadataPath = `${directory}/metadata.json`;

    const existingMetadata = await readJson<AgreementMetadata>(
        writer,
        config.registryRepository,
        metadataPath,
    );
    const existingSnapshot = await writer.getFile(
        config.registryRepository,
        snapshotPath,
    );

    if (existingMetadata) {
        if (!validateAgreement(existingMetadata, repo.id, version, digest)) {
            throw new Error(
                `CLA version ${version} is already registered with different metadata. Increment cattr-cla-version before changing ${config.claPath}.`,
            );
        }

        if (existingSnapshot === null) {
            throw new Error(
                `CLA version ${version} has metadata but its CLA.md snapshot is missing`,
            );
        }

        if (sha256(existingSnapshot) !== digest) {
            throw new Error(
                `CLA version ${version} is already registered with different content. Increment cattr-cla-version before changing ${config.claPath}.`,
            );
        }

        console.log(
            `${sourceRepository} CLA v${version} is already registered (${digest}).`,
        );
        return;
    }

    if (existingSnapshot !== null && sha256(existingSnapshot) !== digest) {
        throw new Error(
            `CLA snapshot for version ${version} already exists with different content`,
        );
    }

    if (existingSnapshot === null) {
        try {
            await writer.createFile(
                config.registryRepository,
                snapshotPath,
                cla,
                `chore(cla): register ${sourceRepository} v${version}`,
            );
        } catch (error) {
            if (!(error instanceof GitHubHttpError) || ![409, 422].includes(error.status)) {
                throw error;
            }

            const raced = await writer.getFile(
                config.registryRepository,
                snapshotPath,
            );

            if (raced === null || sha256(raced) !== digest) {
                throw new Error(
                    "CLA snapshot was created concurrently with different content",
                );
            }
        }
    }

    const sourceUrl = `https://github.com/${sourceRepository}/blob/${current.sha}/${config.claPath}`;
    const metadata: AgreementMetadata = {
        repository_id: repo.id,
        repository: sourceRepository,
        version,
        sha256: digest,
        source_commit: current.sha,
        source_path: config.claPath,
        source_url: sourceUrl,
        source_committed_at: current.committedAt,
        registered_at: new Date().toISOString(),
    };

    try {
        await writer.createFile(
            config.registryRepository,
            metadataPath,
            `${JSON.stringify(metadata, null, 2)}\n`,
            `chore(cla): index ${sourceRepository} v${version}`,
        );
    } catch (error) {
        if (!(error instanceof GitHubHttpError) || ![409, 422].includes(error.status)) {
            throw error;
        }

        const raced = await readJson<AgreementMetadata>(
            writer,
            config.registryRepository,
            metadataPath,
        );

        if (!raced || !validateAgreement(raced, repo.id, version, digest)) {
            throw new Error(
                "CLA metadata was created concurrently with different data",
            );
        }
    }

    console.log(`Registered ${sourceRepository} CLA v${version} (${digest}).`);
}
