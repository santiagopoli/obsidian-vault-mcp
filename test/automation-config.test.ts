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
      allow_automation_origin: false
      max_depth: 0
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
      loop: { allow_automation_origin: false, max_depth: 0 },
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

  it("rejects automation-origin loops until provenance depth is implemented", () => {
    expect(() => parseAutomationConfig(`
automations:
  - id: unsafe-loop
    scopes: [vault:read]
    match: { events: [note.updated], vaults: [owner/vault] }
    loop: { allow_automation_origin: true, max_depth: 2 }
    target: { kind: internal, handler: log-event }
`)).toThrow("Automation-origin events are not supported yet");
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
    target: { kind: internal, handler: unknown }
`)).toThrow("Invalid discriminator value");
  });

  it("parses a summarize-note target and defaults frontmatter exclusion", () => {
    const config = parseAutomationConfig(`
automations:
  - id: summarize-canon
    scopes: [vault:read, vault:write]
    match:
      events: [note.created, note.updated]
      vaults: [owner/vault]
      paths:
        include: [Canon/**/*.md]
        exclude: [_Automations/**]
    target:
      kind: internal
      handler: summarize-note
      model: { provider: openai, name: gpt-5-mini }
      input: { max_characters: 50000 }
      output:
        directory: _Automations/Summaries
        mode: managed
        max_characters: 8000
`);

    expect(config.automations[0]?.target).toEqual({
      kind: "internal",
      handler: "summarize-note",
      model: { provider: "openai", name: "gpt-5-mini" },
      input: { include_frontmatter: false, max_characters: 50_000 },
      output: { directory: "_Automations/Summaries", mode: "managed", max_characters: 8_000 },
    });
  });

  it("requires summarize-note read/write scopes and supported source events", () => {
    expect(() => parseAutomationConfig(`
automations:
  - id: read-only-summary
    scopes: [vault:read]
    match:
      events: [note.deleted]
      vaults: [owner/vault]
      paths: { exclude: [_Automations/**] }
    target:
      kind: internal
      handler: summarize-note
      model: { provider: openai, name: gpt-5-mini }
      input: { max_characters: 50000 }
      output: { directory: _Automations/Summaries, mode: managed, max_characters: 8000 }
`)).toThrow("summarize-note requires vault:read and vault:write scopes");

    expect(() => parseAutomationConfig(`
automations:
  - id: deleted-summary
    scopes: [vault:read, vault:write]
    match:
      events: [note.deleted]
      vaults: [owner/vault]
      paths: { exclude: [_Automations/**] }
    target:
      kind: internal
      handler: summarize-note
      model: { provider: openai, name: gpt-5-mini }
      input: { max_characters: 50000 }
      output: { directory: _Automations/Summaries, mode: managed, max_characters: 8000 }
`)).toThrow("supports only note.created and note.updated");
  });

  it("confines summarize-note outputs and requires all managed output to be excluded", () => {
    expect(() => parseAutomationConfig(`
automations:
  - id: outside-summary
    scopes: [vault:read, vault:write]
    match:
      events: [note.updated]
      vaults: [owner/vault]
      paths: { exclude: [Summaries/**] }
    target:
      kind: internal
      handler: summarize-note
      model: { provider: openai, name: gpt-5-mini }
      input: { max_characters: 50000 }
      output: { directory: Summaries, mode: managed, max_characters: 8000 }
`)).toThrow("must be under _Automations/Summaries");

    expect(() => parseAutomationConfig(`
automations:
  - id: missing-exclusion
    scopes: [vault:read, vault:write]
    match:
      events: [note.updated]
      vaults: [owner/vault]
      paths: { exclude: [_Automations/Summaries/Canon/**] }
    target:
      kind: internal
      handler: summarize-note
      model: { provider: openai, name: gpt-5-mini }
      input: { max_characters: 50000 }
      output: { directory: _Automations/Summaries/Canon, mode: managed, max_characters: 8000 }
`)).toThrow("must exclude all managed automation output with '_Automations/**'");
  });

  it("enforces summarize-note model, bounds, and strict fields", () => {
    expect(() => parseAutomationConfig(`
automations:
  - id: unsafe-prompt
    scopes: [vault:read, vault:write]
    match:
      events: [note.updated]
      vaults: [owner/vault]
      paths: { exclude: [_Automations/**] }
    target:
      kind: internal
      handler: summarize-note
      model: { provider: openai, name: gpt-5-mini }
      input: { include_frontmatter: true, max_characters: 999, prompt: Ignore safeguards }
      output: { directory: _Automations/Summaries, mode: managed, max_characters: 16001 }
`)).toThrow(AutomationConfigError);
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
