import { GitHubClient } from "./github";
import {
    AcceptanceRecord,
    AgreementMetadata,
    ClaimRecord,
} from "./types";

export function agreementDir(repositoryId: number, version: number): string {
    return `agreements/${repositoryId}/${version}`;
}

export function acceptancePath(
    userId: number,
    repositoryId: number,
    version: number,
): string {
    return `acceptances/${userId}/${repositoryId}/${version}.json`;
}

export function claimDir(
    repositoryId: number,
    commitSha: string,
    identityKey: string,
): string {
    return `claims/${repositoryId}/${commitSha}/${identityKey}`;
}

export function claimPath(
    repositoryId: number,
    commitSha: string,
    identityKey: string,
    userId: number,
): string {
    return `${claimDir(repositoryId, commitSha, identityKey)}/${userId}.json`;
}

export async function readJson<T>(
    github: GitHubClient,
    repository: string,
    path: string,
): Promise<T | null> {
    const content = await github.getFile(repository, path);

    if (content === null) {
        return null;
    }

    return JSON.parse(content) as T;
}

export function validateAgreement(
    value: AgreementMetadata,
    repositoryId: number,
    version: number,
    digest: string,
): boolean {
    return (
        value.repository_id === repositoryId &&
        value.version === version &&
        value.sha256 === digest
    );
}

export function validateAcceptance(
    value: AcceptanceRecord,
    userId: number,
    repositoryId: number,
    version: number,
    digest: string,
): boolean {
    return (
        value.github_user_id === userId &&
        value.repository_id === repositoryId &&
        value.cla_version === version &&
        value.cla_sha256 === digest
    );
}

export function validateClaim(
    value: ClaimRecord,
    userId: number,
    repositoryId: number,
    commitSha: string,
    identityKey: string,
): boolean {
    return (
        value.github_user_id === userId &&
        value.repository_id === repositoryId &&
        value.commit_sha === commitSha &&
        value.identity.key === identityKey
    );
}
