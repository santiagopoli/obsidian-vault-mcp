import { describe, expect, it } from "vitest";
import { appRouteHref, parseAppRoute, vaultIdFromHref, type AppRoute } from "../web/src/navigation";

describe("web workspace navigation", () => {
  it("round-trips canonical vault, graph, and note URLs", () => {
    const routes: AppRoute[] = [
      { view: "home" },
      { view: "graph" },
      { view: "note", path: "Canon/Personajes/María 100%.md" },
    ];

    for (const route of routes) {
      const href = appRouteHref(route, "42");
      expect(vaultIdFromHref(href)).toBe("42");
      expect(parseAppRoute(href)).toEqual(route);
    }
    expect(appRouteHref({ view: "home" }, "42")).toBe("/vaults/42");
    expect(appRouteHref({ view: "graph" }, "42")).toBe("/vaults/42/graph");
    expect(appRouteHref({ view: "note", path: "Canon/María 100%.md" }, "42"))
      .toBe("/vaults/42/notes/Canon/Mar%C3%ADa%20100%25.md");
  });

  it("keeps the unscoped graph and note routes as direct-link aliases", () => {
    expect(parseAppRoute("https://vault.example/graph")).toEqual({ view: "graph" });
    expect(parseAppRoute("https://vault.example/notes/Canon/Opening.md"))
      .toEqual({ view: "note", path: "Canon/Opening.md" });
    expect(vaultIdFromHref("https://vault.example/graph?vault=42")).toBe("42");
  });

  it("derives each state from its URL so browser back and forward restore the workspace", () => {
    const history = [
      "/vaults/7",
      "/vaults/7/notes/Story/Opening.md",
      "/vaults/7/graph",
      "/vaults/7/notes/Story/Ending.md",
    ];
    const expected: AppRoute[] = [
      { view: "home" },
      { view: "note", path: "Story/Opening.md" },
      { view: "graph" },
      { view: "note", path: "Story/Ending.md" },
    ];

    expect(history.map(parseAppRoute)).toEqual(expected);
    expect([...history].reverse().map(parseAppRoute)).toEqual([...expected].reverse());
  });

  it("fails closed for malformed note encodings", () => {
    expect(parseAppRoute("https://vault.example/notes/%ZZ.md")).toEqual({ view: "home" });
    expect(parseAppRoute("https://vault.example/vaults/7/notes/%E0%A4%A.md")).toEqual({ view: "home" });
  });
});
