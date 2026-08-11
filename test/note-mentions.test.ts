import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_MENTIONS,
  activeNoteMention,
  extractMentionedPaths,
  insertNoteMention,
  mentionMenuKeyAction,
  parseMentionDocument,
  removeMentionOccurrence,
  serializeMentionDocument,
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
    expect(activeNoteMention("@[[Canon/A.md]]@next")).toEqual({ start: 15, end: 20, query: "next" });
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
      "@[[ Canon/B.md ]]",
      "@[[Broken\nPath.md]]",
    ].join(" "))).toEqual(["Canon/A] draft.md", "Canon/B.md"]);
    expect(extractMentionedPaths(Array.from({ length: 11 }, (_, index) => `@[[Note ${index}.md]]`).join(" "))).toHaveLength(11);
  });

  it("rejects unsafe insertion inputs instead of producing ambiguous tokens", () => {
    expect(() => insertNoteMention("@a", { start: -1, end: 2, query: "a" }, "A.md")).toThrow("range");
    expect(() => insertNoteMention("@a", { start: 0, end: 2, query: "a" }, "A\nB.md")).toThrow("path");
    expect(() => insertNoteMention("@a", { start: 0, end: 2, query: "a" }, "A]]B.md")).toThrow("path");
  });

  it("inserts mentions at the start, middle, and end without corrupting punctuation or whitespace", () => {
    const path = "Canon/Luz.md";
    const atStart = insertNoteMention("@lu begins", activeNoteMention("@lu begins", 3)!, path);
    const inMiddle = insertNoteMention("Ask @lu, please", activeNoteMention("Ask @lu, please", 7)!, path);
    const atEnd = insertNoteMention("Ask @lu", activeNoteMention("Ask @lu")!, path);
    const consecutiveValue = "@[[Canon/A.md]]@lu";
    const consecutive = insertNoteMention(consecutiveValue, activeNoteMention(consecutiveValue)!, path);

    expect(atStart.value).toBe("@[[Canon/Luz.md]] begins");
    expect(inMiddle.value).toBe("Ask @[[Canon/Luz.md]], please");
    expect(atEnd.value).toBe("Ask @[[Canon/Luz.md]] ");
    expect(atEnd.caret).toBe(atEnd.value.length);
    expect(consecutive.value).toBe("@[[Canon/A.md]]@[[Canon/Luz.md]] ");
  });
});

describe("inline mention document", () => {
  it("parses chips at the start, middle, end, and directly beside each other", () => {
    expect(parseMentionDocument("@[[A.md]] starts; @[[B.md]], then @[[C.md]]")).toEqual([
      { type: "mention", path: "A.md" },
      { type: "text", text: " starts; " },
      { type: "mention", path: "B.md" },
      { type: "text", text: ", then " },
      { type: "mention", path: "C.md" },
    ]);
    expect(parseMentionDocument("@[[A.md]]@[[B.md]]")).toEqual([
      { type: "mention", path: "A.md" },
      { type: "mention", path: "B.md" },
    ]);
  });

  it("preserves whitespace and punctuation in an exact Unicode round trip", () => {
    const value = "¿@[[Canon/María.md]]?  Sí—@[[世界/終わり.md]]!\nDespués.";
    const parts = parseMentionDocument(value);

    expect(serializeMentionDocument(parts)).toBe(value);
    expect(parts.filter(({ type }) => type === "mention")).toEqual([
      { type: "mention", path: "Canon/María.md" },
      { type: "mention", path: "世界/終わり.md" },
    ]);
  });

  it("turns only exact valid pasted paths into chips and leaves invalid markup editable as text", () => {
    const validPaths = new Set(["Canon/María.md"]);
    const pasted = "Known @[[Canon/María.md]], unknown @[[Canon/Maria.md]], spaced @[[ Canon/María.md ]], malformed @[[Broken";
    const parts = parseMentionDocument(pasted, validPaths);

    expect(parts).toEqual([
      { type: "text", text: "Known " },
      { type: "mention", path: "Canon/María.md" },
      { type: "text", text: ", unknown @[[Canon/Maria.md]], spaced @[[ Canon/María.md ]], malformed @[[Broken" },
    ]);
    expect(serializeMentionDocument(parts)).toBe(pasted);
    expect(parseMentionDocument(pasted.replace("María", "Maria"), validPaths)).toEqual([{ type: "text", text: pasted.replace("María", "Maria") }]);
  });

  it("removes one exact duplicate occurrence without mutating the source or normalizing surrounding text", () => {
    const value = "A @[[Same.md]]  and @[[Same.md]], end";
    const parts = parseMentionDocument(value);
    const removed = removeMentionOccurrence(parts, 1);

    expect(serializeMentionDocument(removed)).toBe("A @[[Same.md]]  and , end");
    expect(serializeMentionDocument(parts)).toBe(value);
    expect(() => removeMentionOccurrence(parts, 2)).toThrow("not found");
    expect(() => removeMentionOccurrence(parts, -1)).toThrow("occurrence");
  });

  it("rejects editor mention parts that cannot be serialized unambiguously", () => {
    expect(() => serializeMentionDocument([{ type: "mention", path: "" }])).toThrow("path");
    expect(() => serializeMentionDocument([{ type: "mention", path: "A]]B.md" }])).toThrow("path");
    expect(() => serializeMentionDocument([{ type: "mention", path: "A\nB.md" }])).toThrow("path");
  });
});

describe("mention dropdown keyboard actions", () => {
  it("wraps navigation, selects with Enter or Tab, closes with Escape, and ignores composition", () => {
    expect(mentionMenuKeyAction("ArrowDown", 2, 3)).toEqual({ type: "navigate", index: 0 });
    expect(mentionMenuKeyAction("ArrowUp", 0, 3)).toEqual({ type: "navigate", index: 2 });
    expect(mentionMenuKeyAction("Enter", 1, 3)).toEqual({ type: "select", index: 1 });
    expect(mentionMenuKeyAction("Tab", 9, 3)).toEqual({ type: "select", index: 0 });
    expect(mentionMenuKeyAction("Escape", 0, 0)).toEqual({ type: "close" });
    expect(mentionMenuKeyAction("Enter", 0, 0)).toEqual({ type: "none" });
    expect(mentionMenuKeyAction("ArrowDown", 0, 3, true)).toEqual({ type: "none" });
    expect(mentionMenuKeyAction("a", 0, 3)).toEqual({ type: "none" });
  });
});
