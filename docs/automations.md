# Vault events and automations

GitHub is the canonical source of truth. A signed GitHub `push` webhook wakes the Worker, which reads the current Markdown tree and compares it with the last successfully processed tree. Changes made through Obsidian, this MCP server, GitHub's website, or any Git client therefore follow the same path.

The runtime emits `note.created`, `note.updated`, and `note.deleted`. Renames are represented as one deletion and one creation. Event IDs are deterministic and do not contain note contents.

## Delivery model

1. The webhook endpoint verifies the raw request body with HMAC-SHA-256 and checks the configured hook, repository, branch, and vault.
2. D1 records the GitHub delivery before a message is accepted by Cloudflare Queues.
3. A Queue consumer loads the canonical tree, records new events and automation runs, then advances the vault checkpoint.
4. A fifteen-minute scheduled reconciliation catches pushes whose webhook delivery was delayed or lost.

GitHub deliveries and generated events are idempotent. A successful handler is not repeated when another handler from the same event retries. Queue processing retries up to five times and then moves the message to the configured dead-letter queue.
The first scheduled reconciliation establishes a baseline without reporting every existing note as newly created. If the first observed change is a GitHub push, its `before` revision is used so that change is still emitted.

## Configuration

Automations are supplied through `AUTOMATIONS_YAML`. The default disables all handlers:

```yaml
version: 1
automations: []
```

The first safe built-in handler is `log-event`:

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

The `loop` policy is validated now and is reserved for write-capable handlers. The current registry contains no handler that writes to the vault, so it cannot create a commit loop. A future writer must attach automation-origin and depth metadata before `allow_automation_origin` can be enabled.

The `log-event` handler records only event metadata. AI summarization, image generation, and vector indexing need explicit model credentials, input/output paths, and write scopes before being enabled.

## Inspecting the runtime

Authenticated MCP clients can use:

- `obsidian_list_events`
- `obsidian_list_automations`
- `obsidian_list_automation_runs`

These tools expose status and metadata, not the webhook secret or raw delivery bodies.
