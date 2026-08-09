# Self-hosting guide

This guide creates one private MCP server for one GitHub account. Multiple vault repositories owned by that account are supported.

## Prerequisites

- A Cloudflare account with Workers, KV, D1, and Queues.
- A GitHub account that owns or can access the vault repositories.
- Bun 1.3 or newer.
- An MCP client that supports remote Streamable HTTP and OAuth.

Your vault repositories should contain Markdown files. Commit and push Obsidian changes before expecting the server to see them.

## 1. Choose the public origin

Choose one stable HTTPS origin before creating OAuth credentials:

- Workers.dev: `https://WORKER.ACCOUNT-SUBDOMAIN.workers.dev`
- Custom domain: `https://notes.example.com`

Do not use preview URLs for OAuth. The callback is always:

```text
https://YOUR-ORIGIN/callback
```

The MCP endpoint is:

```text
https://YOUR-ORIGIN/mcp
```

## 2. Create Cloudflare storage and queues

```sh
bun install --frozen-lockfile
bunx wrangler login
bunx wrangler kv namespace create OAUTH_KV
bunx wrangler d1 create obsidian-vault-events
bunx wrangler queues create obsidian-vault-events
bunx wrangler queues create obsidian-vault-events-dlq
bunx wrangler queues create obsidian-vault-automations
bunx wrangler queues create obsidian-vault-automations-dlq
```

Copy the returned 32-character KV namespace ID and D1 database UUID. KV stores OAuth provider state, grants, and hashed or encrypted token material. D1 stores one-time consent/session state, delivery metadata, vault revisions, derived note events, automation run status, and metadata-only chat quotas. Neither stores vault note contents or chat messages.

## 3. Register a GitHub OAuth App

In GitHub Developer Settings, create an OAuth App with:

- Homepage URL: your chosen origin.
- Authorization callback URL: `https://YOUR-ORIGIN/callback`.

Keep the client secret private. The OAuth App is used only to prove the identity of the single allowed GitHub owner; repository access uses a separate fine-grained token.

Find the owner's immutable GitHub numeric ID:

```sh
gh api user --jq .id
```

The numeric ID remains stable if the login is renamed.

## 4. Create the repository token

Create a fine-grained personal access token with:

- Repository access: **Only select repositories**.
- Select only the repositories used as vaults.
- Repository permission `Contents: Read-only` for a read deployment.
- Repository permission `Contents: Read and write` only when note creation and replacement are required.

Never use a classic PAT or an all-repositories token for this server. Give the token an expiry and rotate it before expiry.

## 5. Configure the Worker

Copy the public example to the ignored local configuration:

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

Edit these non-secret values:

- `name`: a unique Worker name.
- `ALLOWED_GITHUB_USER_ID`: the numeric ID from step 3.
- `GITHUB_REPOSITORIES`: comma-separated `owner/repository` values.
- `VAULT_ACCESS`: `read` or `write`.
- `OAUTH_KV.id`: the namespace ID from step 2.
- `EVENT_DB.database_id`: the D1 database UUID from step 2.
- `GITHUB_WEBHOOK_REPOSITORY_ID`: the immutable numeric repository ID (`gh api repos/OWNER/REPOSITORY --jq .id`).
- `GITHUB_WEBHOOK_DEFAULT_BRANCH`: normally `main`.
- `GITHUB_WEBHOOK_VAULT`: the matching `owner/repository` allowlist entry.
- `GOOGLE_CLIENT_ID`: optional public OAuth client ID when enabling Google Drive sync.

Leave `GITHUB_WEBHOOK_HOOK_ID` as a temporary positive number until the webhook is created in step 7. Keep the four default Queue names unless they conflict with existing resources in your account.

For a custom domain, set `workers_dev` to `false` and add:

```json
"routes": [{ "pattern": "notes.example.com", "custom_domain": true }]
```

Leave `OMIT_AUTHORIZATION_RESPONSE_ISS` as `false`. The opt-out exists only for known legacy clients that incorrectly reject RFC 9207 issuer responses.

## 6. First deployment and secrets

Create an ignored `.env.production` file:

```dotenv
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_VAULT_TOKEN=...
GITHUB_WEBHOOK_SECRET=...
# Optional Google Drive sync secrets:
GOOGLE_CLIENT_SECRET=...
SYNC_CREDENTIALS_KEY=...
```

Generate `GITHUB_WEBHOOK_SECRET` with a cryptographically secure password generator. Do not reuse the OAuth client secret or repository token.

Apply the D1 schema, then deploy the code and encrypted secrets:

```sh
bunx wrangler d1 migrations apply obsidian-vault-events --remote --config wrangler.jsonc
bun run web:build
bunx wrangler deploy --config wrangler.jsonc --secrets-file .env.production
PRODUCTION_ORIGIN=https://YOUR-ORIGIN bun run verify:production
```

Delete `.env.production` after the deployment. Future code deployments preserve existing Cloudflare secrets.

To enable the portal chat, upload `OPENAI_API_KEY`; chat enables automatically when the secret exists. Optionally set `WEB_CHAT_ENABLED=false` to disable it, or `true` to make a missing secret fail the health check. `OPENAI_CHAT_MODEL` chooses the initial model from `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`; the browser can select any allowlisted model and reasoning level per conversation. `WEB_CHAT_DAILY_LIMIT` remains optional.

To enable Google Drive sync, follow [Vault sync destinations](vault-sync.md), register the exact `/api/sync/google/callback` redirect URI, set `GOOGLE_CLIENT_ID`, and upload both Google sync secrets. `/healthz` rejects partial configuration, malformed encryption keys, or a missing sync migration.

## 7. Create and verify the GitHub webhook

In the canonical vault repository, open **Settings → Webhooks → Add webhook**:

- Payload URL: `https://YOUR-ORIGIN/webhooks/github`
- Content type: `application/json`
- Secret: the exact `GITHUB_WEBHOOK_SECRET` uploaded to Cloudflare
- Events: **Just the push event**
- Active: enabled

After saving, copy the numeric hook ID from the webhook URL or query it with the GitHub API. Replace `GITHUB_WEBHOOK_HOOK_ID` in `wrangler.jsonc` and deploy again without the secrets file. The initial `ping` may have reached the temporary hook policy; redeliver it from GitHub after the second deployment and require an HTTP `202` response.

The hook is restricted by its secret, hook ID, immutable repository ID, canonical branch, and vault allowlist. Create a separate deployment for a repository owned by a different person.

## 8. Verify before connecting

```sh
curl --fail https://YOUR-ORIGIN/healthz
curl -i -X POST https://YOUR-ORIGIN/mcp \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The health check must return `200`; it validates the public policy, automation configuration, and D1 schema without exposing values. The unauthenticated MCP call must return `401` with a Bearer challenge.

Connect your MCP client to `https://YOUR-ORIGIN/mcp`, sign in with the allowed GitHub account, inspect the client and requested permissions on the consent page, and approve only if recognized.

Test in this order:

1. List vaults.
2. List or read a note.
3. Inspect the graph.
4. In write mode, update a disposable note using its current SHA.
5. Push a disposable note change and inspect it with `obsidian_list_events`.
6. When Drive sync is enabled, complete the [first-sync verification](vault-sync.md#verify-the-first-sync).

## 9. Automatic deployment from GitHub

### Cloudflare Workers Builds (recommended)

In the existing Worker's **Settings → Build**, connect the Cloudflare GitHub App to only this repository. Select `main` as the production branch and disable builds for non-production branches unless preview deployments are required.

Use these commands:

- Build: `bun install --frozen-lockfile && bun run check`
- Deploy: `bun run config:production && bunx wrangler d1 migrations apply obsidian-vault-events --remote --config .wrangler/production.jsonc && bunx wrangler deploy --config .wrangler/production.jsonc && bun run verify:production`

Add the non-secret deployment values listed below as Cloudflare build variables. Workers Builds creates and manages its deployment credential; runtime GitHub credentials remain separate Worker secrets. A push to `main` now runs all checks before deployment. When `summarize-note` is enabled, verify after deployment that `OPENAI_API_KEY` exists as a Worker secret; Wrangler's `secrets.required` metadata does not upload or verify remote secret values.

Required build variables are `ALLOWED_GITHUB_USER_ID`, `VAULT_REPOSITORIES`, `OAUTH_KV_NAMESPACE_ID`, `WEBHOOK_HOOK_ID`, `WEBHOOK_REPOSITORY_ID`, `WEBHOOK_DEFAULT_BRANCH`, `WEBHOOK_VAULT`, `EVENT_D1_DATABASE_ID`, and `PRODUCTION_ORIGIN`. The build-variable names omit the reserved `GITHUB_` prefix; the workflow maps them to the runtime `GITHUB_WEBHOOK_*` bindings. The production origin is the exact HTTPS origin used for the post-deploy health smoke, without a path or trailing slash. `WORKER_NAME`, `VAULT_ACCESS`, `OMIT_AUTHORIZATION_RESPONSE_ISS`, and all four Queue names have safe defaults. Add `CUSTOM_DOMAIN` when applicable, `AUTOMATIONS_YAML` when enabling handlers, and `GOOGLE_CLIENT_ID` when enabling Drive sync. Google and sync runtime secrets must already exist in Cloudflare; `secrets.required` metadata does not upload them.

### GitHub Actions alternative

The deploy workflow is disabled until repository variable `AUTO_DEPLOY_ENABLED` equals `true`.

Create a protected GitHub Environment named `production`. Add these repository or environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Runtime application secrets such as `GOOGLE_CLIENT_SECRET` and `SYNC_CREDENTIALS_KEY` stay in Cloudflare Worker secrets, not GitHub Actions.

Create a narrowly scoped Cloudflare API token with these policies:

- Entire target account: **Workers Scripts → Write**.
- Entire target account: **Queues → Read** and **Queues → Write**.
- The dedicated event database: **D1 → Edit**.
- When using a custom domain, the specified domain containing the MCP hostname: **Workers Routes → Write**.

The deployment workflow does not need DNS, KV Storage, billing, or access to unrelated Cloudflare products. Creating KV, D1, and Queue resources remains a one-time administrator action outside CI; deploys apply versioned migrations and attach the existing Queue consumers.

Add these GitHub Actions variables:

- `AUTO_DEPLOY_ENABLED=true`
- `WORKER_NAME`
- `ALLOWED_GITHUB_USER_ID`
- `VAULT_REPOSITORIES` — copied into the Worker's `GITHUB_REPOSITORIES` allowlist during deployment.
- `VAULT_ACCESS`
- `OAUTH_KV_NAMESPACE_ID`
- `CUSTOM_DOMAIN` — omit for Workers.dev.
- `OMIT_AUTHORIZATION_RESPONSE_ISS=false`
- `GITHUB_WEBHOOK_HOOK_ID`
- `GITHUB_WEBHOOK_REPOSITORY_ID`
- `GITHUB_WEBHOOK_DEFAULT_BRANCH`
- `GITHUB_WEBHOOK_VAULT`
- `EVENT_D1_DATABASE_ID`
- `PRODUCTION_ORIGIN` — exact HTTPS origin, for example `https://notes.example.com`; required by the post-deploy smoke.
- `EVENT_QUEUE_NAME`
- `EVENT_DLQ_NAME`
- `AUTOMATION_QUEUE_NAME`
- `AUTOMATION_DLQ_NAME`
- `AUTOMATIONS_YAML` — optional; defaults to no automations.
- `GOOGLE_CLIENT_ID` — optional; required with the two Cloudflare sync secrets.

The workflow generates a private Wrangler file during the job, repeats every check, and deploys only from `main` or a manual dispatch. Runtime GitHub credentials remain only in Cloudflare.

Protect `main` by requiring the CI workflow and pull-request review. Optionally require manual approval on the `production` Environment.

## Adding more vaults for the same owner

Add each repository to both places:

1. The fine-grained token's selected repositories.
2. The comma-separated `GITHUB_REPOSITORIES` allowlist.

Redeploy after changing the allowlist. Every authorized MCP client for this personal instance can access every configured vault; there is no per-client vault partition within one instance.

The scheduled reconciler watches every allowlisted vault. The current webhook policy is intentionally singular, so `GITHUB_WEBHOOK_VAULT` receives immediate push delivery and additional vaults may take up to fifteen minutes to emit events. Use a separate deployment when another owner or a separate authorization boundary is required.

## Rotation and revocation

- Rotate `GITHUB_VAULT_TOKEN` with `wrangler secret put GITHUB_VAULT_TOKEN`.
- Rotate the OAuth client secret with `wrangler secret put GITHUB_CLIENT_SECRET`.
- Rotate the webhook secret in GitHub and Cloudflare together with `wrangler secret put GITHUB_WEBHOOK_SECRET`.
- Rotate `GOOGLE_CLIENT_SECRET` in Google and Cloudflare together. Existing refresh tokens normally remain valid.
- Rotating or losing `SYNC_CREDENTIALS_KEY` makes existing destination tokens unreadable; reconnect every Drive destination after replacing it.
- Disconnecting preserves the Drive copy. Revoke the OAuth grant separately in the Google Account security page when full provider revocation is required.
- Revoke an MCP client by removing its OAuth grant from KV or rotating the OAuth state namespace.
- Disable writes immediately by changing `VAULT_ACCESS` to `read` and deploying; the write tool disappears.
