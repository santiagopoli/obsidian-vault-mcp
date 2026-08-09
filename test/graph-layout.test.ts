import { describe, expect, it } from "vitest";
import { graphDegree, layoutGraph, settleGraphLayout, type GraphLayoutInput } from "../web/src/graphLayout";

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
      if (node.orphan) expect(node.radius).toBe(4);
      else expect(node.radius).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("handles empty and singleton vaults without invalid coordinates", () => {
    expect(layoutGraph([])).toEqual({ width: 1_000, height: 700, nodes: [] });
    expect(layoutGraph([{ path: "Only.md", degree: 0, orphan: true }]).nodes).toEqual([
      { path: "Only.md", degree: 0, orphan: true, x: 500, y: 350, radius: 4 },
    ]);
  });

  it("derives display degree from incoming and outgoing link counts", () => {
    expect(graphDegree({ outgoing_count: 3, backlink_count: 5 })).toBe(8);
  });

  it("keeps a dragged node pinned while connected nodes settle around it", () => {
    const nodes = [
      { path: "A.md", degree: 1, orphan: false, x: 100, y: 100, radius: 8 },
      { path: "B.md", degree: 1, orphan: false, x: 900, y: 600, radius: 8 },
    ];
    const settled = settleGraphLayout(nodes, [{ source: "A.md", target: "B.md" }], new Map([["A.md", { x: 240, y: 260 }]]), 20);

    expect(settled[0]).toMatchObject({ path: "A.md", x: 240, y: 260 });
    expect(settled[1]).not.toMatchObject({ x: 900, y: 600 });
    expect(settled[1]?.x).toBeLessThanOrEqual(992);
    expect(settled[1]?.y).toBeLessThanOrEqual(692);
    expect(nodes[0]).toMatchObject({ x: 100, y: 100 });
  });

  it("keeps a connected vault spread across the canvas after its initial settling", () => {
    const inputs = Array.from({ length: 30 }, (_, index): GraphLayoutInput => ({
      path: `Notes/Note ${index}.md`,
      degree: index === 0 ? 29 : 1,
      orphan: false,
    }));
    const edges = inputs.slice(1).map(({ path }) => ({ source: inputs[0]!.path, target: path }));
    const initial = layoutGraph(inputs);
    const settled = settleGraphLayout(initial.nodes, edges, new Map(), 36, initial.width, initial.height);
    const xs = settled.map(({ x }) => x);
    const ys = settled.map(({ y }) => y);

    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(initial.width * .5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(initial.height * .5);
  });

  it("does not collapse the graph across repeated drag settling events", () => {
    const inputs = Array.from({ length: 30 }, (_, index): GraphLayoutInput => ({
      path: `Notes/Note ${index}.md`,
      degree: index === 0 ? 29 : 1,
      orphan: false,
    }));
    const hub = inputs[0]!.path;
    const edges = inputs.slice(1).map(({ path }) => ({ source: hub, target: path }));
    const initial = layoutGraph(inputs);
    let dragged = settleGraphLayout(initial.nodes, edges, new Map(), 36, initial.width, initial.height);
    let pinned = new Map<string, { x: number; y: number }>();

    for (let step = 0; step < 16; step += 1) {
      pinned = new Map([[hub, { x: 500 + step * 5, y: 350 + step * 2 }]]);
      dragged = settleGraphLayout(dragged, edges, pinned, 4, initial.width, initial.height);
    }
    dragged = settleGraphLayout(dragged, edges, pinned, 18, initial.width, initial.height);

    const xs = dragged.map(({ x }) => x);
    const ys = dragged.map(({ y }) => y);
    expect(dragged.find(({ path }) => path === hub)).toMatchObject(pinned.get(hub)!);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(initial.width * .5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(initial.height * .5);
  });

  it("separates overlapping nodes without moving them outside the canvas", () => {
    const settled = settleGraphLayout([
      { path: "A.md", degree: 0, orphan: true, x: 500, y: 350, radius: 8 },
      { path: "B.md", degree: 0, orphan: true, x: 500, y: 350, radius: 8 },
    ], [], new Map(), 20);

    expect(Math.hypot((settled[0]?.x ?? 0) - (settled[1]?.x ?? 0), (settled[0]?.y ?? 0) - (settled[1]?.y ?? 0))).toBeGreaterThan(20);
    for (const node of settled) {
      expect(node.x).toBeGreaterThanOrEqual(node.radius);
      expect(node.x).toBeLessThanOrEqual(1_000 - node.radius);
      expect(node.y).toBeGreaterThanOrEqual(node.radius);
      expect(node.y).toBeLessThanOrEqual(700 - node.radius);
    }
  });
});
