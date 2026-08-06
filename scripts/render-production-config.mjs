import { mkdir, writeFile } from "node:fs/promises";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const workerName = optional("WORKER_NAME") ?? "obsidian-vault-mcp";
const allowedUserId = required("ALLOWED_GITHUB_USER_ID");
const repositories = required("GITHUB_REPOSITORIES").split(",").map((value) => value.trim()).filter(Boolean);
const vaultAccess = optional("VAULT_ACCESS") ?? "read";
const omitIssuer = optional("OMIT_AUTHORIZATION_RESPONSE_ISS") ?? "false";
const oauthKvNamespaceId = required("OAUTH_KV_NAMESPACE_ID");
const customDomain = optional("CUSTOM_DOMAIN");

if (!workerNamePattern.test(workerName)) fail("WORKER_NAME must be a valid Cloudflare Worker name");
if (!/^\d+$/.test(allowedUserId)) fail("ALLOWED_GITHUB_USER_ID must be an immutable numeric GitHub user ID");
if (repositories.length === 0 || repositories.some((repository) => !repositoryPattern.test(repository))) {
  fail("GITHUB_REPOSITORIES must be a comma-separated owner/repository allowlist");
}
if (vaultAccess !== "read" && vaultAccess !== "write") fail("VAULT_ACCESS must be read or write");
if (omitIssuer !== "true" && omitIssuer !== "false") fail("OMIT_AUTHORIZATION_RESPONSE_ISS must be true or false");
if (!/^[0-9a-f]{32}$/i.test(oauthKvNamespaceId)) fail("OAUTH_KV_NAMESPACE_ID must be a 32-character KV namespace ID");
if (customDomain && !hostnamePattern.test(customDomain)) fail("CUSTOM_DOMAIN must be a hostname without a scheme or path");

const config = {
  $schema: "../node_modules/wrangler/config-schema.json",
  name: workerName,
  main: "../src/index.ts",
  compatibility_date: "2026-07-15",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  workers_dev: !customDomain,
  preview_urls: false,
  ...(customDomain ? { routes: [{ pattern: customDomain, custom_domain: true }] } : {}),
  vars: {
    ALLOWED_GITHUB_USER_ID: allowedUserId,
    GITHUB_REPOSITORIES: repositories.join(","),
    VAULT_ACCESS: vaultAccess,
    OMIT_AUTHORIZATION_RESPONSE_ISS: omitIssuer,
  },
  secrets: {
    required: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_VAULT_TOKEN"],
  },
  kv_namespaces: [{ binding: "OAUTH_KV", id: oauthKvNamespaceId }],
  observability: { enabled: true, head_sampling_rate: 0.1 },
};

await mkdir(".wrangler", { recursive: true });
await writeFile(".wrangler/production.jsonc", `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

function required(name) {
  const value = optional(name);
  if (!value) fail(`${name} is required`);
  return value;
}

function optional(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function fail(message) {
  throw new Error(`Production configuration error: ${message}`);
}
