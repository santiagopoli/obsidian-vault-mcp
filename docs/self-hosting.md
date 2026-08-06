# Self-hosting guide

This guide creates one private MCP server for one GitHub account. Multiple vault repositories owned by that account are supported.

## Prerequisites

- A Cloudflare account with Workers and KV.
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

## 2. Create Cloudflare KV

```sh
bun install --frozen-lockfile
bunx wrangler login
bunx wrangler kv namespace create OAUTH_KV
```

Copy the returned 32-character namespace ID. KV stores OAuth state, grants, and hashed or encrypted token material. It does not store vault note contents.

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
```

Deploy the code and encrypted secrets together:

```sh
bunx wrangler deploy --config wrangler.jsonc --secrets-file .env.production
```

Delete `.env.production` after the deployment. Future code deployments preserve existing Cloudflare secrets.

## 7. Verify before connecting

```sh
curl --fail https://YOUR-ORIGIN/healthz
curl -i -X POST https://YOUR-ORIGIN/mcp \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The health check must return `200`. The unauthenticated MCP call must return `401` with a Bearer challenge.

Connect your MCP client to `https://YOUR-ORIGIN/mcp`, sign in with the allowed GitHub account, inspect the client and requested permissions on the consent page, and approve only if recognized.

Test in this order:

1. List vaults.
2. List or read a note.
3. Inspect the graph.
4. In write mode, update a disposable note using its current SHA.

## 8. Automatic deployment from GitHub

The deploy workflow is disabled until repository variable `AUTO_DEPLOY_ENABLED` equals `true`.

Create a protected GitHub Environment named `production`. Add these repository or environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Create a narrowly scoped Cloudflare API token that can edit Workers in only the target account and, when using a custom domain, only the required zone.

Add these GitHub Actions variables:

- `AUTO_DEPLOY_ENABLED=true`
- `WORKER_NAME`
- `ALLOWED_GITHUB_USER_ID`
- `VAULT_REPOSITORIES` — copied into the Worker's `GITHUB_REPOSITORIES` allowlist during deployment.
- `VAULT_ACCESS`
- `OAUTH_KV_NAMESPACE_ID`
- `CUSTOM_DOMAIN` — omit for Workers.dev.
- `OMIT_AUTHORIZATION_RESPONSE_ISS=false`

The workflow generates a private Wrangler file during the job, repeats every check, and deploys only from `main` or a manual dispatch. Runtime GitHub credentials remain only in Cloudflare.

Protect `main` by requiring the CI workflow and pull-request review. Optionally require manual approval on the `production` Environment.

## Adding more vaults for the same owner

Add each repository to both places:

1. The fine-grained token's selected repositories.
2. The comma-separated `GITHUB_REPOSITORIES` allowlist.

Redeploy after changing the allowlist. Every authorized MCP client for this personal instance can access every configured vault; there is no per-client vault partition within one instance.

## Rotation and revocation

- Rotate `GITHUB_VAULT_TOKEN` with `wrangler secret put GITHUB_VAULT_TOKEN`.
- Rotate the OAuth client secret with `wrangler secret put GITHUB_CLIENT_SECRET`.
- Revoke an MCP client by removing its OAuth grant from KV or rotating the OAuth state namespace.
- Disable writes immediately by changing `VAULT_ACCESS` to `read` and deploying; the write tool disappears.
