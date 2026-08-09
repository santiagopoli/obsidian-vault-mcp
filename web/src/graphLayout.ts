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

export interface GraphPosition {
  x: number;
  y: number;
}

export interface GraphLayoutEdge {
  source: string;
  target: string;
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

export function settleGraphLayout(
  nodes: PositionedGraphNode[],
  edges: GraphLayoutEdge[],
  pinned: ReadonlyMap<string, GraphPosition> = new Map(),
  iterations = 32,
  width = 1_000,
  height = 700,
): PositionedGraphNode[] {
  const positioned = nodes.map((node) => ({ ...node }));
  const indexByPath = new Map(positioned.map((node, index) => [node.path, index]));
  const indexedEdges = edges.flatMap(({ source, target }) => {
    const sourceIndex = indexByPath.get(source);
    const targetIndex = indexByPath.get(target);
    return sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex
      ? []
      : [[sourceIndex, targetIndex] as const];
  });
  const cellSize = 64;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forceX = new Float64Array(positioned.length);
    const forceY = new Float64Array(positioned.length);
    const grid = new Map<string, number[]>();

    positioned.forEach((node, index) => {
      forceX[index] = (width / 2 - node.x) * .0015;
      forceY[index] = (height / 2 - node.y) * .0015;
      const key = `${Math.floor(node.x / cellSize)}:${Math.floor(node.y / cellSize)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(index);
      else grid.set(key, [index]);
    });

    for (const [sourceIndex, targetIndex] of indexedEdges) {
      const source = positioned[sourceIndex];
      const target = positioned[targetIndex];
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const preferredDistance = 62 + source.radius + target.radius;
      const pull = (distance - preferredDistance) * .018;
      const unitX = dx / distance;
      const unitY = dy / distance;
      forceX[sourceIndex] += unitX * pull;
      forceY[sourceIndex] += unitY * pull;
      forceX[targetIndex] -= unitX * pull;
      forceY[targetIndex] -= unitY * pull;
    }

    positioned.forEach((node, index) => {
      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (const otherIndex of grid.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? []) {
            if (otherIndex <= index) continue;
            const other = positioned[otherIndex];
            if (!other) continue;
            let dx = other.x - node.x;
            let dy = other.y - node.y;
            let distance = Math.hypot(dx, dy);
            if (distance < .01) {
              dx = index % 2 === 0 ? 1 : -1;
              dy = otherIndex % 2 === 0 ? 1 : -1;
              distance = Math.SQRT2;
            }
            const minimumDistance = node.radius + other.radius + 18;
            if (distance >= minimumDistance) continue;
            const push = (minimumDistance - distance) * .16;
            const unitX = dx / distance;
            const unitY = dy / distance;
            forceX[index] -= unitX * push;
            forceY[index] -= unitY * push;
            forceX[otherIndex] += unitX * push;
            forceY[otherIndex] += unitY * push;
          }
        }
      }
    });

    positioned.forEach((node, index) => {
      const fixed = pinned.get(node.path);
      if (fixed) {
        node.x = clamp(fixed.x, node.radius, width - node.radius);
        node.y = clamp(fixed.y, node.radius, height - node.radius);
        return;
      }
      node.x = clamp(node.x + clamp(forceX[index] ?? 0, -9, 9), node.radius, width - node.radius);
      node.y = clamp(node.y + clamp(forceY[index] ?? 0, -9, 9), node.radius, height - node.radius);
    });
  }

  return positioned;
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
