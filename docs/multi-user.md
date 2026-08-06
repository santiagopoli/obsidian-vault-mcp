# Multi-user architecture

The included server is intentionally single-owner. Adding several allowed logins to the current design would be unsafe: every authenticated user would share the same repository credential and could access every configured vault.

## Safe shared-service design

A multi-user service should replace the shared fine-grained PAT with a GitHub App:

1. Each user or organization installs the GitHub App using **Only select repositories**.
2. The app requests only repository metadata and `Contents` read or read/write.
3. Onboarding records the immutable GitHub user or organization ID, installation ID, and selected repository IDs.
4. Each MCP grant stores the immutable GitHub user ID, never only the mutable login.
5. Every tool request resolves its tenant and verifies that the requested repository belongs to one of that tenant's installations.
6. The Worker mints a short-lived installation token for the exact repository and minimum required permission.
7. The token is never persisted and expires after GitHub's normal installation-token lifetime.
8. Tenant mappings live in D1 or a Durable Object with explicit uniqueness and ownership constraints; KV remains appropriate only for ephemeral OAuth state and caches.

For additional defense, request installation tokens limited to the exact `repository_ids` being accessed even when the installation contains more repositories.

## Required data model

At minimum:

- `users(github_user_id, login_display)`
- `installations(installation_id, account_id, account_type)`
- `user_installations(github_user_id, installation_id)`
- `vaults(repository_id, installation_id, owner, name, access_mode)`
- `grants(grant_id, github_user_id, client_id, scopes)`

Repository IDs and GitHub user IDs are authoritative. Owner and repository names are display fields because both can be renamed.

## Request authorization

For every tool call:

1. Validate the MCP bearer token and recover the immutable user ID and scopes.
2. Resolve the requested vault by repository ID within that user's tenant.
3. Verify the GitHub App installation still includes that repository.
4. Mint a repository-limited installation token.
5. Enforce read or write scope before calling GitHub.
6. Record a metadata-only audit event without note content or credentials.

## Deployment choices

- Simplest and strongest isolation: each person deploys this repository into their own Cloudflare account.
- Shared hosted service: implement the GitHub App model above before accepting a second user.
- Never solve multi-tenancy by expanding `ALLOWED_GITHUB_USER_ID` into a list while retaining one PAT.

The shared-service architecture is documented but not implemented in this repository yet.
