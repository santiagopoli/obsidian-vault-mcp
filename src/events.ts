import type { MarkdownTree } from "./github";

interface VaultEventBase {
  id: string;
  vaultId: string;
  beforeRevision: string;
  afterRevision: string;
  path: string;
}

export interface NoteCreatedEvent extends VaultEventBase {
  type: "note.created";
  noteSha: string;
}

export interface NoteUpdatedEvent extends VaultEventBase {
  type: "note.updated";
  beforeSha: string;
  afterSha: string;
}

export interface NoteDeletedEvent extends VaultEventBase {
  type: "note.deleted";
  noteSha: string;
}

export type VaultEvent = NoteCreatedEvent | NoteUpdatedEvent | NoteDeletedEvent;

export function deriveVaultEvents(vaultId: string, before: MarkdownTree, after: MarkdownTree): VaultEvent[] {
  if (!vaultId) throw new Error("Vault ID must not be empty");

  const beforeByPath = filesByPath(before);
  const afterByPath = filesByPath(after);
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort(compareText);

  return paths.flatMap((path): VaultEvent[] => {
    const beforeSha = beforeByPath.get(path);
    const afterSha = afterByPath.get(path);

    if (!beforeSha && afterSha) {
      return [{
        id: eventId(vaultId, before.revision, after.revision, "note.created", path, undefined, afterSha),
        type: "note.created",
        vaultId,
        beforeRevision: before.revision,
        afterRevision: after.revision,
        path,
        noteSha: afterSha,
      }];
    }

    if (beforeSha && !afterSha) {
      return [{
        id: eventId(vaultId, before.revision, after.revision, "note.deleted", path, beforeSha, undefined),
        type: "note.deleted",
        vaultId,
        beforeRevision: before.revision,
        afterRevision: after.revision,
        path,
        noteSha: beforeSha,
      }];
    }

    if (beforeSha && afterSha && beforeSha !== afterSha) {
      return [{
        id: eventId(vaultId, before.revision, after.revision, "note.updated", path, beforeSha, afterSha),
        type: "note.updated",
        vaultId,
        beforeRevision: before.revision,
        afterRevision: after.revision,
        path,
        beforeSha,
        afterSha,
      }];
    }

    return [];
  });
}

function filesByPath(tree: MarkdownTree): Map<string, string> {
  if (!tree.revision) throw new Error("Markdown tree revision must not be empty");

  const files = new Map<string, string>();
  for (const file of tree.files) {
    if (files.has(file.path)) throw new Error(`Markdown tree contains duplicate path '${file.path}'`);
    files.set(file.path, file.sha);
  }
  return files;
}

function eventId(
  vaultId: string,
  beforeRevision: string,
  afterRevision: string,
  type: VaultEvent["type"],
  path: string,
  beforeSha: string | undefined,
  afterSha: string | undefined,
): string {
  const parts = [vaultId, beforeRevision, afterRevision, type, path, beforeSha ?? "", afterSha ?? ""];
  return `vault-event:v1:${parts.map(encodeURIComponent).join(":")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
