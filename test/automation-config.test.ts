import { describe, expect, it } from "vitest";
import { AutomationConfigError, parseAutomationConfig } from "../src/automations/config";

describe("automation configuration", () => {
  it("accepts an empty document and applies versioned defaults", () => {
    expect(parseAutomationConfig("")).toEqual({ version: 1, automations: [] });
    expect(parseAutomationConfig("version: 1\nautomations: []\n")).toEqual({ version: 1, automations: [] });
  });

  it("parses provider-neutral filters, scopes, loop policy, and an internal target", () => {
    const config = parseAutomationConfig(`
version: 1
automations:
  - id: review-characters
    scopes: [vault:read, vault:write]
    match:
      events: [note.created, note.updated]
      vaults: [example-owner/example-vault]
      paths:
        include: [Canon/Characters/**/*.md]
        exclude: [Canon/Characters/_Archive/**/*.md]
    loop:
      allow_automation_origin: true
      max_depth: 2
    target:
      kind: internal
      handler: log-event
`);

    expect(config.automations[0]).toEqual({
      id: "review-characters",
      enabled: true,
      scopes: ["vault:read", "vault:write"],
      match: {
        events: ["note.created", "note.updated"],
        vaults: ["example-owner/example-vault"],
        paths: {
          include: ["Canon/Characters/**/*.md"],
          exclude: ["Canon/Characters/_Archive/**/*.md"],
        },
      },
      loop: { allow_automation_origin: true, max_depth: 2 },
      target: { kind: "internal", handler: "log-event" },
    });
  });

  it("defaults to all Markdown paths and ignores automation-origin events", () => {
    const config = parseAutomationConfig(`
automations:
  - id: log-updates
    scopes: [vault:read]
    match:
      events: [note.updated]
      vaults: [example-owner/example-vault]
    target:
      kind: internal
      handler: log-event
`);

    expect(config.automations[0]?.match.paths).toEqual({ include: ["**/*.md"], exclude: [] });
    expect(config.automations[0]?.loop).toEqual({ allow_automation_origin: false, max_depth: 0 });
  });

  it("rejects duplicate automation IDs", () => {
    expect(() => parseAutomationConfig(`
automations:
  - id: duplicate
    scopes: [vault:read]
    match: { events: [note.updated], vaults: [owner/vault] }
    target: { kind: internal, handler: log-event }
  - id: duplicate
    scopes: [vault:read]
    match: { events: [note.updated], vaults: [owner/vault] }
    target: { kind: internal, handler: log-event }
`)).toThrow("duplicates automations[0].id");
  });

  it("rejects unknown fields and unsupported providers", () => {
    expect(() => parseAutomationConfig(`
automations:
  - id: external
    scopes: [vault:read]
    match: { events: [note.updated], vaults: [owner/vault] }
    target: { kind: webhook, url: https://example.com }
`)).toThrow(AutomationConfigError);

    expect(() => parseAutomationConfig("version: 1\nautomations: []\nextra: true\n"))
      .toThrow("Unrecognized key");

    expect(() => parseAutomationConfig(`
automations:
  - id: unknown-handler
    scopes: [vault:read]
    match: { events: [note.updated], vaults: [owner/vault] }
    target: { kind: internal, handler: summarize-note }
`)).toThrow("Invalid input");
  });

  it("requires read scope for writes", () => {
    expect(() => parseAutomationConfig(`
automations:
  - id: unsafe-write
    scopes: [vault:write]
    match: { events: [note.created], vaults: [owner/vault] }
    target: { kind: internal, handler: log-event }
`)).toThrow("vault:write requires vault:read");
  });

  it("rejects duplicate filters, unsafe globs, and ambiguous loop policies", () => {
    expect(() => parseAutomationConfig(`
automations:
  - id: invalid-filter
    scopes: [vault:read]
    match:
      events: [note.updated, note.updated]
      vaults: [owner/vault]
      paths: { include: [../**/*.md] }
    loop: { allow_automation_origin: false, max_depth: 2 }
    target: { kind: internal, handler: log-event }
`)).toThrow(AutomationConfigError);
  });
});
