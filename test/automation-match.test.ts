import { describe, expect, it } from "vitest";
import { automationMatches, matchesPathGlob } from "../src/automations/match";
import type { AutomationDefinition } from "../src/automations/types";
import type { VaultEvent } from "../src/events";

const automation: AutomationDefinition = {
  id: "characters",
  enabled: true,
  scopes: ["vault:read"],
  match: {
    events: ["note.created", "note.updated"],
    vaults: ["owner/vault"],
    paths: { include: ["Characters/**/*.md"], exclude: ["Characters/_Archive/**"] },
  },
  loop: { allow_automation_origin: false, max_depth: 0 },
  target: { kind: "internal", handler: "log-event" },
};

describe("automation matching", () => {
  it("supports deterministic single and recursive path globs", () => {
    expect(matchesPathGlob("**/*.md", "Note.md")).toBe(true);
    expect(matchesPathGlob("**/*.md", "Folder/Note.md")).toBe(true);
    expect(matchesPathGlob("Characters/**/*.md", "Characters/Hero.md")).toBe(true);
    expect(matchesPathGlob("Characters/**/*.md", "Characters/Allies/Hero.md")).toBe(true);
    expect(matchesPathGlob("Characters/*.md", "Characters/Allies/Hero.md")).toBe(false);
  });

  it("requires enabled, event, vault, include, and exclude filters", () => {
    expect(automationMatches(automation, "owner/vault", event("note.updated", "Characters/Hero.md"))).toBe(true);
    expect(automationMatches(automation, "owner/vault", event("note.deleted", "Characters/Hero.md"))).toBe(false);
    expect(automationMatches(automation, "other/vault", event("note.updated", "Characters/Hero.md"))).toBe(false);
    expect(automationMatches(automation, "owner/vault", event("note.updated", "World/Hero.md"))).toBe(false);
    expect(automationMatches(automation, "owner/vault", event("note.updated", "Characters/_Archive/Hero.md"))).toBe(false);
    expect(automationMatches({ ...automation, enabled: false }, "owner/vault", event("note.updated", "Characters/Hero.md"))).toBe(false);
  });
});

function event(type: VaultEvent["type"], path: string): VaultEvent {
  const base = { id: "event", vaultId: "vault", beforeRevision: "before", afterRevision: "after", path };
  if (type === "note.created") return { ...base, type, noteSha: "after" };
  if (type === "note.deleted") return { ...base, type, noteSha: "before" };
  return { ...base, type, beforeSha: "before", afterSha: "after" };
}
