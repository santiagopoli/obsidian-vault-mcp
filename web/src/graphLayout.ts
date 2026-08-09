export interface GraphLayoutInput {
  path: string;
  degree: number;
  orphan: boolean;
}

export interface PositionedGraphNode extends GraphLayoutInput {
  x: number;
  y: number;
  radius: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: PositionedGraphNode[];
}

const goldenAngle = Math.PI * (3 - Math.sqrt(5));

export function layoutGraph(nodes: GraphLayoutInput[], width = 1_000, height = 700): GraphLayout {
  const ordered = [...nodes].sort((left, right) => right.degree - left.degree || left.path.localeCompare(right.path));
  const centerX = width / 2;
  const centerY = height / 2;
  const usableRadius = Math.min(width, height) * 0.42;
  const folderOffsets = folderAngleOffsets(ordered);
  const positioned = ordered.map((node, index): PositionedGraphNode => {
    if (index === 0) return { ...node, x: centerX, y: centerY, radius: nodeRadius(node) };
    const progress = ordered.length <= 2 ? 0.5 : Math.sqrt(index / (ordered.length - 1));
    const radius = 34 + progress * (usableRadius - 34);
    const angle = index * goldenAngle + (folderOffsets.get(topFolder(node.path)) ?? 0);
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius * 0.78,
      radius: nodeRadius(node),
    };
  });
  return { width, height, nodes: positioned };
}

export function graphDegree(node: { outgoing_count: number; backlink_count: number }): number {
  return node.outgoing_count + node.backlink_count;
}

function nodeRadius(node: GraphLayoutInput): number {
  if (node.orphan) return 5;
  return Math.min(18, 6 + Math.sqrt(node.degree) * 2.2);
}

function folderAngleOffsets(nodes: GraphLayoutInput[]): Map<string, number> {
  const folders = [...new Set(nodes.map(({ path }) => topFolder(path)))].sort();
  return new Map(folders.map((folder, index) => [folder, folders.length <= 1 ? 0 : (index / folders.length) * Math.PI * 0.55]));
}

function topFolder(path: string): string {
  const segments = path.split("/");
  return segments.length > 1 ? segments[0] ?? "" : "";
}
