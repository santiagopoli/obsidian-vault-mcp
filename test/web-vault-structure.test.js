import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("vault file panel structure", () => {
  it("keeps the file tree mounted while content-search results are present", async () => {
    const app = await readFile(resolve(repositoryRoot, "web/src/App.tsx"), "utf8");
    expect(app).toContain('className="file-list note-tree"');
    expect(app).not.toMatch(/searchResults\s*===\s*undefined\s*&&\s*<>[\s\S]*?className="file-list note-tree"/);
  });
});
