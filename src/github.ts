import { PullRequestInfo } from "./types";

export class GitHubHttpError extends Error {
    public readonly status: number;
    public readonly body: string;

    public constructor(status: number, body: string, message?: string) {
        super(message ?? `GitHub API request failed with HTTP ${status}`);
        this.status = status;
        this.body = body;
    }
}

function encodeContentPath(path: string): string {
    return path
        .split("/")
        .filter(Boolean)
        .map(part => encodeURIComponent(part))
        .join("/");
}

export class GitHubClient {
    private readonly token: string;

    public constructor(token: string) {
        if (!token) {
            throw new Error("GitHub token is required");
        }

        this.token = token;
    }

    private async request(
        method: string,
        path: string,
        body?: unknown,
        accept = "application/vnd.github+json",
    ): Promise<any> {
        const response = await fetch(`https://api.github.com${path}`, {
            method,
            headers: {
                Accept: accept,
                Authorization: `Bearer ${this.token}`,
                "Content-Type": "application/json",
                "User-Agent": "cattr-cla-actions",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        const text = await response.text();

        if (!response.ok) {
            throw new GitHubHttpError(response.status, text);
        }

        return text === "" ? null : JSON.parse(text);
    }

    public async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        const result = await this.request("POST", "/graphql", { query, variables });

        if (Array.isArray(result?.errors) && result.errors.length > 0) {
            throw new Error(`GitHub GraphQL error: ${JSON.stringify(result.errors)}`);
        }

        return result.data as T;
    }

    public async getPullRequest(repository: string, number: number): Promise<PullRequestInfo> {
        const pr = await this.request("GET", `/repos/${repository}/pulls/${number}`);

        return {
            number,
            state: String(pr.state),
            headSha: String(pr.head.sha),
            baseSha: String(pr.base.sha),
            repositoryId: Number(pr.base.repo.id),
        };
    }

    public async getRepository(repository: string): Promise<{ id: number; defaultBranch: string }> {
        const repo = await this.request("GET", `/repos/${repository}`);

        return {
            id: Number(repo.id),
            defaultBranch: String(repo.default_branch),
        };
    }

    public async getCommit(
        repository: string,
        ref: string,
    ): Promise<{ sha: string; committedAt: string }> {
        const commit = await this.request(
            "GET",
            `/repos/${repository}/commits/${encodeURIComponent(ref)}`,
        );

        return {
            sha: String(commit.sha),
            committedAt: String(commit.commit.committer.date),
        };
    }

    public async getUserId(login: string): Promise<number> {
        const user = await this.request("GET", `/users/${encodeURIComponent(login)}`);
        const id = Number(user.id);

        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new Error(`GitHub returned an invalid user ID for ${login}`);
        }

        return id;
    }

    public async getFile(
        repository: string,
        path: string,
        ref?: string,
    ): Promise<string | null> {
        const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";

        try {
            const file = await this.request(
                "GET",
                `/repos/${repository}/contents/${encodeContentPath(path)}${query}`,
            );

            if (!file || Array.isArray(file) || typeof file.content !== "string") {
                throw new Error(`Expected file at ${repository}:${path}`);
            }

            return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
        } catch (error) {
            if (error instanceof GitHubHttpError && error.status === 404) {
                return null;
            }

            throw error;
        }
    }

    public async getDirectory(
        repository: string,
        path: string,
    ): Promise<Array<{ name: string; path: string; type: string }> | null> {
        try {
            const value = await this.request(
                "GET",
                `/repos/${repository}/contents/${encodeContentPath(path)}`,
            );

            if (!Array.isArray(value)) {
                throw new Error(`Expected directory at ${repository}:${path}`);
            }

            return value.map((item: any) => ({
                name: String(item.name),
                path: String(item.path),
                type: String(item.type),
            }));
        } catch (error) {
            if (error instanceof GitHubHttpError && error.status === 404) {
                return null;
            }

            throw error;
        }
    }

    public async createFile(
        repository: string,
        path: string,
        content: string,
        message: string,
    ): Promise<void> {
        await this.request(
            "PUT",
            `/repos/${repository}/contents/${encodeContentPath(path)}`,
            {
                message,
                content: Buffer.from(content, "utf8").toString("base64"),
            },
        );
    }

    public async postComment(
        repository: string,
        issueNumber: number,
        body: string,
    ): Promise<void> {
        await this.request(
            "POST",
            `/repos/${repository}/issues/${issueNumber}/comments`,
            { body },
        );
    }

    public async upsertBotComment(
        repository: string,
        issueNumber: number,
        appSlug: string,
        marker: string,
        body: string,
    ): Promise<void> {
        const expectedLogin = `${appSlug}[bot]`;
        let page = 1;
        let commentId: number | null = null;

        while (commentId === null) {
            const comments = await this.request(
                "GET",
                `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
            );

            for (const comment of comments) {
                if (
                    comment?.user?.login === expectedLogin &&
                    typeof comment?.body === "string" &&
                    comment.body.includes(marker)
                ) {
                    commentId = Number(comment.id);
                    break;
                }
            }

            if (commentId !== null || comments.length < 100) {
                break;
            }

            page += 1;
        }

        if (commentId !== null) {
            await this.request(
                "PATCH",
                `/repos/${repository}/issues/comments/${commentId}`,
                { body },
            );
            return;
        }

        await this.postComment(repository, issueNumber, body);
    }

    public async upsertCheck(
        repository: string,
        headSha: string,
        appSlug: string,
        name: string,
        conclusion: "success" | "failure" | "action_required",
        title: string,
        detailsUrl: string,
        summary: string,
    ): Promise<void> {
        const result = await this.request(
            "GET",
            `/repos/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`,
            undefined,
            "application/vnd.github+json",
        );

        const existing = (result?.check_runs ?? []).find(
            (run: any) => run?.name === name && run?.app?.slug === appSlug,
        );

        const body = {
            status: "completed",
            conclusion,
            details_url: detailsUrl,
            output: {
                title,
                summary,
            },
        };

        if (existing) {
            await this.request(
                "PATCH",
                `/repos/${repository}/check-runs/${Number(existing.id)}`,
                body,
            );
            return;
        }

        await this.request(
            "POST",
            `/repos/${repository}/check-runs`,
            {
                name,
                head_sha: headSha,
                ...body,
            },
        );
    }
}
