# Vault events and automations

GitHub is the canonical source of truth. A signed GitHub `push` webhook wakes the Worker, which reads the current Markdown tree and compares it with the last successfully processed tree. Changes made through Obsidian, this MCP server, GitHub's website, or any Git client therefore follow the same path.

The runtime emits `note.created`, `note.updated`, and `note.deleted`. Renames are represented as one deletion and one creation. Event IDs are deterministic and do not contain note contents.

## Delivery model

1. The webhook endpoint verifies the raw request body with HMAC-SHA-256 and checks the configured hook, repository, branch, and vault.
2. D1 records the GitHub delivery before a message is accepted by Cloudflare Queues.
3. The event Queue consumer loads the canonical tree, records new events and durable automation jobs, then advances the vault checkpoint.
4. A separate automation Queue claims each job with a lease, performs the configured handler, and records its outcome.
5. A fifteen-minute scheduled reconciliation catches pushes whose webhook delivery was delayed or lost and redispatches pending jobs.

GitHub deliveries and generated events are idempotent. A successful handler is not repeated when another handler from the same event retries. Queue processing retries up to five times and then moves the message to the configured dead-letter queue.
The first scheduled reconciliation establishes a baseline without reporting every existing note as newly created. If the first observed change is a GitHub push, its `before` revision is used so that change is still emitted.

## Configuration

Automations are supplied through `AUTOMATIONS_YAML`. The default disables all handlers:

```yaml
version: 1
automations: []
```

The metadata-only built-in handler is `log-event`:

```yaml
version: 1
automations:
  - id: audit-character-changes
    enabled: true
    scopes: [vault:read]
    match:
      vaults: [owner/vault]
      events: [note.created, note.updated]
      paths:
        include: ["Characters/**/*.md"]
        exclude: ["Characters/Generated/**"]
    loop:
      allow_automation_origin: false
      max_depth: 0
    target:
      kind: internal
      handler: log-event
```

Configuration is strict: unknown fields, duplicate IDs, invalid events, unsafe scopes, or unregistered handlers prevent production configuration from rendering. Handlers are internal names implemented by this Worker; the configuration cannot invoke an arbitrary URL. That keeps credentials, SSRF risk, and permissions inside the deployment boundary while the granular document permission model evolves.

The write-capable `summarize-note` handler reads the exact Git blob SHA named by the event, sends only that note to OpenAI, and writes a deterministic managed note:

```yaml
version: 1
automations:
  - id: summarize-story-notes
    enabled: true
    scopes: [vault:read, vault:write]
    match:
      vaults: [owner/vault]
      events: [note.created, note.updated]
      paths:
        include: ["Story/**/*.md"]
        exclude: ["_Automations/**"]
    loop:
      allow_automation_origin: false
      max_depth: 0
    target:
      kind: internal
      handler: summarize-note
      model: { provider: openai, name: gpt-5.6-sol }
      input: { include_frontmatter: false, max_characters: 50000 }
      output:
        directory: _Automations/Summaries
        mode: managed
        max_characters: 6000
```

Validate a local copy before deployment:

```sh
bun run automations:check path/to/automations.yaml
```

Then place its contents in `AUTOMATIONS_YAML`, or set `AUTOMATIONS_FILE` while rendering a local production configuration. Upload the model credential separately:

```sh
bunx wrangler secret put OPENAI_API_KEY
```

`summarize-note` requires a write-enabled vault token. Its output must remain under `_Automations/Summaries`, the matcher must exclude all of `_Automations/**`, and the runtime refuses to overwrite a human-created file or a file owned by another automation. The broader exclusion prevents two managed writers from triggering each other while origin depth is not implemented. Replays use managed provenance and optimistic concurrency. If a newer event for the same source note exists, the older job loses its write capability.

The `loop` policy defaults to rejecting automation-originated changes. Allowing automation origin is not supported by this writer yet; its generated directory is excluded mechanically.

The `log-event` handler records only event metadata. Automation records in D1 contain paths, SHAs, configuration hashes, attempts, and status, never note text or model output. For `summarize-note`, the selected note and generated summary are sent to the OpenAI API; `store: false` disables Responses application-state storage, but the provider's applicable abuse-monitoring retention and data controls still apply. Review [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) before enabling this for private material. A provider call can be repeated after a crash, but the GitHub write is replay-safe.

Image generation and vector indexing are not enabled yet. A future vector index should reuse the same exact-source jobs and treat embeddings as sensitive derived vault data with tenant-isolated storage and deletion.

## Inspecting the runtime

Authenticated MCP clients can use:

- `obsidian_list_events`
- `obsidian_list_automations`
- `obsidian_list_automation_runs`

These tools expose status and metadata, not the webhook secret or raw delivery bodies.
