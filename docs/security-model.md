# Security model

## Trust boundaries

The system has five principals:

1. The single GitHub owner authenticated through OAuth.
2. An MCP client requesting delegated access.
3. The Cloudflare Worker holding server credentials.
4. GitHub repositories explicitly configured as vaults.
5. GitHub's webhook service delivering signed canonical-change notifications.
6. The first-party browser portal holding an opaque host-only session.
7. OpenAI receiving only the bounded notes retrieved for an explicit chat request.

GitHub OAuth identifies the owner. It does not grant repository access to the Worker. A separate fine-grained repository token performs GitHub API operations.

## Authorization invariants

- The authenticated GitHub numeric user ID must equal `ALLOWED_GITHUB_USER_ID`.
- Every repository must appear in `GITHUB_REPOSITORIES`.
- The repository token must independently be restricted to the same set or a smaller set.
- Every client sees an explicit consent screen with its name, vaults, and read/write capability.
- GitHub OAuth state uses a ten-minute host-only secure cookie. Consent state is a separate one-time, ten-minute D1 record consumed atomically with `DELETE … RETURNING` by the approval form.
- Read operations require `vault:read`.
- Writes require `vault:write`, a write-enabled deployment, an allowed repository, and optimistic concurrency through the current Git blob SHA.
- Paths cannot escape the vault, address hidden files, or access non-Markdown notes.
- Webhooks require an HMAC-SHA-256 signature over the raw body and must match the configured hook ID, immutable repository ID, branch, and vault.
- Reusing a GitHub delivery ID with a different payload is rejected.
- Automation targets are internal handler names. Configuration cannot request arbitrary outbound URLs.
- Browser sessions store only a SHA-256 token hash, expire after eight hours, and require exact-origin CSRF validation for chat and logout.
- Portal vault IDs are immutable GitHub repository IDs but are resolved against the owner allowlist again on every request.
- Chat has no write tools or outbound capabilities; note text is untrusted evidence and citations are server-validated.

The allowlist and token restriction are independent controls. A mistake in either one should not expose a repository outside the other.

## Stored data

Cloudflare KV stores OAuth provider state and grants. The provider hashes token material and encrypts grant properties. D1 stores one-time consent state, webhook delivery metadata, vault checkpoints, derived note events, and automation run status. The graph cache may temporarily contain derived private metadata—paths, titles, aliases, tags, and edges—keyed by repository and immutable tree revision. Raw note contents and raw webhook bodies are not persisted in KV, D1, or the graph cache.

D1 also stores browser-session hashes, CSRF values, expiry metadata, and daily chat counters. Portal chat history is browser-memory-only. Prompts, retrieved note bodies, and model answers are not persisted by this service. Responses API calls set `store: false`; deployments must still disclose the provider's applicable abuse-monitoring retention.

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
- Keep `GITHUB_WEBHOOK_SECRET` only as a Worker secret and rotate the GitHub hook and Worker secret together.
- Monitor the event dead-letter queue and scheduled reconciliation failures.
- Review dependency audit results before deployment.
- Monitor authorization failures, GitHub rate limits, and unexpected graph sizes without logging note contents or tokens.
