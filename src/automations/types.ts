export const automationEventTypes = ["note.created", "note.updated", "note.deleted"] as const;

export type AutomationEventType = typeof automationEventTypes[number];

export const automationScopes = ["vault:read", "vault:write"] as const;

export type AutomationScope = typeof automationScopes[number];

export interface AutomationPathFilter {
  include: string[];
  exclude: string[];
}

export interface AutomationMatch {
  events: AutomationEventType[];
  vaults: string[];
  paths: AutomationPathFilter;
}

export type AutomationLoopPolicy =
  | {
      allow_automation_origin: false;
      max_depth: 0;
    }
  | {
      allow_automation_origin: true;
      max_depth: number;
    };

export interface LogEventAutomationTarget {
  kind: "internal";
  handler: "log-event";
}

export interface SummarizeNoteAutomationTarget {
  kind: "internal";
  handler: "summarize-note";
  model: {
    provider: "openai";
    name: string;
  };
  input: {
    include_frontmatter: boolean;
    max_characters: number;
  };
  output: {
    directory: string;
    mode: "managed";
    max_characters: number;
  };
}

export type InternalAutomationTarget = LogEventAutomationTarget | SummarizeNoteAutomationTarget;

export type AutomationTarget = InternalAutomationTarget;

export interface AutomationDefinition {
  id: string;
  enabled: boolean;
  scopes: AutomationScope[];
  match: AutomationMatch;
  loop: AutomationLoopPolicy;
  target: AutomationTarget;
}

export interface AutomationConfig {
  version: 1;
  automations: AutomationDefinition[];
}
