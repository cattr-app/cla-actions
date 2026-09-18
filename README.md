# Cattr CLA Actions

Centralized GitHub Actions automation for the Cattr Contributor License Agreement (CLA) flow.

This public repository contains reusable workflows and a TypeScript GitHub Action used by Cattr repositories that require CLA acceptance. Source repositories keep only their own `CLA.md` and a small caller workflow. CLA snapshots, authorship claims, and acceptance records are stored separately in the private `cattr-app/cla-registry` repository.

The action has no runtime npm dependencies. GitHub API access uses the Node.js 20 built-in `fetch` API. TypeScript is bundled with esbuild into a single committed `dist/index.js`, so caller repositories do not install dependencies or build the action.

## Architecture

```text
CLA-enabled repository
├── CLA.md
└── .github/workflows/cla.yml
          │
          ▼
cattr-app/cla-actions
├── reusable workflows
└── TypeScript action
          │
          ├── Cattr CLA Bot
          │     ├── reads source repositories
          │     ├── reads cla-registry
          │     ├── posts PR comments
          │     └── creates Cattr CLA checks
          │
          └── Cattr CLA Registry
                └── writes cla-registry
                         │
                         ▼
                 private cla-registry
```

Two GitHub Apps intentionally separate permissions:

- **Cattr CLA Bot** is contributor-facing and cannot modify repository contents.
- **Cattr CLA Registry** can write registry contents and is installed only on `cattr-app/cla-registry`.

## Repository structure

```text
.
├── .github/
│   └── workflows/
│       ├── check.yml
│       ├── sign.yml
│       ├── claim.yml
│       ├── sync.yml
│       └── ci.yml
├── src/
│   ├── operations/
│   │   ├── check.ts
│   │   ├── sign.ts
│   │   ├── claim.ts
│   │   └── sync.ts
│   ├── cla.ts
│   ├── config.ts
│   ├── contributors.ts
│   ├── github.ts
│   ├── registry.ts
│   ├── runtime.ts
│   ├── types.ts
│   └── index.ts
├── dist/
│   └── index.js
├── tests/
│   └── cla.test.ts
├── examples/
│   └── cla.yml
├── AGENTS.md
├── action.yml
├── package.json
└── tsconfig.json
```

## Contributor detection

A pull request passes only when every human contributor represented by its commits has accepted the effective CLA version for that repository.

The check is not limited to the pull request author.

GitHub GraphQL `Commit.authors` is used so both the primary Git author and identities attributed through `Co-authored-by` trailers are included.

Resolved GitHub users are de-duplicated by numeric GitHub user ID. Usernames are descriptive metadata because they can change.

The default explicit automation exemption is:

```text
dependabot[bot]
```

Additional exemptions can be supplied through a newline-separated `CLA_EXEMPT_LOGINS` environment variable. Bot-like usernames are never automatically trusted.

## Unresolved authors and `/cla-claim`

Sometimes GitHub cannot associate a Git author or co-author identity with a GitHub account. Such identities are not silently ignored.

The bot reports an unresolved identity with a command such as:

```text
/cla-claim abc123def456 deadbeef1234
```

A claim means that the commenting GitHub account explicitly claims authorship/co-authorship of that exact unresolved identity in that exact commit.

A claim does **not** itself accept the CLA. The claimant still accepts the effective agreement with:

```text
/cla-sign 1
```

The registry does not persist the unresolved Git email. The claim key is a SHA-256 fingerprint of the exact Git name/email pair, calculated in memory.

If multiple GitHub users claim the same unresolved identity, the check fails for maintainer review. The automation never chooses between competing claims.

Prefer fixing commit authorship and pushing rewritten commits when practical. Do not claim third-party commits.

## Effective CLA

Each participating repository keeps:

```text
/CLA.md
```

with exactly one marker:

```md
<!-- cattr-cla-version: 1 -->

# Cattr Contributor License Agreement
```

Versions are monotonically increasing integers. Any textual modification requires a new version.

For a pull request, the effective CLA is always loaded from the trusted PR base commit, never from contributor-controlled head content.

A PR that changes `CLA.md` remains governed by the version in its base revision. The new version becomes effective after merge to the default branch and synchronization to the registry.

## Registry layout

```text
cla-registry/
├── agreements/
│   └── <repository-id>/
│       └── <cla-version>/
│           ├── CLA.md
│           └── metadata.json
├── acceptances/
│   └── <github-user-id>/
│       └── <repository-id>/
│           └── <cla-version>.json
└── claims/
    └── <repository-id>/
        └── <commit-sha>/
            └── <identity-sha256>/
                └── <github-user-id>.json
```

Agreement snapshots and acceptance records are append-only by automation. Existing records are validated rather than overwritten.

## GitHub Apps

### Cattr CLA Bot

Install on every CLA-enabled repository and on `cattr-app/cla-registry`.

Repository permissions:

```text
Contents:       Read-only
Issues:         Read & write
Pull requests: Read-only
Checks:         Read & write
Metadata:       Read-only
```

### Cattr CLA Registry

Install only on `cattr-app/cla-registry`.

Repository permissions:

```text
Contents: Read & write
Metadata: Read-only
```

Webhooks, OAuth user authorization, and client secrets are not required. GitHub Actions creates short-lived installation tokens from the private keys.

## Organization Actions configuration

Variables:

```text
CATTR_CLA_BOT_CLIENT_ID
CATTR_CLA_REGISTRY_CLIENT_ID
```

Secrets:

```text
CATTR_CLA_BOT_PRIVATE_KEY
CATTR_CLA_REGISTRY_PRIVATE_KEY
```

## Adding CLA support to a repository

Create `CLA.md`, then copy [`examples/cla.yml`](examples/cla.yml) to:

```text
.github/workflows/cla.yml
```

Install **Cattr CLA Bot** on the repository.

After the first PR creates the custom `Cattr CLA` check, make that check required for the protected default branch.

## Contributor flow

Normal resolved contributor:

```text
PR opened
    ↓
CLA check
    ↓
/cla-sign 1
    ↓
acceptance recorded
    ↓
check reevaluated
```

Unresolved Git identity:

```text
PR opened
    ↓
unresolved identity reported
    ↓
/cla-claim <commit> <identity>
    ↓
GitHub account associated with that commit identity
    ↓
/cla-sign 1
    ↓
acceptance recorded
    ↓
check reevaluated
```

For a multi-author PR, every human author and co-author must independently satisfy the CLA check.

## Security model

The caller uses `pull_request_target` so fork PRs can participate in the CLA flow while organization secrets remain available to the trusted workflow.

The action never checks out or executes the pull request head. The effective CLA is fetched from the trusted base SHA through the GitHub API.

Do not change this invariant. In particular, CLA workflows must never execute contributor-controlled files, scripts, or actions.

`/cla-claim` is an explicit self-attestation rather than cryptographic proof of Git authorship. Conflicting claims block the check for maintainer review.


## Package manager

This repository uses pnpm, pinned through the `packageManager` field in `package.json`.

```bash
corepack enable
pnpm install
```

pnpm is used only for development, tests, and building the action. Caller repositories execute the committed `dist/index.js` directly.

After the first `pnpm install`, commit the generated `pnpm-lock.yaml`. Once the lockfile exists, CI should use `pnpm install --frozen-lockfile`.

## Development

Type-check:

```bash
pnpm typecheck
```

Run tests directly against the TypeScript sources:

```bash
pnpm test
```

Build the deployable GitHub Action:

```bash
pnpm build
```

The build command is intentionally kept directly in `package.json`:

```text
esbuild src/index.ts --bundle --platform=node --format=cjs --target=node20 --outfile=dist/index.js --legal-comments=none
```

There is no repository-level `scripts/` directory.

`dist/index.js` is the only generated deployment artifact and must be committed because GitHub Actions executes it directly. Never edit `dist/index.js` manually; change `src/` and rebuild it.

Before committing a change that affects the action:

```bash
pnpm check
pnpm build
git diff -- dist/index.js
```

CI type-checks the source, runs the tests, rebuilds the action with esbuild, and validates the generated JavaScript syntax.

## Releases

Do not consume this repository from `@main`.

Publish immutable releases:

```text
v1.0.0
v1.0.1
v1.1.0
```

and maintain a moving backwards-compatible major tag:

```text
v1
```

Cattr repositories normally call:

```yaml
uses: cattr-app/cla-actions/.github/workflows/check.yml@v1
```

Breaking workflow, action-input, or registry-contract changes require a new major version.
