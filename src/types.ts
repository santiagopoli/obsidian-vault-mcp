import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  ALLOWED_GITHUB_USER_ID: string;
  GITHUB_REPOSITORIES: string;
  VAULT_ACCESS: "read" | "write";
  OMIT_AUTHORIZATION_RESPONSE_ISS?: "true" | "false";
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_VAULT_TOKEN: string;
  OAUTH_KV: KVNamespace;
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
