import { identityKey } from "./cla";
import { GitHubClient } from "./github";
import {
    ClaimRecord,
    ContributorSet,
    ExemptContributor,
    RawContributorSet,
    ResolvedContributor,
    UnresolvedIdentity,
} from "./types";
import { claimDir, readJson, validateClaim } from "./registry";

interface Actor {
    commit: string;
    name: string;
    email: string;
    login: string | null;
}

interface PullRequestCommitsPage {
    repository: {
        pullRequest: {
            commits: {
                nodes: Array<{
                    commit: {
                        oid: string;
                        authors: {
                            nodes: Array<{
                                name: string | null;
                                email: string | null;
                                user: { login: string } | null;
                            }>;
                            pageInfo: {
                                hasNextPage: boolean;
                                endCursor: string | null;
                            };
                        };
                    };
                }>;
                pageInfo: {
                    hasNextPage: boolean;
                    endCursor: string | null;
                };
            };
        } | null;
    };
}

interface CommitAuthorsPage {
    repository: {
        object: {
            oid: string;
            authors: {
                nodes: Array<{
                    name: string | null;
                    email: string | null;
                    user: { login: string } | null;
                }>;
                pageInfo: {
                    hasNextPage: boolean;
                    endCursor: string | null;
                };
            };
        } | null;
    };
}

const PR_COMMITS_QUERY = `
query(
  $owner: String!
  $name: String!
  $number: Int!
  $after: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $after) {
        nodes {
          commit {
            oid
            authors(first: 100) {
              nodes {
                name
                email
                user {
                  login
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

const COMMIT_AUTHORS_QUERY = `
query(
  $owner: String!
  $name: String!
  $oid: GitObjectID!
  $after: String
) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        oid
        authors(first: 100, after: $after) {
          nodes {
            name
            email
            user {
              login
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
}
`;

function splitRepository(repository: string): [string, string] {
    const index = repository.indexOf("/");

    if (index <= 0 || index === repository.length - 1) {
        throw new Error(`Invalid repository name: ${repository}`);
    }

    return [repository.slice(0, index), repository.slice(index + 1)];
}

function mergeContributor(
    map: Map<number, ResolvedContributor>,
    contributor: ResolvedContributor,
): void {
    const current = map.get(contributor.githubUserId);

    if (!current) {
        map.set(contributor.githubUserId, {
            githubUserId: contributor.githubUserId,
            githubLogin: contributor.githubLogin,
            names: [...new Set(contributor.names)],
            commits: [...new Set(contributor.commits)],
            claimedIdentities: [...new Set(contributor.claimedIdentities)],
        });
        return;
    }

    current.githubLogin = contributor.githubLogin;
    current.names = [...new Set([...current.names, ...contributor.names])];
    current.commits = [...new Set([...current.commits, ...contributor.commits])];
    current.claimedIdentities = [
        ...new Set([...current.claimedIdentities, ...contributor.claimedIdentities]),
    ];
}

function pushActor(actors: Actor[], commit: string, node: any): void {
    actors.push({
        commit,
        name: String(node?.name ?? ""),
        email: String(node?.email ?? ""),
        login: node?.user?.login ? String(node.user.login) : null,
    });
}

export async function collectPrContributors(
    github: GitHubClient,
    repository: string,
    prNumber: number,
    exemptLogins: Set<string>,
): Promise<RawContributorSet> {
    const [owner, name] = splitRepository(repository);
    const actors: Actor[] = [];
    let cursor: string | null = null;

    do {
        const page: PullRequestCommitsPage = await github.graphql<PullRequestCommitsPage>(
            PR_COMMITS_QUERY,
            {
                owner,
                name,
                number: prNumber,
                after: cursor,
            },
        );

        const pullRequest: PullRequestCommitsPage["repository"]["pullRequest"] = page.repository.pullRequest;

        if (!pullRequest) {
            throw new Error(`Pull request #${prNumber} could not be queried`);
        }

        for (const node of pullRequest.commits.nodes) {
            const commit = node.commit;

            for (const actor of commit.authors.nodes) {
                pushActor(actors, commit.oid, actor);
            }

            let authorCursor = commit.authors.pageInfo.endCursor;

            while (commit.authors.pageInfo.hasNextPage && authorCursor) {
                const authorPage = await github.graphql<CommitAuthorsPage>(
                    COMMIT_AUTHORS_QUERY,
                    {
                        owner,
                        name,
                        oid: commit.oid,
                        after: authorCursor,
                    },
                );

                const object = authorPage.repository.object;

                if (!object) {
                    throw new Error(`Commit ${commit.oid} could not be queried`);
                }

                for (const actor of object.authors.nodes) {
                    pushActor(actors, commit.oid, actor);
                }

                if (!object.authors.pageInfo.hasNextPage) {
                    break;
                }

                authorCursor = object.authors.pageInfo.endCursor;
            }
        }

        cursor = pullRequest.commits.pageInfo.hasNextPage
            ? pullRequest.commits.pageInfo.endCursor
            : null;
    } while (cursor);

    if (actors.length === 0) {
        throw new Error(`No contributors could be discovered for PR #${prNumber}`);
    }

    const contributorMap = new Map<number, ResolvedContributor>();
    const unresolvedMap = new Map<string, UnresolvedIdentity>();
    const exemptMap = new Map<string, ExemptContributor>();

    const resolvedLogins = [...new Set(
        actors
            .map(actor => actor.login)
            .filter((login): login is string => login !== null),
    )];

    const userIds = new Map<string, number>();

    for (const login of resolvedLogins) {
        if (exemptLogins.has(login)) {
            continue;
        }

        try {
            userIds.set(login, await github.getUserId(login));
        } catch {
            // Treat a login that cannot be resolved to a numeric GitHub ID as
            // unresolved instead of silently excluding it.
        }
    }

    for (const actor of actors) {
        if (actor.login && exemptLogins.has(actor.login)) {
            const current = exemptMap.get(actor.login) ?? {
                githubLogin: actor.login,
                commits: [],
            };

            current.commits = [...new Set([...current.commits, actor.commit])];
            exemptMap.set(actor.login, current);
            continue;
        }

        if (actor.login && userIds.has(actor.login)) {
            const id = userIds.get(actor.login)!;

            mergeContributor(contributorMap, {
                githubUserId: id,
                githubLogin: actor.login,
                names: actor.name ? [actor.name] : [],
                commits: [actor.commit],
                claimedIdentities: [],
            });
            continue;
        }

        const key = identityKey(actor.name, actor.email);
        const composite = `${actor.commit}:${key}`;

        unresolvedMap.set(composite, {
            name: actor.name || "Unknown author",
            commit: actor.commit,
            identityKey: key,
        });
    }

    return {
        contributors: [...contributorMap.values()],
        unresolved: [...unresolvedMap.values()],
        exempt: [...exemptMap.values()],
    };
}

export async function applyClaims(
    github: GitHubClient,
    registryRepository: string,
    repositoryId: number,
    raw: RawContributorSet,
): Promise<ContributorSet> {
    const contributorMap = new Map<number, ResolvedContributor>();

    for (const contributor of raw.contributors) {
        mergeContributor(contributorMap, contributor);
    }

    const unresolved: UnresolvedIdentity[] = [];
    const claimConflicts: ContributorSet["claimConflicts"] = [];

    for (const actor of raw.unresolved) {
        const directory = claimDir(repositoryId, actor.commit, actor.identityKey);
        const entries = await github.getDirectory(registryRepository, directory);

        if (entries === null) {
            unresolved.push(actor);
            continue;
        }

        const files = entries.filter(
            entry => entry.type === "file" && entry.name.endsWith(".json"),
        );

        if (files.length === 0) {
            unresolved.push(actor);
            continue;
        }

        if (files.length !== 1) {
            claimConflicts.push({
                commit: actor.commit,
                identityKey: actor.identityKey,
                reason: "multiple-claims",
            });
            continue;
        }

        const claim = await readJson<ClaimRecord>(
            github,
            registryRepository,
            files[0].path,
        );

        if (
            !claim ||
            !validateClaim(
                claim,
                claim.github_user_id,
                repositoryId,
                actor.commit,
                actor.identityKey,
            )
        ) {
            claimConflicts.push({
                commit: actor.commit,
                identityKey: actor.identityKey,
                reason: "invalid-claim",
            });
            continue;
        }

        mergeContributor(contributorMap, {
            githubUserId: claim.github_user_id,
            githubLogin: claim.github_login,
            names: [actor.name],
            commits: [actor.commit],
            claimedIdentities: [actor.identityKey],
        });
    }

    return {
        contributors: [...contributorMap.values()],
        unresolved,
        exempt: raw.exempt,
        claimConflicts,
    };
}
