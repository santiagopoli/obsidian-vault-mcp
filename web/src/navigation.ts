export type AppRoute =
  | { view: "home" }
  | { view: "graph" }
  | { view: "note"; path: string };

export function parseAppRoute(href: string): AppRoute {
  const url = new URL(href, "https://vault.invalid");
  if (url.pathname === "/graph" || url.pathname === "/graph/") return { view: "graph" };
  if (url.pathname.startsWith("/notes/")) return noteRoute(url.pathname.slice("/notes/".length));
  const canonical = url.pathname.match(/^\/vaults\/([^/]+)(?:\/(.*))?$/);
  if (!canonical || !validVaultId(canonical[1])) return { view: "home" };
  const tail = canonical[2] ?? "";
  if (!tail) return { view: "home" };
  if (tail === "graph" || tail === "graph/") return { view: "graph" };
  if (tail.startsWith("notes/")) return noteRoute(tail.slice("notes/".length));
  return { view: "home" };
}

export function appRouteHref(route: AppRoute, vaultId?: string): string {
  if (vaultId && !/^\d+$/.test(vaultId)) throw new Error("Vault IDs must be numeric GitHub repository IDs");
  const base = vaultId ? `/vaults/${encodeURIComponent(vaultId)}` : "";
  if (route.view === "graph") return `${base}/graph`;
  if (route.view === "note") return `${base}/notes/${encodeNotePath(route.path)}`;
  return base || "/";
}

export function vaultIdFromHref(href: string): string | undefined {
  const url = new URL(href, "https://vault.invalid");
  const canonical = url.pathname.match(/^\/vaults\/([^/]+)/);
  if (canonical && validVaultId(canonical[1])) return decodeURIComponent(canonical[1]);
  const legacy = url.searchParams.get("vault");
  return legacy && validVaultId(legacy) ? legacy : undefined;
}

function noteRoute(encodedPath: string): AppRoute {
  const path = decodeNotePath(encodedPath);
  return path ? { view: "note", path } : { view: "home" };
}

function encodeNotePath(path: string): string {
  const segments = path.split("/");
  if (!path.toLocaleLowerCase().endsWith(".md") || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\\0]/.test(segment))) {
    throw new Error("Note paths must be safe Markdown paths");
  }
  return segments.map(encodeURIComponent).join("/");
}

function decodeNotePath(encodedPath: string): string | undefined {
  if (!encodedPath) return undefined;
  try {
    const segments = encodedPath.split("/").map(decodeURIComponent);
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\/\0]/.test(segment))) return undefined;
    const path = segments.join("/");
    return path.toLocaleLowerCase().endsWith(".md") ? path : undefined;
  } catch {
    return undefined;
  }
}

function validVaultId(encodedId: string): boolean {
  try {
    return /^\d+$/.test(decodeURIComponent(encodedId));
  } catch {
    return false;
  }
}
