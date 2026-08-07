import type { VaultEvent } from "../events";
import type { AutomationDefinition } from "./types";

export function automationMatches(automation: AutomationDefinition, vault: string, event: VaultEvent): boolean {
  if (!automation.enabled) return false;
  if (!automation.match.vaults.includes(vault)) return false;
  if (!automation.match.events.includes(event.type)) return false;
  if (!automation.match.paths.include.some((pattern) => matchesPathGlob(pattern, event.path))) return false;
  return !automation.match.paths.exclude.some((pattern) => matchesPathGlob(pattern, event.path));
}

export function matchesPathGlob(pattern: string, path: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      expression += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else {
      expression += escapeRegularExpression(character ?? "");
    }
  }
  return new RegExp(`${expression}$`).test(path);
}

function escapeRegularExpression(value: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(value) ? `\\${value}` : value;
}
