export interface PullRequestInfo {
    number: number;
    state: string;
    headSha: string;
    baseSha: string;
    repositoryId: number;
}

export interface ResolvedContributor {
    githubUserId: number;
    githubLogin: string;
    names: string[];
    commits: string[];
    claimedIdentities: string[];
}

export interface UnresolvedIdentity {
    name: string;
    commit: string;
    identityKey: string;
}

export interface ExemptContributor {
    githubLogin: string;
    commits: string[];
}

export interface ClaimConflict {
    commit: string;
    identityKey: string;
    reason: "multiple-claims" | "invalid-claim";
}

export interface ContributorSet {
    contributors: ResolvedContributor[];
    unresolved: UnresolvedIdentity[];
    exempt: ExemptContributor[];
    claimConflicts: ClaimConflict[];
}

export interface RawContributorSet {
    contributors: ResolvedContributor[];
    unresolved: UnresolvedIdentity[];
    exempt: ExemptContributor[];
}

export interface AgreementMetadata {
    repository_id: number;
    repository: string;
    version: number;
    sha256: string;
    source_commit: string;
    source_path: string;
    source_url: string;
    source_committed_at: string;
    registered_at: string;
}

export interface AcceptanceRecord {
    github_user_id: number;
    github_login: string;
    repository_id: number;
    repository: string;
    cla_version: number;
    cla_sha256: string;
    accepted_at: string;
    evidence: {
        pull_request: number;
        comment_id: number;
        comment_url: string;
        command: string;
        source_commit: string;
        source_path: string;
        source_url: string;
        workflow_run_id: number;
        workflow_run_attempt: number;
    };
}

export interface ClaimRecord {
    github_user_id: number;
    github_login: string;
    repository_id: number;
    repository: string;
    commit_sha: string;
    identity: {
        key: string;
        name: string;
    };
    claimed_at: string;
    evidence: {
        pull_request: number;
        comment_id: number;
        comment_url: string;
        command: string;
    };
}

export interface IssueCommentEvent {
    issue?: {
        number?: number;
        pull_request?: unknown;
    };
    comment?: {
        id?: number;
        body?: string;
        html_url?: string;
        created_at?: string;
        user?: {
            id?: number;
            login?: string;
        };
    };
}

export interface CheckResult {
    conclusion: "success" | "failure" | "action_required";
    title: string;
    body: string;
    exitCode?: number;
}
