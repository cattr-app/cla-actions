\
# AGENTS.md

## Repository purpose

This repository contains the centralized Cattr Contributor License Agreement automation used by CLA-enabled Cattr repositories. It is security-sensitive infrastructure: it decides whether a contribution has the required authorship attribution and CLA acceptance, and it writes audit records to the private `cattr-app/cla-registry` repository.

Prefer small, reviewable changes. Do not weaken verification or silently convert an error into a pass condition.

## Toolchain

- Node.js 20 is the GitHub Action runtime.
- Use **pnpm**, not npm or Yarn.
- The pnpm version is pinned by `packageManager` in `package.json`.
- TypeScript is the source language.
- esbuild bundles the action into the single committed artifact `dist/index.js`.

Typical commands:

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

There is intentionally no repository-level `scripts/` directory. Keep simple build/test commands directly in `package.json`.

Do not manually edit `dist/index.js`. Change `src/`, run `pnpm build`, and commit the resulting bundle together with the source change.

## Architecture

Reusable workflows live directly under `.github/workflows/` because GitHub requires reusable workflow files at that level. They create short-lived GitHub App installation tokens and invoke the local JavaScript action.

The action entry point is `src/index.ts`. Operations are separated into:

- `src/operations/check.ts`
- `src/operations/sign.ts`
- `src/operations/claim.ts`
- `src/operations/sync.ts`

Shared responsibilities are kept in `src/github.ts`, `src/contributors.ts`, `src/registry.ts`, `src/cla.ts`, and `src/types.ts`.

Keep operation files orchestration-oriented. Put reusable GitHub/registry/contributor logic in the shared modules instead of duplicating it.

## Security invariants

These rules are mandatory unless the project owner explicitly changes the security model:

1. Never checkout, execute, import, or evaluate code from a pull request head in a privileged CLA workflow.
2. `pull_request_target` is used only because the workflow requires trusted organization secrets. Treat all PR-controlled data as untrusted input.
3. The effective CLA for a PR must be read from the trusted PR **base SHA**, never from the PR head.
4. The contributor-controlled head SHA may be used as the target of a check run, but not as a source of executable code or trusted configuration.
5. Keep GitHub App privileges separated:
   - `Cattr CLA Bot` reads source/registry data, posts comments, and writes checks.
   - `Cattr CLA Registry` writes only to the private registry repository.
6. Do not broaden App permissions merely to simplify implementation.
7. Registry records are append-only from automation. Existing agreement, acceptance, and claim records must be validated, not overwritten.
8. A registry/API error must not be treated as acceptance.
9. A malformed or conflicting record must block the CLA check and require maintainer attention.
10. Do not log private keys, installation tokens, or other credentials.

## Contributor identity model

A PR is evaluated for **all human contributors represented by its commits**, not only the PR opener.

Contributor discovery uses GitHub GraphQL `Commit.authors`, which includes the primary Git author and identities attributed through `Co-authored-by` trailers.

For identities that GitHub resolves to an account:

- the numeric GitHub user ID is the canonical identity;
- the login is human-readable metadata only;
- contributors are de-duplicated by numeric user ID.

Explicit bot exemptions are allowed. Do not infer exemption merely because a login looks like a bot. The default explicit exemption is `dependabot[bot]`.

## Unresolved identities and claims

An unresolved Git identity must never be silently ignored.

Its claim selector is based on:

```text
SHA-256(name + NUL + email)
```

The raw unresolved email is used transiently to calculate the fingerprint and must not be persisted to the CLA registry by the current design.

`/cla-claim <commit> [identity]` is a self-attestation that associates an unresolved commit identity with the commenting GitHub account. It is **not** CLA acceptance.

A claimant still needs `/cla-sign <version>` when no valid acceptance exists.

If multiple GitHub users claim the same unresolved identity, do not choose one automatically. Mark the state as conflicting and require maintainer review.

Do not add an automatic maintainer "ignore unresolved" path. Third-party commits must be handled deliberately rather than claimed merely to satisfy automation.

## CLA versioning

A CLA-enabled source repository stores `CLA.md` with exactly one marker:

```md
<!-- cattr-cla-version: 1 -->
```

Versions are monotonically increasing positive integers. Any textual CLA change requires a new version, including typo fixes.

The exact bytes are additionally identified by SHA-256. Do not embed the digest into `CLA.md` itself.

When a PR changes `CLA.md`, that PR is still evaluated against the CLA present at its trusted base SHA. The newly merged CLA becomes effective after registry synchronization.

## Registry contract

The private registry layout is part of the compatibility contract:

```text
agreements/<repository-id>/<version>/CLA.md
agreements/<repository-id>/<version>/metadata.json
acceptances/<github-user-id>/<repository-id>/<version>.json
claims/<repository-id>/<commit-sha>/<identity-sha256>/<github-user-id>.json
```

Repository IDs and user IDs are numeric GitHub IDs because repository names and logins can change.

Do not change paths, JSON field meanings, identity semantics, or immutability behavior casually. A registry-contract change requires tests, README updates, migration consideration, and normally a major release if existing caller repositories could be affected.

## Commands exposed to contributors

Current commands are:

```text
/cla-sign <version>
/cla-claim <commit> [identity]
```

Commands must be parsed strictly. A command signs or claims only for the GitHub account that posted the comment. Never let a commenter create an acceptance or claim on behalf of another user.

## Tests

Add or update tests for behavior changes, especially around:

- one author vs. multiple authors;
- `Co-authored-by` identities;
- repeated authors across commits;
- resolved and unresolved identities;
- valid, missing, malformed, and conflicting claims;
- valid, missing, and inconsistent acceptance records;
- changed CLA content without a version increment;
- API `404` vs. authorization/server failures;
- concurrent create races for immutable registry files.

Tests must not depend on production secrets or write to the real registry.

Before proposing a change, run:

```bash
pnpm check
pnpm build
node --check dist/index.js
```

After `pnpm build`, ensure `dist/index.js` is included with any source change that affects the action bundle.

## Generated bundle

`dist/index.js` is a deployment artifact. It is intentionally committed so `uses: cattr-app/cla-actions@<ref>` can execute immediately without dependency installation or compilation.

`dist/index.js` is generated by the `build` command defined directly in `package.json`.

CI rebuilds the action with esbuild and validates the resulting JavaScript. Keep the repository's executable distribution to this single file unless there is a strong technical reason to change the packaging model.

## Workflow and release compatibility

Caller repositories normally reference the reusable workflows at `@v1`. Keep `v1` backwards-compatible.

Release immutable versions such as `v1.0.0`, then move the major `v1` tag only to compatible releases. Breaking workflow inputs, command syntax, registry layout, identity semantics, or security assumptions require a new major version.

Do not make callers depend on `@main`.

## Documentation

Update `README.md` when changing setup, permissions, commands, registry schema, contributor flow, or security behavior. Update `examples/cla.yml` when caller workflow requirements change.

The automation repository itself currently has no finalized public license. Do not invent or change the repository license unless explicitly requested.
