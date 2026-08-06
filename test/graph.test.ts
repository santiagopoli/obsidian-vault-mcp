import { describe, expect, test } from "vitest";
import { buildVaultGraph, findShortestPath, noteByPath } from "../src/graph";
import type { VaultDocument } from "../src/graph";

function document(path: string, content: string): VaultDocument {
  return { path, content, sha: path.padEnd(40, "0").slice(0, 40) };
}

describe("Obsidian graph", () => {
  test("parses frontmatter, wikilinks, embeds, subpaths, Markdown links, aliases, and tags", () => {
    const graph = buildVaultGraph([
      document("Home.md", `---
title: Story Home
aliases: [Start, "Beginning"]
tags:
  - world/index
relationships:
  - "[[People/Ada]]"
---
[[Reference/Index|Reference]] and [[Ada#Biography]].
![[People/Ada^portrait]]
[Lin](People/Lin.md#Opening)
#draft/active

\`[[Ignored inline]]\`
<!-- [[Ignored comment]] -->
\\[\\[Escaped]]
![[portrait.png]]
\`\`\`
[[Ignored fenced]]
\`\`\`
`),
      document("Reference/Index.md", "[[Home]]"),
      document("People/Ada.md", "# Ada"),
      document("People/Lin.md", "---\naliases:\n  - Navigator\n---\n# Lin"),
    ]);

    const home = noteByPath(graph, "Home.md");
    expect(home).toMatchObject({
      title: "Story Home",
      aliases: ["Beginning", "Start"],
      tags: ["draft/active", "world/index"],
      outgoing: ["People/Ada.md", "People/Lin.md", "Reference/Index.md"],
      embeds: ["People/Ada.md"],
      unresolved: [],
    });
    expect(graph.edges.filter(({ source, target }) => source === "Home.md" && target === "People/Ada.md")).toHaveLength(2);
    expect(graph.edges.find(({ source, target, embedded }) => source === "Home.md" && target === "People/Ada.md" && embedded)).toMatchObject({
      kind: "wikilink",
      subpath: "^portrait",
    });
    expect(noteByPath(graph, "People/Ada.md")?.backlinks).toEqual(["Home.md"]);
    expect(noteByPath(graph, "people/lin.md")?.aliases).toEqual(["Navigator"]);
  });

  test("resolves relative Markdown links and unique basenames", () => {
    const graph = buildVaultGraph([
      document("Scenes/Opening.md", "[Lin](../People/Lin.md#Arrival) and [[Ada]]"),
      document("People/Lin.md", ""),
      document("People/Ada.md", ""),
    ]);

    expect(noteByPath(graph, "Scenes/Opening.md")?.outgoing).toEqual(["People/Ada.md", "People/Lin.md"]);
    expect(graph.edges.find(({ target }) => target === "People/Lin.md")).toMatchObject({ kind: "markdown", subpath: "#Arrival" });
  });

  test("reports ambiguous and unresolved links without guessing", () => {
    const graph = buildVaultGraph([
      document("Source.md", "[[Foo]] [[Missing]]"),
      document("A/Foo.md", ""),
      document("B/Foo.md", ""),
    ]);

    expect(graph.edges).toEqual([]);
    expect(graph.unresolved).toEqual([
      expect.objectContaining({ source: "Source.md", target: "Foo", status: "ambiguous", candidates: ["A/Foo.md", "B/Foo.md"] }),
      expect.objectContaining({ source: "Source.md", target: "Missing", status: "unresolved" }),
    ]);
    expect(noteByPath(graph, "Source.md")?.unresolved).toEqual(["Foo", "Missing"]);
  });

  test("finds deterministic shortest paths in directed or undirected graphs", () => {
    const graph = buildVaultGraph([
      document("A.md", "[[B]] [[C]]"),
      document("B.md", "[[D]]"),
      document("C.md", "[[D]]"),
      document("D.md", ""),
      document("E.md", ""),
    ]);

    expect(findShortestPath(graph, "A.md", "D.md", "outgoing", 4)).toEqual(["A.md", "B.md", "D.md"]);
    expect(findShortestPath(graph, "D.md", "A.md", "both", 4)).toEqual(["D.md", "B.md", "A.md"]);
    expect(findShortestPath(graph, "A.md", "A.md", "both", 1)).toEqual(["A.md"]);
    expect(findShortestPath(graph, "A.md", "E.md", "both", 4)).toBeUndefined();
    expect(findShortestPath(graph, "A.md", "D.md", "outgoing", 1)).toBeUndefined();
  });

  test("does not treat local headings, attachments, or self-links as graph connectivity", () => {
    const graph = buildVaultGraph([
      document("Solo.md", "[[#Heading]] ![[photo.jpg]] [[Solo]]"),
    ]);

    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "Solo.md", target: "Solo.md" }),
    ]);
    const externallyConnected = graph.edges.some((edge) => edge.source === "Solo.md" && edge.target !== "Solo.md");
    expect(externallyConnected).toBe(false);
  });
});
