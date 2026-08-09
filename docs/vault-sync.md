# Vault sync destinations

Vault sync is an authenticated internal callback built on the existing GitHub event and automation job pipeline. GitHub remains the only canonical source.

## Google Drive

### Google Cloud walkthrough

1. Create or select a dedicated Google Cloud project and enable **Google Drive API** under **APIs & Services → Library**.
2. Configure **Google Auth Platform → Audience**. Use **Internal** only for a Google Workspace organization whose members are the only intended users. Otherwise choose **External** and add the Google account that will own the snapshot as a test user while setting up the integration.
3. Configure the app name, support email, and developer contact. The Worker requests only `https://www.googleapis.com/auth/drive.file`; do not add broader Drive scopes.
4. Under **Clients**, create an **OAuth client ID** with application type **Web application**.
5. Register `https://your-host/api/sync/google/callback` as an exact authorized redirect URI. The scheme, hostname, port, path, and trailing slash must match the deployed origin exactly.
6. Set the client ID as the non-secret Worker variable `GOOGLE_CLIENT_ID` and upload the client secret as `GOOGLE_CLIENT_SECRET`.
7. Generate a dedicated 32-byte encryption key and upload its URL-safe base64 representation as `SYNC_CREDENTIALS_KEY`.
8. Apply D1 migrations, deploy, and require `/healthz` to return 200 before opening the portal.

For an External app with publishing status **Testing**, Google expires refresh tokens after seven days because `drive.file` is not an identity-only scope. This is useful during setup but unsuitable for unattended production callbacks. Move the OAuth app to the appropriate production status when the deployment is ready. See [Google's refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

Example key generation:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

For an existing Worker configured by `wrangler.jsonc`, upload the secrets without committing them:

```sh
bunx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.jsonc
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | bunx wrangler secret put SYNC_CREDENTIALS_KEY --config wrangler.jsonc
```

Keep an encrypted operational copy of `SYNC_CREDENTIALS_KEY`. Losing or changing it makes every stored destination credential unreadable.

The OAuth request uses only `https://www.googleapis.com/auth/drive.file`. The Worker can create and replace its own snapshot, but it cannot enumerate or read unrelated Drive files. Offline access is required because webhook and reconciliation callbacks run without an open browser.

The refresh token is encrypted with AES-256-GCM. Its authenticated context binds it to the GitHub owner, repository ID, provider, and schema version. Neither the plaintext token nor vault content is stored in D1. Disconnecting deletes the encrypted server credential and preserves the already-created Drive folder.

### Verify the first sync

1. Sign in to the portal, select the intended vault, open **Sync**, and choose **Connect** under Google Drive.
2. Confirm that Google's consent screen names the expected Cloud project and requests only access to files created by this app.
3. After returning to the portal, keep the Sync dialog open until it reports a successful timestamp, then open the app-created Drive folder and download the ZIP.
4. Confirm that the ZIP contains the expected notes, attachments, and `.obsidian` directory, without treating Drive as canonical storage.
5. Commit and push a disposable change directly to the vault repository. With the configured webhook it should enqueue immediately; other allowlisted vaults are reconciled on the fifteen-minute schedule.
6. Confirm that Drive contains the new snapshot and the portal reports the new successful time. Revert the disposable change after verification.

If authorization returns `invalid_state`, start Connect again in the same signed-in browser; OAuth state is single-use and expires after ten minutes. If the destination shows **Reconnect required**, use Reconnect rather than repeatedly queuing Sync now.

## Delivery semantics

- Any GitHub-origin change detected by webhook or scheduled reconciliation triggers sync, including changes made outside the MCP.
- Rapid changes coalesce per destination; only the newest revision keeps the write fence.
- The archive is fetched from GitHub at the exact immutable commit and streamed to Drive.
- A new archive file is uploaded before the previous snapshot is trashed. A failed upload therefore does not destroy the last successful copy.
- Google 429 and 5xx responses retry with bounded exponential backoff. Revoked OAuth grants enter `reauthorization_required` instead of retrying forever.
- If the app-created Drive folder was removed, the next run creates a replacement folder before publishing a new snapshot.
- The initial snapshot is queued immediately after OAuth completes. **Sync now** uses the same durable queue.

## iCloud Drive

This Worker does not accept Apple IDs, app-specific passwords, or cookies. CloudKit is an app-owned database and is not server-side access to an arbitrary iCloud Drive folder. Native iCloud Drive output therefore requires a separately authenticated local companion (for example an Obsidian plugin or macOS agent) that receives a scoped snapshot and writes it into the user's local iCloud Drive directory. The portal exposes this boundary as **Local bridge** rather than presenting an unsafe or non-functional connector.

## Multi-user boundary

The current deployment is single-owner. The schema already keys destinations by GitHub user and repository, and job execution resolves a destination by ID plus vault. A shared service must additionally replace the global GitHub token with per-tenant GitHub App installations before onboarding unrelated users; see [Multi-user architecture](multi-user.md).

## Operations and rotation

- `/healthz` validates the D1 tables, complete Google configuration, and the 32-byte encryption key.
- Inspect `obsidian_list_automation_runs`, the Worker logs, and the automation DLQ for failed deliveries.
- The current simple streaming upload is intended for vault snapshots that finish inside the Worker's five-minute job lease. Large media-heavy vaults need resumable Drive uploads before they can be promised without a deployment-specific size limit.
- Rotating `GOOGLE_CLIENT_SECRET` does not normally invalidate issued refresh tokens. Rotating `SYNC_CREDENTIALS_KEY` does: reconnect each destination after replacing the key.
- Disconnect removes the encrypted credential and leaves the remote copy intact. Provider-side revocation is a separate action in the Google Account security settings.
