import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("web application shell routes", () => {
  it("rewrites only the explicit navigable routes to the application shell", async () => {
    const auth = await readFile(resolve(repositoryRoot, "src/auth.ts"), "utf8");
    for (const route of ["/", "/graph", "/notes/*", "/vaults/:vaultId", "/vaults/:vaultId/graph", "/vaults/:vaultId/notes/*"]) {
      expect(auth).toContain(`app.get("${route}", serveAppShell);`);
    }
    expect(auth).toContain('app.get("/assets/*", (context) => context.env.ASSETS.fetch(context.req.raw));');
    expect(auth).not.toContain('app.get("*", serveAppShell)');
    expect(auth).toMatch(/function serveAppShell[\s\S]*?url\.pathname = "\/";[\s\S]*?ASSETS\.fetch/);
  });
});
