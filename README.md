# Obsidian Vault MCP

A self-hosted Model Context Protocol server for private Obsidian vaults stored in GitHub. It runs on Cloudflare Workers, authenticates the vault owner with OAuth 2.1, and exposes Markdown notes, an Obsidian-compatible link graph, and a durable event stream for vault automations.

The same Worker also serves an optional private web portal with a vault switcher, Markdown reader, content search, and an ephemeral read-only AI chat with verified note citations.

The server does not run Obsidian. It derives links, backlinks, aliases, tags, embeds, unresolved references, and shortest paths from an immutable GitHub tree snapshot.

## Security model

The default deployment is deliberately single-owner:

- One immutable GitHub user ID may authorize MCP clients.
- Only repositories in `GITHUB_REPOSITORIES` are addressable.
- A fine-grained GitHub token must be restricted to exactly those repositories.
- Each MCP client requires an explicit consent screen after GitHub login.
- Read-only deployments do not register the write tool.
- Writable deployments require `vault:write`; updates use the current Git blob SHA and reject stale or blind overwrites.
- Secrets stay in Cloudflare and are never part of this repository.

Do not add unrelated users to a deployment backed by one shared token. See [Multi-user architecture](docs/multi-user.md) for the correct isolation model.

## Tools

| Tool | Purpose |
| --- | --- |
| `obsidian_list_vaults` | List explicitly configured vault repositories. |
| `obsidian_list_notes` | Browse visible Markdown paths. |
| `obsidian_search_notes` | Search note contents through GitHub. |
| `obsidian_read_note` | Read one Markdown note with its current SHA. |
| `obsidian_write_note` | Create or safely replace a note; available only in write mode. |
| `obsidian_get_note_links` | Resolve outgoing links, embeds, backlinks, and broken references. |
| `obsidian_get_graph` | Page through nodes, edges, tags, aliases, and orphans. |
| `obsidian_find_path` | Find a deterministic shortest path between notes. |
| `obsidian_list_events` | Inspect canonical note-created, updated, and deleted events. |
| `obsidian_list_automations` | Inspect the server's configured internal automations. |
| `obsidian_list_automation_runs` | Inspect automation attempts and outcomes. |

## Deploy your own instance

Follow the complete [self-hosting guide](docs/self-hosting.md). The short version is:

1. Fork this repository.
2. Create Cloudflare KV, D1, and Queues resources plus an OAuth App on GitHub.
3. Create a fine-grained GitHub token restricted to selected vault repositories.
4. Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc` and enter only non-secret deployment values.
5. Upload the four base runtime secrets to Cloudflare, apply the D1 migrations, and deploy. Add `OPENAI_API_KEY` only when enabling an AI automation.
6. Connect an MCP client to `https://your-host/mcp` and approve its consent screen.
7. After the manual deployment passes its smoke tests, connect Cloudflare Workers Builds to the fork or enable the protected GitHub Actions alternative.

## Web portal

The root URL serves the portal. It reuses the GitHub OAuth callback but has its own host-only browser session; MCP bearer grants are never exposed to frontend JavaScript. The browser receives neither GitHub credentials nor the OpenAI API key.

Configure chat with a Worker secret and optional non-secret settings:

```sh
bunx wrangler secret put OPENAI_API_KEY
```

- Chat enables automatically when `OPENAI_API_KEY` exists. Set `WEB_CHAT_ENABLED=false` to turn it off explicitly, or `true` to make a missing secret fail the health check.
- `OPENAI_CHAT_MODEL` defaults to `gpt-5.6-sol`.
- `WEB_CHAT_DAILY_LIMIT` defaults to `50` requests per GitHub user per UTC day.
- Chat history stays in browser memory. Prompt, note text, and answers are not stored in D1.
- The model receives at most six current notes from one selected vault and every returned citation is checked against those sources.

See [Web portal and vault chat](docs/web-portal.md) for the API, privacy model, and current multi-user boundary.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` runs strict TypeScript, 80+ unit tests, a production dependency audit, and a Wrangler bundle dry-run. CI runs the same command without deployment credentials.

For local Worker development, `bun run dev` builds the portal and applies local D1 migrations before starting Wrangler. `bun run web:dev` provides frontend HMR and proxies API/auth routes to Wrangler on port 8787; use a separate development GitHub OAuth App whose callback points at your local origin, or test the authenticated flow on a preview deployment.

## Limits

- Up to 1,000 Markdown notes and 8 MB of Markdown source per graph snapshot.
- Up to 512 KB per note.
- Graph data is cached by repository and immutable Git tree revision for five minutes.
- Hidden paths and non-Markdown files are never exposed as notes.
- Writes create Git commits; rename and delete operations are intentionally unavailable.
- GitHub is canonical: pushes made by Obsidian, the MCP, GitHub's UI, or another Git client produce the same events.
- Automation handlers are internal and explicitly configured; `summarize-note` writes only managed summaries and arbitrary outbound callback URLs are not supported yet.
- One repository receives immediate webhook delivery per deployment; every allowlisted vault is still reconciled on the fifteen-minute schedule.

See [Vault events and automations](docs/automations.md) for delivery, filtering, retries, and the write-loop policy.

## Project status

The personal self-hosted model is implemented. Shared multi-user hosting is a separate design and requires a GitHub App installation per tenant; it is not enabled by this codebase today.

See [Security](SECURITY.md), [security model](docs/security-model.md), and [contributing](CONTRIBUTING.md).

## License

MIT
