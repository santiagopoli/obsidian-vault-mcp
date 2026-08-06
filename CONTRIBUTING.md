# Contributing

Use synthetic vaults and neutral account names in code, tests, fixtures, screenshots, and issue reports. Never commit `.dev.vars`, `.env` files, generated Wrangler configuration, private note contents, tokens, OAuth codes, repository IDs, Cloudflare account IDs, KV IDs, or personal domains.

Before opening a pull request:

```sh
bun install --frozen-lockfile
bun run check
```

Pull requests must preserve the single-owner authorization invariants or explicitly implement the complete multi-user GitHub App boundary described in `docs/multi-user.md`.
