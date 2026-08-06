# Security model

## Trust boundaries

The system has four principals:

1. The single GitHub owner authenticated through OAuth.
2. An MCP client requesting delegated access.
3. The Cloudflare Worker holding server credentials.
4. GitHub repositories explicitly configured as vaults.

GitHub OAuth identifies the owner. It does not grant repository access to the Worker. A separate fine-grained repository token performs GitHub API operations.

## Authorization invariants

- The authenticated GitHub numeric user ID must equal `ALLOWED_GITHUB_USER_ID`.
- Every repository must appear in `GITHUB_REPOSITORIES`.
- The repository token must independently be restricted to the same set or a smaller set.
- Every client sees an explicit consent screen with its name, vaults, and read/write capability.
- OAuth state and consent state are one-time values with ten-minute expiry and host-only secure cookies.
- Read operations require `vault:read`.
- Writes require `vault:write`, a write-enabled deployment, an allowed repository, and optimistic concurrency through the current Git blob SHA.
- Paths cannot escape the vault, address hidden files, or access non-Markdown notes.

The allowlist and token restriction are independent controls. A mistake in either one should not expose a repository outside the other.

## Stored data

Cloudflare KV stores OAuth provider state and grants. The provider hashes token material and encrypts grant properties. The graph cache may temporarily contain derived private metadata—paths, titles, aliases, tags, and edges—keyed by repository and immutable tree revision. Raw note contents are not placed in that cache.

Deployments handling unusually sensitive metadata can disable or shorten graph caching in `loadVaultGraph`.

## Known limits

- This is not a multi-tenant authorization system.
- All approved clients belonging to the configured owner can reach all configured vaults.
- GitHub login is retained as display metadata, but authorization uses the immutable numeric ID.
- Dynamic Client Registration remains enabled for compatibility; explicit owner consent is therefore mandatory.
- The issuer-advertisement compatibility flag weakens modern OAuth response validation and should remain disabled unless a known client requires it.

## Operational controls

- Use a protected deployment environment and a Cloudflare API token limited to **Workers Scripts → Write** for the target account plus **Workers Routes → Write** for the target domain.
- Keep runtime GitHub credentials only in Cloudflare secrets.
- Do not deploy pull-request code with production secrets.
- Review dependency audit results before deployment.
- Monitor authorization failures, GitHub rate limits, and unexpected graph sizes without logging note contents or tokens.
