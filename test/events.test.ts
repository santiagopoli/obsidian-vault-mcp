import { describe, expect, it } from "vitest";
import { deriveVaultEvents } from "../src/events";
import type { MarkdownTree } from "../src/github";

describe("vault events", () => {
  it("derives created, updated, and deleted notes by blob SHA", () => {
    const events = deriveVaultEvents("repository-42", tree("before-tree", [
      ["Deleted.md", "deleted-sha"],
      ["Unchanged.md", "same-sha"],
      ["Updated.md", "old-sha"],
    ]), tree("after-tree", [
      ["Created.md", "created-sha"],
      ["Unchanged.md", "same-sha"],
      ["Updated.md", "new-sha"],
    ]));

    expect(events).toEqual([
      expect.objectContaining({ type: "note.created", path: "Created.md", noteSha: "created-sha" }),
      expect.objectContaining({ type: "note.deleted", path: "Deleted.md", noteSha: "deleted-sha" }),
      expect.objectContaining({ type: "note.updated", path: "Updated.md", beforeSha: "old-sha", afterSha: "new-sha" }),
    ]);
    expect(events.every((event) => event.beforeRevision === "before-tree" && event.afterRevision === "after-tree")).toBe(true);
  });

  it("is deterministic regardless of input file ordering", () => {
    const before = tree("before", [["B.md", "old-b"], ["A.md", "old-a"]]);
    const after = tree("after", [["C.md", "new-c"], ["A.md", "new-a"]]);
    const reorderedBefore = tree("before", [...before.files].reverse().map(({ path, sha }) => [path, sha]));
    const reorderedAfter = tree("after", [...after.files].reverse().map(({ path, sha }) => [path, sha]));

    const first = deriveVaultEvents("vault", before, after);
    const second = deriveVaultEvents("vault", reorderedBefore, reorderedAfter);

    expect(first).toEqual(second);
    expect(first.map(({ path }) => path)).toEqual(["A.md", "B.md", "C.md"]);
    expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
  });

  it("uses the event ID as a stable idempotency key for the same tree transition", () => {
    const before = tree("before", [["Story/Capítulo 1.md", "old"]]);
    const after = tree("after", [["Story/Capítulo 1.md", "new"]]);

    const first = deriveVaultEvents("owner/vault", before, after)[0];
    const replay = deriveVaultEvents("owner/vault", before, after)[0];

    expect(first?.id).toBe(replay?.id);
    expect(first?.id).toContain("vault-event:v1:");
  });

  it("treats a same-SHA path move as one deletion and one creation", () => {
    const events = deriveVaultEvents(
      "vault",
      tree("before", [["Draft.md", "shared-sha"]]),
      tree("after", [["Published.md", "shared-sha"]]),
    );

    expect(events).toEqual([
      expect.objectContaining({ type: "note.deleted", path: "Draft.md", noteSha: "shared-sha" }),
      expect.objectContaining({ type: "note.created", path: "Published.md", noteSha: "shared-sha" }),
    ]);
  });

  it("emits no event for unchanged notes", () => {
    expect(deriveVaultEvents(
      "vault",
      tree("before", [["Note.md", "same"]]),
      tree("after", [["Note.md", "same"]]),
    )).toEqual([]);
  });

  it("rejects duplicate paths instead of deriving ambiguous events", () => {
    expect(() => deriveVaultEvents(
      "vault",
      tree("before", [["Note.md", "one"], ["Note.md", "two"]]),
      tree("after", []),
    )).toThrow("duplicate path 'Note.md'");
  });
});

function tree(revision: string, files: Array<[path: string, sha: string]>): MarkdownTree {
  return {
    revision,
    files: files.map(([path, sha]) => ({ path, sha, type: "blob" })),
  };
}
