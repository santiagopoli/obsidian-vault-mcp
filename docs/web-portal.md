# Web portal and vault chat

The deployment root serves a same-origin React portal from Cloudflare Workers Static Assets. The Worker remains the only component that talks to GitHub and OpenAI.

## User experience

- Sign in with the GitHub identity already authorized by this deployment.
- Switch between every repository in the explicit vault allowlist.
- Browse up to 200 visible Markdown paths, filter paths locally, and search contents through GitHub.
- Render Markdown with raw HTML disabled. Images embedded by notes are not fetched by the portal.
- Ask either the current note or the selected vault. Answers include citations that open the exact source note.

The portal is responsive, but the initial desktop layout intentionally prioritizes a three-panel workspace: files, document, and chat.

## Browser authentication

Web authentication is separate from MCP OAuth grants even though both use the registered GitHub callback URL.

1. `GET /web/login` creates 256 bits of random state and stores only its SHA-256 hash in D1 for ten minutes.
2. The state is also bound to a `__Host-` secure, HTTP-only, same-site cookie.
3. The callback atomically deletes and returns the matching unexpired state, so it cannot be replayed.
4. After checking the immutable GitHub numeric user ID, the Worker creates an eight-hour opaque session.
5. Only the session token hash is stored. The raw token stays in a `__Host-obsidian_session` secure, HTTP-only cookie.
6. Chat and logout require an exact same-origin request plus the session-bound CSRF value.

Authenticated API responses use `private, no-store`. There is no CORS policy and no credential is written to browser storage.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/session` | Current browser identity and CSRF value. |
| `POST /api/logout` | Revoke the current browser session. |
| `GET /api/vaults` | Resolve configured vaults to immutable GitHub repository IDs. |
| `GET /api/vaults/:repositoryId/notes` | List visible Markdown paths. |
| `GET /api/vaults/:repositoryId/note?path=` | Read one current Markdown note. |
| `GET /api/vaults/:repositoryId/search?q=` | Search only the selected repository. |
| `POST /api/vaults/:repositoryId/chat` | Retrieve bounded current sources and answer with citations. |

The repository ID supplied by the browser is never sufficient authority. Each request first resolves it against the deployment's allowlist and verifies the signed-in owner. Unknown and unauthorized IDs return the same not-found result.

## Chat privacy and safety

- Chat is read-only and has no write tools, MCP passthrough, web access, or arbitrary callbacks.
- Vault content is labeled as untrusted evidence. Instructions inside notes cannot grant capabilities or widen retrieval.
- Retrieval is limited to the selected vault, at most six notes, 12,000 characters per note, and 50,000 characters total.
- OpenAI Responses requests use `store: false`; default provider abuse-monitoring retention can still apply unless the API organization has an eligible retention arrangement.
- D1 stores only session, quota, and operational metadata. It does not store prompts, retrieved content, answers, or chat history.
- The server validates every model-produced citation ID against the exact sources sent in that request.
- A per-user UTC daily request quota limits accidental or abusive model spend.

The current default model is `gpt-5.6-sol`. Set `OPENAI_CHAT_MODEL` to another explicitly evaluated model when cost or latency requirements differ.

Chat enables automatically when the `OPENAI_API_KEY` Worker secret exists. `WEB_CHAT_ENABLED=false` disables it explicitly; `WEB_CHAT_ENABLED=true` makes a missing secret fail the health check. `WEB_CHAT_DAILY_LIMIT` defaults to 50 requests per user per UTC day.

## Multi-vault and multi-user boundary

This release supports many vaults for the one immutable GitHub owner configured by the deployment. It does **not** admit a second user.

Shared hosting requires the GitHub App installation architecture in [Multi-user architecture](multi-user.md): tenant memberships, immutable repository grants, and a fresh short-lived installation token restricted to the exact repository for every operation. Do not turn `ALLOWED_GITHUB_USER_ID` into a list while retaining the shared repository token.

Vector search remains deferred until its index can enforce tenant, repository, path, and revision filters structurally and delete all derived embeddings when access is revoked.
