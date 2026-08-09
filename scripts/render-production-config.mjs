import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseAutomationConfig } from "../src/automations/config.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const queueNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const workerName = optional("WORKER_NAME") ?? "obsidian-vault-mcp";
const allowedUserId = required("ALLOWED_GITHUB_USER_ID");
const repositories = required("VAULT_REPOSITORIES").split(",").map((value) => value.trim()).filter(Boolean);
const vaultAccess = optional("VAULT_ACCESS") ?? "read";
const omitIssuer = optional("OMIT_AUTHORIZATION_RESPONSE_ISS") ?? "false";
const oauthKvNamespaceId = required("OAUTH_KV_NAMESPACE_ID");
const customDomain = optional("CUSTOM_DOMAIN");
const webhookHookId = required("GITHUB_WEBHOOK_HOOK_ID");
const webhookRepositoryId = required("GITHUB_WEBHOOK_REPOSITORY_ID");
const webhookDefaultBranch = required("GITHUB_WEBHOOK_DEFAULT_BRANCH");
const webhookVault = required("GITHUB_WEBHOOK_VAULT");
const openAiChatModel = optional("OPENAI_CHAT_MODEL") ?? "gpt-5.6-sol";
const webChatEnabled = optional("WEB_CHAT_ENABLED");
const webChatDailyLimit = optional("WEB_CHAT_DAILY_LIMIT") ?? "50";
const googleClientId = optional("GOOGLE_CLIENT_ID");
const automationsYamlValue = optional("AUTOMATIONS_YAML");
const automationsFile = optional("AUTOMATIONS_FILE");
if (automationsYamlValue && automationsFile) fail("Set either AUTOMATIONS_YAML or AUTOMATIONS_FILE, not both");
const automationsYaml = automationsFile
  ? await readFile(automationsFile, "utf8")
  : automationsYamlValue ?? "version: 1\nautomations: []\n";
const eventD1DatabaseId = required("EVENT_D1_DATABASE_ID");
const eventQueueName = optional("EVENT_QUEUE_NAME") ?? "obsidian-vault-events";
const eventDlqName = optional("EVENT_DLQ_NAME") ?? "obsidian-vault-events-dlq";
const automationQueueName = optional("AUTOMATION_QUEUE_NAME") ?? "obsidian-vault-automations";
const automationDlqName = optional("AUTOMATION_DLQ_NAME") ?? "obsidian-vault-automations-dlq";

if (!workerNamePattern.test(workerName)) fail("WORKER_NAME must be a valid Cloudflare Worker name");
if (!/^\d+$/.test(allowedUserId)) fail("ALLOWED_GITHUB_USER_ID must be an immutable numeric GitHub user ID");
if (repositories.length === 0 || repositories.some((repository) => !repositoryPattern.test(repository))) {
  fail("VAULT_REPOSITORIES must be a comma-separated owner/repository allowlist");
}
if (vaultAccess !== "read" && vaultAccess !== "write") fail("VAULT_ACCESS must be read or write");
if (omitIssuer !== "true" && omitIssuer !== "false") fail("OMIT_AUTHORIZATION_RESPONSE_ISS must be true or false");
if (!/^[0-9a-f]{32}$/i.test(oauthKvNamespaceId)) fail("OAUTH_KV_NAMESPACE_ID must be a 32-character KV namespace ID");
if (customDomain && !hostnamePattern.test(customDomain)) fail("CUSTOM_DOMAIN must be a hostname without a scheme or path");
if (!/^\d+$/.test(webhookHookId)) fail("GITHUB_WEBHOOK_HOOK_ID must be numeric");
if (!/^\d+$/.test(webhookRepositoryId)) fail("GITHUB_WEBHOOK_REPOSITORY_ID must be numeric");
if (!/^[A-Za-z0-9._/-]{1,255}$/.test(webhookDefaultBranch)) fail("GITHUB_WEBHOOK_DEFAULT_BRANCH is invalid");
if (!repositories.includes(webhookVault)) fail("GITHUB_WEBHOOK_VAULT must be in VAULT_REPOSITORIES");
if (!["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].includes(openAiChatModel)) fail("OPENAI_CHAT_MODEL must be gpt-5.6-sol, gpt-5.6-terra, or gpt-5.6-luna");
if (webChatEnabled && webChatEnabled !== "true" && webChatEnabled !== "false") fail("WEB_CHAT_ENABLED must be true or false");
if (!/^\d+$/.test(webChatDailyLimit) || Number(webChatDailyLimit) < 1 || Number(webChatDailyLimit) > 1000) {
  fail("WEB_CHAT_DAILY_LIMIT must be an integer between 1 and 1000");
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventD1DatabaseId)) {
  fail("EVENT_D1_DATABASE_ID must be a D1 UUID");
}
if (
  !queueNamePattern.test(eventQueueName) ||
  !queueNamePattern.test(eventDlqName) ||
  !queueNamePattern.test(automationQueueName) ||
  !queueNamePattern.test(automationDlqName)
) fail("Queue names are invalid");
let automationConfig;
try {
  automationConfig = parseAutomationConfig(automationsYaml);
} catch (error) {
  fail(error instanceof Error ? error.message : "AUTOMATIONS_YAML is invalid");
}
if (automationConfig.automations.some((automation) => automation.enabled && automation.target.handler === "summarize-note") && vaultAccess !== "write") {
  fail("summarize-note requires VAULT_ACCESS=write");
}

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
    GITHUB_WEBHOOK_HOOK_ID: webhookHookId,
    GITHUB_WEBHOOK_REPOSITORY_ID: webhookRepositoryId,
    GITHUB_WEBHOOK_DEFAULT_BRANCH: webhookDefaultBranch,
    GITHUB_WEBHOOK_VAULT: webhookVault,
    OPENAI_CHAT_MODEL: openAiChatModel,
    ...(webChatEnabled ? { WEB_CHAT_ENABLED: webChatEnabled } : {}),
    WEB_CHAT_DAILY_LIMIT: webChatDailyLimit,
    ...(googleClientId ? { GOOGLE_CLIENT_ID: googleClientId } : {}),
    AUTOMATIONS_YAML: automationsYaml,
  },
  assets: {
    directory: "../web/dist",
    binding: "ASSETS",
    run_worker_first: true,
  },
  secrets: {
    required: [
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GITHUB_VAULT_TOKEN",
      "GITHUB_WEBHOOK_SECRET",
      ...(webChatEnabled === "true" || automationConfig.automations.some((automation) => automation.target.handler === "summarize-note")
        ? ["OPENAI_API_KEY"]
        : []),
      ...(googleClientId ? ["GOOGLE_CLIENT_SECRET", "SYNC_CREDENTIALS_KEY"] : []),
    ],
  },
  kv_namespaces: [{ binding: "OAUTH_KV", id: oauthKvNamespaceId }],
  d1_databases: [{
    binding: "EVENT_DB",
    database_name: "obsidian-vault-events",
    database_id: eventD1DatabaseId,
    migrations_dir: "../migrations",
  }],
  queues: {
    producers: [
      { binding: "EVENTS_QUEUE", queue: eventQueueName },
      { binding: "AUTOMATIONS_QUEUE", queue: automationQueueName },
    ],
    consumers: [
      {
        queue: eventQueueName,
        max_batch_size: 10,
        max_retries: 5,
        max_concurrency: 1,
        dead_letter_queue: eventDlqName,
      },
      {
        queue: automationQueueName,
        max_batch_size: 1,
        max_retries: 5,
        max_concurrency: 2,
        dead_letter_queue: automationDlqName,
      },
    ],
  },
  triggers: { crons: ["*/15 * * * *"] },
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
