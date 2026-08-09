import { describe, expect, it } from "vitest";
import { graphDegree, layoutGraph, type GraphLayoutInput } from "../web/src/graphLayout";

describe("graph explorer layout", () => {
  it("is deterministic, does not mutate input, and centers the most connected note", () => {
    const nodes: GraphLayoutInput[] = [
      { path: "Scenes/End.md", degree: 1, orphan: false },
      { path: "Home.md", degree: 9, orphan: false },
      { path: "People/Ada.md", degree: 4, orphan: false },
    ];
    const original = structuredClone(nodes);

    const first = layoutGraph(nodes);
    const second = layoutGraph([...nodes].reverse());

    expect(nodes).toEqual(original);
    expect(first).toEqual(second);
    expect(first.nodes[0]).toMatchObject({ path: "Home.md", x: 500, y: 350 });
    expect(first.nodes.map(({ path }) => path)).toEqual(["Home.md", "People/Ada.md", "Scenes/End.md"]);
  });

  it("keeps default-layout nodes finite and visible while distinguishing orphans", () => {
    const graph = layoutGraph(Array.from({ length: 1_000 }, (_, index) => ({
      path: index % 2 === 0 ? `Folder ${index % 8}/Note ${index}.md` : `Note ${index}.md`,
      degree: index % 13,
      orphan: index % 17 === 0,
    })));

    expect(graph).toMatchObject({ width: 1_000, height: 700 });
    for (const node of graph.nodes) {
      expect(Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.radius)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(node.radius);
      expect(node.x).toBeLessThanOrEqual(graph.width - node.radius);
      expect(node.y).toBeGreaterThanOrEqual(node.radius);
      expect(node.y).toBeLessThanOrEqual(graph.height - node.radius);
      if (node.orphan) expect(node.radius).toBe(5);
      else expect(node.radius).toBeGreaterThanOrEqual(6);
    }
  });

  it("handles empty and singleton vaults without invalid coordinates", () => {
    expect(layoutGraph([])).toEqual({ width: 1_000, height: 700, nodes: [] });
    expect(layoutGraph([{ path: "Only.md", degree: 0, orphan: true }]).nodes).toEqual([
      { path: "Only.md", degree: 0, orphan: true, x: 500, y: 350, radius: 5 },
    ]);
  });

  it("derives display degree from incoming and outgoing link counts", () => {
    expect(graphDegree({ outgoing_count: 3, backlink_count: 5 })).toBe(8);
  });
});
