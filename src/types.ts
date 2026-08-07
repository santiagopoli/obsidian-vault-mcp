import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface VaultEventQueueMessage {
  kind?: "vault-event";
  deliveryId: string;
  repositoryId: string;
  vault: string;
  previousRevision?: string;
  afterRevision?: string;
}

export interface AutomationJobQueueMessage {
  kind: "automation";
  runId: string;
}

export type WorkerQueueMessage = VaultEventQueueMessage | AutomationJobQueueMessage;

export interface Env {
  ALLOWED_GITHUB_USER_ID: string;
  GITHUB_REPOSITORIES: string;
  VAULT_ACCESS: "read" | "write";
  OMIT_AUTHORIZATION_RESPONSE_ISS?: "true" | "false";
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_VAULT_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_HOOK_ID: string;
  GITHUB_WEBHOOK_REPOSITORY_ID: string;
  GITHUB_WEBHOOK_DEFAULT_BRANCH: string;
  GITHUB_WEBHOOK_VAULT: string;
  OPENAI_API_KEY?: string;
  AUTOMATIONS_YAML?: string;
  OAUTH_KV: KVNamespace;
  EVENT_DB: D1Database;
  EVENTS_QUEUE: Queue<VaultEventQueueMessage>;
  AUTOMATIONS_QUEUE: Queue<AutomationJobQueueMessage>;
  OAUTH_PROVIDER: OAuthHelpers;
}

export interface AuthProps {
  githubUserId: string;
  githubLogin: string;
  scopes: string[];
}

export interface GitHubTreeItem {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

export interface VaultConfig {
  name: string;
  owner: string;
  repo: string;
  fullName: string;
}
