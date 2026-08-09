import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_MENTIONS,
  activeNoteMention,
  extractMentionedPaths,
  insertNoteMention,
  suggestNoteMentions,
} from "../web/src/noteMentions";

const notes = [
  { path: "Canon/Characters/María.md" },
  { path: "Drafts/Maria at Sea.md" },
  { path: "Maria/Index.md" },
  { path: "Places/Marina.md" },
  { path: "README.md" },
];

describe("note mentions", () => {
  it("finds the active @ query at the caret without treating emails or completed mentions as queries", () => {
    expect(activeNoteMention("Ask @María")).toEqual({ start: 4, end: 10, query: "María" });
    expect(activeNoteMention("(@Canon Char")).toEqual({ start: 1, end: 12, query: "Canon Char" });
    expect(activeNoteMention("mail@example.com")).toBeUndefined();
    expect(activeNoteMention("Ask @[[Canon/Characters/María.md]]")).toBeUndefined();
    expect(activeNoteMention("Ask @María", 99)).toBeUndefined();
  });

  it("ranks title matches before path matches and excludes notes already mentioned", () => {
    expect(suggestNoteMentions(notes, "maria", ["Drafts/Maria at Sea.md"]).map(({ path }) => path)).toEqual([
      "Canon/Characters/María.md",
      "Maria/Index.md",
    ]);
    expect(suggestNoteMentions(notes, "characters").map(({ path }) => path)).toEqual(["Canon/Characters/María.md"]);
    expect(suggestNoteMentions(notes, "", Array.from({ length: MAX_NOTE_MENTIONS }, (_, index) => `${index}.md`))).toEqual([]);
  });

  it("inserts an exact-path token while preserving text and caret position", () => {
    const value = "Compare @maria with the ending";
    const active = activeNoteMention(value, "Compare @maria".length)!;
    const inserted = insertNoteMention(value, active, "Canon/Characters/María.md");

    expect(inserted.value).toBe("Compare @[[Canon/Characters/María.md]] with the ending");
    expect(inserted.value.slice(inserted.caret)).toBe(" with the ending");
    expect(extractMentionedPaths(inserted.value)).toEqual(["Canon/Characters/María.md"]);
  });

  it("extracts unique exact paths in order and ignores malformed or multiline tokens", () => {
    expect(extractMentionedPaths([
      "@[[Canon/A] draft.md]]",
      "@[[Canon/B.md]]",
      "@[[Canon/A] draft.md]]",
      "@[[ ]]",
      "@[[Broken\nPath.md]]",
    ].join(" "))).toEqual(["Canon/A] draft.md", "Canon/B.md"]);
    expect(extractMentionedPaths(Array.from({ length: 11 }, (_, index) => `@[[Note ${index}.md]]`).join(" "))).toHaveLength(11);
  });

  it("rejects unsafe insertion inputs instead of producing ambiguous tokens", () => {
    expect(() => insertNoteMention("@a", { start: -1, end: 2, query: "a" }, "A.md")).toThrow("range");
    expect(() => insertNoteMention("@a", { start: 0, end: 2, query: "a" }, "A\nB.md")).toThrow("path");
  });
});
