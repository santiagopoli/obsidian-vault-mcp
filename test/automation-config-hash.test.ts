import { describe, expect, it } from "vitest";
import { automationConfigHash } from "../src/automations/configHash";
import type { AutomationDefinition } from "../src/automations/types";

const automation: AutomationDefinition = {
  id: "log-updates",
  enabled: true,
  scopes: ["vault:read"],
  match: {
    events: ["note.updated"],
    vaults: ["owner/vault"],
    paths: { include: ["**/*.md"], exclude: [] },
  },
  loop: { allow_automation_origin: false, max_depth: 0 },
  target: { kind: "internal", handler: "log-event" },
};

describe("automation config hashes", () => {
  it("is deterministic and changes with behavior", async () => {
    const first = await automationConfigHash(automation);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await automationConfigHash(structuredClone(automation))).toBe(first);
    expect(await automationConfigHash({ ...automation, enabled: false })).not.toBe(first);
  });
});
