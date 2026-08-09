import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production configuration renderer", () => {
  it("wires every required renderer input without referencing reserved GitHub variables", async () => {
    const [renderer, workflow] = await Promise.all([
      readFile(resolve(repositoryRoot, "scripts/render-production-config.mjs"), "utf8"),
      readFile(resolve(repositoryRoot, ".github/workflows/deploy.yml"), "utf8"),
    ]);
    const requiredInputs = [...renderer.matchAll(/required\("([A-Z0-9_]+)"\)/g)].map((match) => match[1]);

    expect(requiredInputs.length).toBeGreaterThan(0);
    expect(workflow).not.toMatch(/\$\{\{\s*vars\.GITHUB_/);
    for (const input of requiredInputs) {
      expect(workflow).toMatch(new RegExp(`^\\s+${input}:\\s+\\$\\{\\{\\s+(?:vars|secrets)\\.[A-Z0-9_]+\\s*\\}\\}\\s*$`, "m"));
    }
  });

  it("wires the Google client, encrypted credential secrets, and sync migration into production", async () => {
    const workingDirectory = await mkdtemp(resolve(tmpdir(), "obsidian-production-config-"));
    temporaryDirectories.push(workingDirectory);
    await execFileAsync("bun", [resolve(repositoryRoot, "scripts/render-production-config.mjs")], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        ALLOWED_GITHUB_USER_ID: "12345678",
        VAULT_REPOSITORIES: "owner/vault",
        OAUTH_KV_NAMESPACE_ID: "a".repeat(32),
        GITHUB_WEBHOOK_HOOK_ID: "123",
        GITHUB_WEBHOOK_REPOSITORY_ID: "456",
        GITHUB_WEBHOOK_DEFAULT_BRANCH: "main",
        GITHUB_WEBHOOK_VAULT: "owner/vault",
        EVENT_D1_DATABASE_ID: "12345678-1234-4123-8123-123456789abc",
        GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
      },
    });

    const config = JSON.parse(await readFile(resolve(workingDirectory, ".wrangler/production.jsonc"), "utf8"));

    expect(config.vars.GOOGLE_CLIENT_ID).toBe("google-client.apps.googleusercontent.com");
    expect(config.secrets.required).toEqual(expect.arrayContaining(["GOOGLE_CLIENT_SECRET", "SYNC_CREDENTIALS_KEY"]));
    expect(config.d1_databases).toContainEqual(expect.objectContaining({ binding: "EVENT_DB", migrations_dir: "../migrations" }));
    expect(config.queues.producers).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: "EVENTS_QUEUE" }),
      expect.objectContaining({ binding: "AUTOMATIONS_QUEUE" }),
    ]));
    expect(config.queues.consumers).toHaveLength(2);
  });

  it("fails production verification closed when the deployment origin is missing", async () => {
    const environment = { ...process.env };
    delete environment.PRODUCTION_ORIGIN;

    await expect(execFileAsync("bun", [resolve(repositoryRoot, "scripts/verify-production.mjs")], { env: environment }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("PRODUCTION_ORIGIN is required") });
  });
});
