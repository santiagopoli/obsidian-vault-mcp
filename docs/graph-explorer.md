# Graph Explorer

The private web portal includes a Graph Explorer derived from the same exact-revision graph used by the MCP tools and vault agent. Open **Graph** from the portal header to inspect the selected vault.

## Use it

- Search by note title, path, or tag, and narrow the map to one top-level folder or tag.
- Select a node to inspect its outgoing links, backlinks, tags, and orphan status.
- Open the selected note or send it to the read-only vault chat as the current note context.
- Set a start and destination note to find the shortest connection trail through outgoing links and backlinks.
- Use the zoom controls for the visual map. The connection-trail list remains the precise, navigable representation of a calculated route.

The map is deterministic for a given Git revision. Self-links do not make a note connected to the rest of the vault, and unresolved or ambiguous links contribute to the unresolved count without being guessed into edges.

## Privacy and isolation

The portal receives graph metadata—paths, titles, tags, counts, orphan state, and resolved edges—but not note bodies, credentials, hidden files, or unresolved target text. Requests require the private browser session and resolve the numeric repository ID against the server allowlist before GitHub is read. Switching vaults requests a separately authorized snapshot.

API responses are private and are not browser-cached. The Worker may reuse a five-minute internal cache keyed by repository and immutable Git tree revision. Vault content is never sent to a graph visualization provider.

## Limits

- One graph snapshot supports at most **1,000 Markdown notes**.
- The source Markdown budget is **8 MB**, with at most **512 KB per note**.
- The visual response includes at most **10,000 resolved edges**. The UI reports when edges were truncated; graph statistics still describe the complete derived snapshot.
- Shortest-path queries use the complete derived graph and accept a maximum depth from 1 through 12.
- Layout is computed in the browser. Dense graphs can contain overlapping nodes; filters and connection trails provide a clearer view than rendering every relationship at once.

The Explorer models Obsidian-compatible Markdown connectivity. It does not run Obsidian, community plugins, Dataview queries, or Canvas files.
