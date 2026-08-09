import type { NoteSummary } from "./api";

export type NoteTreeNode = NoteFolder | NoteLeaf;

export interface NoteFolder {
  type: "folder";
  name: string;
  path: string;
  children: NoteTreeNode[];
}

export interface NoteLeaf {
  type: "note";
  name: string;
  note: NoteSummary;
}

export function buildNoteTree(notes: NoteSummary[], filter: string): NoteTreeNode[] {
  const normalizedFilter = normalize(filter.trim());
  const visible = normalizedFilter
    ? notes.filter((note) => normalize(note.path).includes(normalizedFilter))
    : notes;
  const root: NoteFolder = { type: "folder", name: "", path: "", children: [] };

  for (const note of visible) {
    const segments = note.path.split("/");
    const fileName = segments.pop() ?? note.path;
    let folder = root;
    for (const segment of segments) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      let child = folder.children.find((node): node is NoteFolder => node.type === "folder" && node.name === segment);
      if (!child) {
        child = { type: "folder", name: segment, path, children: [] };
        folder.children.push(child);
      }
      folder = child;
    }
    folder.children.push({ type: "note", name: fileName.replace(/\.md$/i, ""), note });
  }

  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: NoteTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const node of nodes) if (node.type === "folder") sortTree(node.children);
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}
