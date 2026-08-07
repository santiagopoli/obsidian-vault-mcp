import { describe, expect, it, vi } from "vitest";
import {
  summarizeNote,
  summaryOutputPath,
  type ExistingSummary,
  type PreboundSummaryWriter,
  type SummaryWriteRequest,
} from "../src/automations/summarizeNote";
import type { SummarizeNoteAutomationTarget } from "../src/automations/types";

const sourceSha = "a".repeat(40);
const eventId = "vault-event:v1:event-1";

describe("summarize-note", () => {
  it("strips frontmatter and writes a managed summary to a deterministic nested path", async () => {
    const model = vi.fn().mockResolvedValue("  Un héroe vuelve a casa.  ");
    const writer = memoryWriter("Generated/Summaries/Characters/Hero.summary.md");

    const result = await summarizeNote({
      automationId: "character-summary",
      eventId,
      source: {
        path: "Characters/Hero.md",
        sha: sourceSha,
        content: "---\ntags: [hero]\n---\n# Hero\n\nHistoria",
      },
      target: summarizeTarget({ directory: "Generated/Summaries", includeFrontmatter: false }),
      model,
      writer,
    });

    expect(result).toMatchObject({ status: "written", path: writer.path, sourceSha, eventId });
    expect(model).toHaveBeenCalledWith({
      path: "Characters/Hero.md",
      content: "# Hero\n\nHistoria",
      model: "gpt-summary",
      maxCharacters: 1_000,
    });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `automation:v1:character-summary:${eventId}`,
      content: expect.stringContaining('"owner":"character-summary"'),
    }));
    expect((writer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].content).toContain("\n\nUn héroe vuelve a casa.\n");
  });

  it("preserves frontmatter unless stripping is explicitly enabled", async () => {
    const model = vi.fn().mockResolvedValue("Summary");
    const writer = memoryWriter("Summaries/Note.summary.md");
    await summarizeNote({
      automationId: "note-summary",
      eventId,
      source: { path: "Note.md", sha: sourceSha, content: "---\ntag: one\n---\nBody" },
      target: summarizeTarget({ includeFrontmatter: true }),
      model,
      writer,
    });
    expect(model.mock.calls[0]?.[0].content).toContain("tag: one");
  });

  it("detects a replay before invoking the model or writer", async () => {
    const managed = managedContent("note-summary", eventId, sourceSha, "Existing summary");
    const model = vi.fn();
    const writer = memoryWriter("Summaries/Note.summary.md", { sha: "existing-sha", content: managed });

    await expect(summarizeNote({
      automationId: "note-summary",
      eventId,
      source: { path: "Note.md", sha: sourceSha, content: "Body" },
      target: summarizeTarget(),
      model,
      writer,
    })).resolves.toEqual({
      status: "replayed",
      path: writer.path,
      contentSha: "existing-sha",
      sourceSha,
      eventId,
    });
    expect(model).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("updates output owned by the same automation using optimistic concurrency", async () => {
    const existing = managedContent("note-summary", "older-event", "b".repeat(40), "Old summary");
    const writer = memoryWriter("Summaries/Note.summary.md", { sha: "current-output-sha", content: existing });

    await summarizeNote({
      automationId: "note-summary",
      eventId,
      source: { path: "Note.md", sha: sourceSha, content: "New body" },
      target: summarizeTarget(),
      model: vi.fn().mockResolvedValue("New summary"),
      writer,
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({ expectedSha: "current-output-sha" }));
  });

  it("refuses to overwrite human output or output owned by another automation", async () => {
    const humanWriter = memoryWriter("Summaries/Note.summary.md", { sha: "human", content: "Human notes" });
    const otherWriter = memoryWriter("Summaries/Note.summary.md", {
      sha: "other",
      content: managedContent("other-owner", "other-event", sourceSha, "Other"),
    });
    const request = {
      automationId: "note-summary",
      eventId,
      source: { path: "Note.md", sha: sourceSha, content: "Body" },
      target: summarizeTarget(),
      model: vi.fn().mockResolvedValue("Summary"),
    };

    await expect(summarizeNote({ ...request, writer: humanWriter })).rejects.toThrow("not managed");
    await expect(summarizeNote({ ...request, writer: otherWriter })).rejects.toThrow("another automation");
    expect(request.model).not.toHaveBeenCalled();
  });

  it("enforces input and output character limits", async () => {
    const inputModel = vi.fn();
    await expect(summarizeNote({
      automationId: "note-summary",
      eventId,
      source: { path: "Note.md", sha: sourceSha, content: "four" },
      target: summarizeTarget({ maxInputCharacters: 3 }),
      model: inputModel,
      writer: memoryWriter("Summaries/Note.summary.md"),
    })).rejects.toThrow("input exceeds");
    expect(inputModel).not.toHaveBeenCalled();

    await expect(summarizeNote({
      automationId: "note-summary",
      eventId,
      source: { path: "Note.md", sha: sourceSha, content: "Body" },
      target: summarizeTarget({ maxOutputCharacters: 3 }),
      model: vi.fn().mockResolvedValue("four"),
      writer: memoryWriter("Summaries/Note.summary.md"),
    })).rejects.toThrow("output exceeds");
  });

  it("requires the writer to be prebound to the derived safe output path", async () => {
    expect(summaryOutputPath("Summaries", "Folder/Note.md")).toBe("Summaries/Folder/Note.summary.md");
    expect(() => summaryOutputPath("../Outside", "Note.md")).toThrow("visible relative folder");

    await expect(summarizeNote({
      automationId: "note-summary",
      eventId,
      source: { path: "Note.md", sha: sourceSha, content: "Body" },
      target: summarizeTarget(),
      model: vi.fn().mockResolvedValue("Summary"),
      writer: memoryWriter("Elsewhere/Note.summary.md"),
    })).rejects.toThrow("prebound");
  });
});

function memoryWriter(path: string, existing?: ExistingSummary): PreboundSummaryWriter {
  return {
    path,
    read: vi.fn().mockResolvedValue(existing),
    write: vi.fn(async (_request: SummaryWriteRequest) => ({
      contentSha: "new-content-sha",
      commitSha: "new-commit-sha",
      created: !existing,
    })),
  };
}

function summarizeTarget(options: {
  directory?: string;
  includeFrontmatter?: boolean;
  maxInputCharacters?: number;
  maxOutputCharacters?: number;
} = {}): SummarizeNoteAutomationTarget {
  return {
    kind: "internal",
    handler: "summarize-note",
    model: { provider: "openai", name: "gpt-summary" },
    input: {
      include_frontmatter: options.includeFrontmatter ?? false,
      max_characters: options.maxInputCharacters ?? 10_000,
    },
    output: {
      directory: options.directory ?? "Summaries",
      mode: "managed",
      max_characters: options.maxOutputCharacters ?? 1_000,
    },
  };
}

function managedContent(owner: string, managedEventId: string, managedSourceSha: string, body: string): string {
  return `<!-- obsidian-vault-mcp-managed ${JSON.stringify({
    version: 1,
    handler: "summarize-note",
    owner,
    eventId: managedEventId,
    sourceSha: managedSourceSha,
  })} -->\n\n${body}\n`;
}
