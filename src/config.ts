import type { Env, VaultConfig } from "./types";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type VaultAccess = "read" | "write";

export function vaultAccess(env: Env): VaultAccess {
  if (env.VAULT_ACCESS !== "read" && env.VAULT_ACCESS !== "write") {
    throw new Error("VAULT_ACCESS must be either 'read' or 'write'");
  }
  return env.VAULT_ACCESS;
}

export function allowedGitHubUserId(env: Env): string {
  const userId = env.ALLOWED_GITHUB_USER_ID.trim();
  if (!/^\d+$/.test(userId)) throw new Error("ALLOWED_GITHUB_USER_ID must be a numeric GitHub user ID");
  return userId;
}

export function configuredVaults(env: Env): VaultConfig[] {
  const repositories = env.GITHUB_REPOSITORIES.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (repositories.length === 0) {
    throw new Error("GITHUB_REPOSITORIES must contain at least one owner/repository value");
  }

  const uniqueRepositories = [...new Set(repositories)];
  if (uniqueRepositories.length !== repositories.length) {
    throw new Error("GITHUB_REPOSITORIES must not contain duplicates");
  }

  return uniqueRepositories.map((fullName) => {
    if (!repositoryPattern.test(fullName)) {
      throw new Error(`Invalid repository in GITHUB_REPOSITORIES: ${fullName}`);
    }

    const [owner, repo] = fullName.split("/") as [string, string];
    return { name: repo, owner, repo, fullName };
  });
}

export function resolveVault(env: Env, name: string): VaultConfig {
  const vaults = configuredVaults(env);
  const exact = vaults.find((candidate) => candidate.fullName === name);
  if (exact) return exact;
  const shortMatches = vaults.filter((candidate) => candidate.name === name);
  if (shortMatches.length > 1) {
    throw new Error(`Vault name '${name}' is ambiguous; use an exact owner/repository value`);
  }
  const vault = shortMatches[0];

  if (!vault) {
    throw new Error(`Unknown vault '${name}'. Call obsidian_list_vaults for allowed values.`);
  }

  return vault;
}
