import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  automationEventTypes,
  automationScopes,
  type AutomationConfig,
} from "./types";

const identifierPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const summariesDirectory = "_Automations/Summaries";

const uniqueArray = <T extends z.ZodTypeAny>(item: T, label: string) => z.array(item)
  .max(50)
  .superRefine((values, context) => {
    const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
    if (duplicates.length > 0) {
      context.addIssue({
        code: "custom",
        message: `${label} must not contain duplicates: ${[...new Set(duplicates)].join(", ")}`,
      });
    }
  });

const globSchema = z.string().min(1).max(500).superRefine((pattern, context) => {
  if (pattern.startsWith("/") || pattern.includes("\\") || pattern.includes("\0")) {
    context.addIssue({ code: "custom", message: "Path globs must be relative POSIX paths" });
  }
  if (pattern.split("/").includes("..")) {
    context.addIssue({ code: "custom", message: "Path globs must not traverse outside the vault" });
  }
});

const pathFilterSchema = z.object({
  include: uniqueArray(globSchema, "match.paths.include").min(1).default(["**/*.md"]),
  exclude: uniqueArray(globSchema, "match.paths.exclude").default([]),
}).strict().default({ include: ["**/*.md"], exclude: [] });

const matchSchema = z.object({
  events: uniqueArray(z.enum(automationEventTypes), "match.events").min(1),
  vaults: uniqueArray(
    z.string().regex(repositoryPattern, "Vaults must use owner/repository format"),
    "match.vaults",
  ).min(1),
  paths: pathFilterSchema,
}).strict();

const scopeSchema = uniqueArray(z.enum(automationScopes), "scopes")
  .min(1)
  .superRefine((scopes, context) => {
    if (scopes.includes("vault:write") && !scopes.includes("vault:read")) {
      context.addIssue({ code: "custom", message: "vault:write requires vault:read" });
    }
  });

const loopPolicySchema = z.discriminatedUnion("allow_automation_origin", [
  z.object({
    allow_automation_origin: z.literal(false),
    max_depth: z.literal(0).default(0),
  }).strict(),
  z.object({
    allow_automation_origin: z.literal(true),
    max_depth: z.number().int().min(1).max(8),
  }).strict(),
]).default({ allow_automation_origin: false, max_depth: 0 });

const visibleSummariesDirectorySchema = z.string().min(1).max(500).superRefine((directory, context) => {
  const segments = directory.split("/");
  if (
    directory.startsWith("/") ||
    directory.endsWith("/") ||
    directory.includes("\\") ||
    directory.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    context.addIssue({ code: "custom", message: "Output directory must be a visible relative POSIX path" });
  }
  if (directory !== summariesDirectory && !directory.startsWith(`${summariesDirectory}/`)) {
    context.addIssue({ code: "custom", message: `Output directory must be under ${summariesDirectory}` });
  }
});

const targetSchema = z.discriminatedUnion("handler", [
  z.object({
    kind: z.literal("internal"),
    handler: z.literal("log-event"),
  }).strict(),
  z.object({
    kind: z.literal("internal"),
    handler: z.literal("summarize-note"),
    model: z.object({
      provider: z.literal("openai"),
      name: z.string().trim().min(1).max(200),
    }).strict(),
    input: z.object({
      include_frontmatter: z.boolean().default(false),
      max_characters: z.number().int().min(1_000).max(100_000),
    }).strict(),
    output: z.object({
      directory: visibleSummariesDirectorySchema,
      mode: z.literal("managed"),
      max_characters: z.number().int().min(256).max(16_000),
    }).strict(),
  }).strict(),
]);

const automationSchema = z.object({
  id: z.string().regex(identifierPattern, "Automation ID must be lower-case hyphen-case"),
  enabled: z.boolean().default(true),
  scopes: scopeSchema,
  match: matchSchema,
  loop: loopPolicySchema,
  target: targetSchema,
}).strict().superRefine((automation, context) => {
  if (automation.loop.allow_automation_origin) {
    context.addIssue({
      code: "custom",
      path: ["loop", "allow_automation_origin"],
      message: "Automation-origin events are not supported yet",
    });
  }
  if (automation.target.handler !== "summarize-note") return;

  if (!automation.scopes.includes("vault:read") || !automation.scopes.includes("vault:write")) {
    context.addIssue({
      code: "custom",
      path: ["scopes"],
      message: "summarize-note requires vault:read and vault:write scopes",
    });
  }
  const unsupportedEvents = automation.match.events.filter(
    (event) => event !== "note.created" && event !== "note.updated",
  );
  if (unsupportedEvents.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["match", "events"],
      message: "summarize-note supports only note.created and note.updated events",
    });
  }
  const requiredExclusion = "_Automations/**";
  if (!automation.match.paths.exclude.includes(requiredExclusion)) {
    context.addIssue({
      code: "custom",
      path: ["match", "paths", "exclude"],
      message: `summarize-note must exclude all managed automation output with '${requiredExclusion}'`,
    });
  }
});

export const automationConfigSchema = z.object({
  version: z.literal(1).default(1),
  automations: z.array(automationSchema).max(100).default([]),
}).strict().superRefine((config, context) => {
  const positions = new Map<string, number>();
  config.automations.forEach((automation, index) => {
    const previous = positions.get(automation.id);
    if (previous !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["automations", index, "id"],
        message: `Automation ID '${automation.id}' duplicates automations[${previous}].id`,
      });
    } else {
      positions.set(automation.id, index);
    }
  });
});

export class AutomationConfigError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AutomationConfigError";
  }
}

export function parseAutomationConfig(source: string): AutomationConfig {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    throw new AutomationConfigError(`Automation configuration contains invalid YAML: ${errorMessage(error)}`, error);
  }

  const result = automationConfigSchema.safeParse(document ?? {});
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
      .join("; ");
    throw new AutomationConfigError(`Automation configuration is invalid: ${details}`, result.error);
  }
  return result.data as AutomationConfig;
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return "config";
  return path.reduce<string>((formatted, segment) => (
    typeof segment === "number"
      ? `${formatted}[${segment}]`
      : `${formatted}${formatted ? "." : ""}${String(segment)}`
  ), "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown parse error";
}
