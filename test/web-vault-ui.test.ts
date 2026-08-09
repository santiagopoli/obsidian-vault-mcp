import { describe, expect, it } from "vitest";
import { buildNoteTree } from "../web/src/noteTree";
import { markdownLinkTarget, prepareObsidianMarkdown, resolveInternalNotePath } from "../web/src/obsidianMarkdown";

const notes = [
  { path: "Canon/Characters/Luz.md", sha: "a", size: 1 },
  { path: "Canon/Places/Quilmes.md", sha: "b", size: 1 },
  { path: "README.md", sha: "c", size: 1 },
];

describe("vault file tree", () => {
  it("preserves nested folders and filters without flattening them", () => {
    const tree = buildNoteTree(notes, "luz");
    expect(tree).toMatchObject([{ type: "folder", name: "Canon", children: [{
      type: "folder", name: "Characters", children: [{ type: "note", name: "Luz" }],
    }] }]);
  });
});

describe("Obsidian Markdown", () => {
  it("extracts frontmatter and converts wiki links, embeds, comments, and callouts", () => {
    const prepared = prepareObsidianMarkdown("---\ntype: character\n---\n[[Places/Quilmes|Quilmes]]\n![[Characters/Luz]]\n%%secret%%\n> [!note] Canon");
    expect(prepared.properties).toEqual([{ name: "type", value: "character" }]);
    expect(prepared.body).toContain("[Quilmes](vault-note:Places%2FQuilmes)");
    expect(prepared.body).toContain("[Embedded: Luz](vault-note:Characters%2FLuz)");
    expect(prepared.body).not.toContain("secret");
    expect(prepared.body).toContain("> **Canon**");
  });

  it("resolves wiki and relative Markdown links inside the vault", () => {
    expect(resolveInternalNotePath("vault-note:Luz", "Canon/Places/Quilmes.md", notes)).toBe("Canon/Characters/Luz.md");
    const relative = markdownLinkTarget("../Characters/Luz.md", "Canon/Places/Quilmes.md");
    expect(relative).toBe("vault-note:Canon%2FCharacters%2FLuz.md");
    expect(resolveInternalNotePath(relative ?? "", "Canon/Places/Quilmes.md", notes)).toBe("Canon/Characters/Luz.md");
    expect(resolveInternalNotePath("vault-note:%ZZ", "README.md", notes)).toBeUndefined();
  });
});
