import type { AutomationDefinition } from "./types";

export async function automationConfigHash(automation: AutomationDefinition): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(automation)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
