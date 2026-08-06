export const readScope = "vault:read";
export const writeScope = "vault:write";
export const supportedScopes = [readScope, writeScope] as const;

export function selectGrantedScopes(requested: string[], access: "read" | "write"): string[] {
  const scopes = requested.length === 0 ? [readScope, ...(access === "write" ? [writeScope] : [])] : [...new Set(requested)];
  const unknown = scopes.filter((scope) => !supportedScopes.includes(scope as typeof supportedScopes[number]));
  if (unknown.length) throw new Error(`Unsupported OAuth scope: ${unknown.join(", ")}`);
  const granted = scopes.filter((scope) => scope === readScope || (scope === writeScope && access === "write"));
  if (granted.includes(writeScope) && !granted.includes(readScope)) granted.unshift(readScope);
  return granted;
}
