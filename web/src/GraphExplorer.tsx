import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCachedVaultGraph, getVaultGraph, getVaultGraphPath, type VaultGraph, type VaultGraphNode } from "./api";
import { graphDegree, layoutGraph, settleGraphLayout, type GraphPosition, type PositionedGraphNode } from "./graphLayout";

interface GraphExplorerProps {
  vaultId: string;
  onClose: () => void;
  onOpenNote: (path: string) => void;
  onAskAboutNote: (path: string) => void;
}

interface GraphViewport { x: number; y: number; width: number; height: number }

interface CachedGraphLayout {
  revision: string;
  positions: Map<string, GraphPosition>;
  pinned: Map<string, GraphPosition>;
}

type GraphDrag =
  | { kind: "canvas"; pointerId: number; clientX: number; clientY: number; viewport: GraphViewport }
  | { kind: "node"; pointerId: number; path: string; offsetX: number; offsetY: number };

const graphLayoutCache = new Map<string, CachedGraphLayout>();

export function GraphExplorer({ vaultId, onClose, onOpenNote, onAskAboutNote }: GraphExplorerProps) {
  const [graph, setGraph] = useState<VaultGraph | undefined>(() => getCachedVaultGraph(vaultId));
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [tag, setTag] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [trail, setTrail] = useState<string[]>([]);
  const [finding, setFinding] = useState(false);
  const [viewport, setViewport] = useState<GraphViewport>({ x: 0, y: 0, width: 1_000, height: 700 });
  const [panning, setPanning] = useState(false);
  const [draggingNode, setDraggingNode] = useState("");
  const [positionedNodes, setPositionedNodes] = useState<PositionedGraphNode[]>([]);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<GraphDrag | undefined>(undefined);
  const dragMovedRef = useRef(false);
  const pinnedPositionsRef = useRef(new Map<string, GraphPosition>());

  useEffect(() => {
    const controller = new AbortController();
    const cached = getCachedVaultGraph(vaultId);
    setGraph(cached);
    setError(undefined);
    void getVaultGraph(vaultId, controller.signal)
      .then(setGraph)
      .catch(() => { if (!controller.signal.aborted) setError("The graph could not be loaded. Try again in a moment."); });
    return () => controller.abort();
  }, [vaultId]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); previousFocus?.focus(); };
  }, []);

  const folders = useMemo(() => graph ? [...new Set(graph.nodes.map(({ path }) => path.includes("/") ? path.split("/")[0] : "Root"))].sort() : [], [graph]);
  const tags = useMemo(() => graph ? [...new Set(graph.nodes.flatMap((node) => node.tags))].sort() : [], [graph]);
  const visibleNodes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return graph?.nodes.filter((node) => {
      const nodeFolder = node.path.includes("/") ? node.path.split("/")[0] : "Root";
      return (!folder || nodeFolder === folder)
        && (!tag || node.tags.includes(tag))
        && (!needle || `${node.title} ${node.path} ${node.tags.join(" ")}`.toLocaleLowerCase().includes(needle));
    }) ?? [];
  }, [folder, graph, query, tag]);
  const visiblePaths = useMemo(() => new Set(visibleNodes.map(({ path }) => path)), [visibleNodes]);
  const visibleEdges = useMemo(() => graph?.edges.filter(({ source, target }) => visiblePaths.has(source) && visiblePaths.has(target)) ?? [], [graph, visiblePaths]);
  const baseLayout = useMemo(() => layoutGraph(visibleNodes.map((node) => ({ path: node.path, degree: graphDegree(node), orphan: node.orphan }))), [visibleNodes]);
  const layout = useMemo(() => ({ ...baseLayout, nodes: positionedNodes }), [baseLayout, positionedNodes]);
  const positions = useMemo(() => new Map(positionedNodes.map((node) => [node.path, node])), [positionedNodes]);
  const nodeByPath = useMemo(() => new Map(graph?.nodes.map((node) => [node.path, node]) ?? []), [graph]);
  const selected = nodeByPath.get(selectedPath);
  const trailNodes = useMemo(() => new Set(trail), [trail]);
  const trailEdges = useMemo(() => new Set(trail.slice(1).flatMap((path, index) => {
    const previous = trail[index];
    return previous ? [`${previous}\u0000${path}`, `${path}\u0000${previous}`] : [];
  })), [trail]);
  const viewBox = `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`;
  const zoomPercent = Math.round((layout.width / viewport.width) * 100);

  useEffect(() => {
    const cached = graph && graphLayoutCache.get(vaultId)?.revision === graph.revision ? graphLayoutCache.get(vaultId) : undefined;
    const pinned = new Map(cached?.pinned ?? []);
    pinnedPositionsRef.current = pinned;
    const seeded = baseLayout.nodes.map((node) => {
      const saved = cached?.positions.get(node.path);
      return saved ? { ...node, ...saved } : node;
    });
    const next = cached
      ? seeded
      : settleGraphLayout(seeded, visibleEdges, pinned, 36, baseLayout.width, baseLayout.height);
    setPositionedNodes(next);
    if (graph) rememberLayout(next, pinned, graph.revision);
  }, [baseLayout, graph, vaultId, visibleEdges]);

  useEffect(() => {
    setViewport({ x: 0, y: 0, width: layout.width, height: layout.height });
  }, [folder, layout.height, layout.width, query, tag]);

  async function findTrail() {
    if (!from || !to || from === to) return;
    setFinding(true);
    setError(undefined);
    try {
      const result = await getVaultGraphPath(vaultId, { from, to, direction: "both", maxDepth: 12 });
      setTrail(result.path);
      if (result.found) { setQuery(""); setFolder(""); setTag(""); }
      if (!result.found) setError("No connection was found between those notes.");
    } catch {
      setError("The connection could not be calculated. Check both notes and try again.");
    } finally {
      setFinding(false);
    }
  }

  function selectNode(node: VaultGraphNode) {
    setSelectedPath(node.path);
  }

  async function refreshGraph() {
    setRefreshing(true);
    setError(undefined);
    try {
      setGraph(await getVaultGraph(vaultId, undefined, true));
    } catch {
      setError("The graph could not be refreshed. Try again in a moment.");
    } finally {
      setRefreshing(false);
    }
  }

  function rememberLayout(nodes: PositionedGraphNode[], pinned: ReadonlyMap<string, GraphPosition>, revision: string) {
    const previous = graphLayoutCache.get(vaultId);
    const positions = previous?.revision === revision ? new Map(previous.positions) : new Map<string, GraphPosition>();
    for (const node of nodes) positions.set(node.path, { x: node.x, y: node.y });
    graphLayoutCache.set(vaultId, { revision, positions, pinned: new Map(pinned) });
  }

  function zoomAt(factor: number, clientX?: number, clientY?: number) {
    const rect = canvasRef.current?.getBoundingClientRect();
    setViewport((current) => {
      const nextWidth = clamp(current.width * factor, layout.width / 2.5, layout.width * 1.4);
      const nextHeight = nextWidth * (layout.height / layout.width);
      const ratioX = rect && clientX !== undefined ? clamp((clientX - rect.left) / rect.width, 0, 1) : .5;
      const ratioY = rect && clientY !== undefined ? clamp((clientY - rect.top) / rect.height, 0, 1) : .5;
      const anchorX = current.x + current.width * ratioX;
      const anchorY = current.y + current.height * ratioY;
      return {
        x: anchorX - nextWidth * ratioX,
        y: anchorY - nextHeight * ratioY,
        width: nextWidth,
        height: nextHeight,
      };
    });
  }

  function startPan(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "canvas", pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewport };
    dragMovedRef.current = false;
    setPanning(true);
  }

  function startNodeDrag(event: ReactPointerEvent<SVGGElement>, node: PositionedGraphNode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const point = graphPoint(event.clientX, event.clientY);
    if (!point) return;
    canvasRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "node", pointerId: event.pointerId, path: node.path, offsetX: point.x - node.x, offsetY: point.y - node.y };
    dragMovedRef.current = false;
    setDraggingNode(node.path);
    setSelectedPath(node.path);
  }

  function moveDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!drag || !rect || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "node") {
      const point = graphPoint(event.clientX, event.clientY);
      if (!point) return;
      dragMovedRef.current = true;
      const node = positions.get(drag.path);
      if (!node) return;
      const pinned = new Map(pinnedPositionsRef.current);
      pinned.set(drag.path, {
        x: clamp(point.x - drag.offsetX, node.radius, layout.width - node.radius),
        y: clamp(point.y - drag.offsetY, node.radius, layout.height - node.radius),
      });
      pinnedPositionsRef.current = pinned;
      setPositionedNodes((current) => {
        const next = settleGraphLayout(current, visibleEdges, pinned, 4, layout.width, layout.height);
        if (graph) rememberLayout(next, pinned, graph.revision);
        return next;
      });
      return;
    }
    const clientDx = event.clientX - drag.clientX;
    const clientDy = event.clientY - drag.clientY;
    if (Math.abs(clientDx) + Math.abs(clientDy) > 3) dragMovedRef.current = true;
    setViewport({
      ...drag.viewport,
      x: drag.viewport.x - clientDx * (drag.viewport.width / rect.width),
      y: drag.viewport.y - clientDy * (drag.viewport.height / rect.height),
    });
  }

  function stopDrag(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    const wasNodeDrag = dragRef.current.kind === "node";
    dragRef.current = undefined;
    setPanning(false);
    setDraggingNode("");
    if (wasNodeDrag) {
      const pinned = pinnedPositionsRef.current;
      setPositionedNodes((current) => {
        const next = settleGraphLayout(current, visibleEdges, pinned, 18, layout.width, layout.height);
        if (graph) rememberLayout(next, pinned, graph.revision);
        return next;
      });
    }
    window.setTimeout(() => { dragMovedRef.current = false; }, 220);
  }

  function graphPoint(clientX: number, clientY: number): GraphPosition | undefined {
    const canvas = canvasRef.current;
    const matrix = canvas?.getScreenCTM();
    if (!canvas || !matrix) return undefined;
    const point = canvas.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  function fitGraph() {
    setViewport({ x: 0, y: 0, width: layout.width, height: layout.height });
  }

  function resetLayout() {
    pinnedPositionsRef.current = new Map();
    graphLayoutCache.delete(vaultId);
    const next = settleGraphLayout(baseLayout.nodes, visibleEdges, new Map(), 36, layout.width, layout.height);
    setPositionedNodes(next);
    if (graph) rememberLayout(next, new Map(), graph.revision);
    fitGraph();
  }

  function centerSelected() {
    const position = positions.get(selectedPath);
    if (!position) return;
    const width = layout.width / 1.8;
    const height = width * (layout.height / layout.width);
    setViewport({ x: position.x - width / 2, y: position.y - height / 2, width, height });
  }

  return <div className="graph-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="graph-explorer" role="dialog" aria-modal="true" aria-labelledby="graph-title">
      <header className="graph-header">
        <div><span className="eyebrow">Knowledge map</span><h1 id="graph-title">Graph</h1><p>Explore how your notes connect.</p></div>
        <div className="graph-header-actions"><button className="graph-refresh" onClick={refreshGraph} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</button><button ref={closeRef} className="graph-close" onClick={onClose} aria-label="Close graph">×</button></div>
      </header>

      {error && <div className="graph-feedback" role="alert">{error}<button onClick={() => setError(undefined)} aria-label="Dismiss message">×</button></div>}
      {!graph && !error && <div className="graph-loading" role="status">Building your graph…</div>}
      {graph && <>
        <div className="graph-toolbar">
          <label>Find notes<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, path or tag" /></label>
          <label>Folder<select value={folder} onChange={(event) => setFolder(event.target.value)}><option value="">All folders</option>{folders.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Tag<select value={tag} onChange={(event) => setTag(event.target.value)}><option value="">All tags</option>{tags.map((value) => <option key={value}>{value}</option>)}</select></label>
          <div className="graph-zoom" aria-label="Graph view controls"><button onClick={() => zoomAt(1.25)} aria-label="Zoom out">−</button><span>{zoomPercent}%</span><button onClick={() => zoomAt(.8)} aria-label="Zoom in">+</button><button className="graph-fit" onClick={fitGraph}>Fit</button><button className="graph-fit" onClick={centerSelected} disabled={!selectedPath}>Center</button><button className="graph-fit" onClick={resetLayout}>Reset layout</button></div>
        </div>
        <div className="graph-stats" aria-live="polite"><span>{visibleNodes.length} notes</span><span>{visibleEdges.length} links</span><span>{visibleNodes.filter(({ orphan }) => orphan).length} unconnected</span>{graph.truncated && <strong>Showing the first 10,000 links</strong>}</div>

        <div className="graph-body">
          <div className="graph-canvas-wrap">
            {visibleNodes.length === 0 ? <div className="graph-empty">No notes match these filters.</div> : <svg ref={canvasRef} className={`graph-canvas${panning ? " panning" : ""}${draggingNode ? " moving-node" : ""}`} viewBox={viewBox} aria-hidden="true" onPointerDown={startPan} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onWheel={(event) => { event.preventDefault(); zoomAt(Math.exp(event.deltaY * .0015), event.clientX, event.clientY); }}>
              <g className="graph-edges">{visibleEdges.map((edge, index) => {
                const source = positions.get(edge.source);
                const target = positions.get(edge.target);
                if (!source || !target) return null;
                const highlighted = trailEdges.has(`${edge.source}\u0000${edge.target}`);
                return <line key={`${edge.source}:${edge.target}:${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={highlighted ? "trail" : edge.embedded ? "embed" : ""} />;
              })}</g>
              <g className="graph-nodes">{layout.nodes.map((position) => {
                const node = nodeByPath.get(position.path);
                if (!node) return null;
                const active = selectedPath === node.path;
                const onTrail = trailNodes.has(node.path);
                const showLabel = active || onTrail || graphDegree(node) >= 4 || visibleNodes.length <= 30;
                return <g key={node.path} className={`graph-node${active ? " selected" : ""}${onTrail ? " trail" : ""}${node.orphan ? " orphan" : ""}${draggingNode === node.path ? " dragging" : ""}`} onPointerDown={(event) => startNodeDrag(event, position)} onClick={() => { if (!dragMovedRef.current) selectNode(node); }} onDoubleClick={() => { if (!dragMovedRef.current) onOpenNote(node.path); }}>
                  <circle cx={position.x} cy={position.y} r={position.radius} />
                  {showLabel && <text x={position.x + position.radius + 5} y={position.y + 3}>{node.title.slice(0, 34)}</text>}
                </g>;
              })}</g>
            </svg>}
          </div>

          <aside className="graph-inspector" aria-label="Selected graph note">
            <label className="graph-note-picker">Inspect note<select value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)}><option value="">Choose a visible note</option>{visibleNodes.map((node) => <option key={node.path} value={node.path}>{node.title} — {node.path}</option>)}</select></label>
            {selected ? <>
              <span className="eyebrow">Selected note</span><h2>{selected.title}</h2><p>{selected.path}</p>
              <div className="graph-node-stats"><span>{selected.outgoing_count} outgoing</span><span>{selected.backlink_count} backlinks</span>{selected.orphan && <span>Unconnected</span>}</div>
              {selected.tags.length > 0 && <div className="graph-tags">{selected.tags.map((value) => <button key={value} onClick={() => setTag(value)}>{value}</button>)}</div>}
              <div className="graph-actions"><button onClick={() => onOpenNote(selected.path)}>Open note</button><button onClick={() => onAskAboutNote(selected.path)}>Ask about this note</button></div>
              <div className="graph-trail-picks"><button onClick={() => { setFrom(selected.path); setTrail([]); }}>Set as start</button><button onClick={() => { setTo(selected.path); setTrail([]); }}>Set as destination</button></div>
            </> : <div className="graph-inspector-empty"><span>◇</span><h2>Select a note</h2><p>Inspect its links, open it, or use it as chat context.</p></div>}
            <div className="graph-pathfinder"><span className="eyebrow">Connection trail</span><label>From<select value={from} onChange={(event) => { setFrom(event.target.value); setTrail([]); }}><option value="">Choose a note</option>{graph.nodes.map((node) => <option key={node.path} value={node.path}>{node.title} — {node.path}</option>)}</select></label><label>To<select value={to} onChange={(event) => { setTo(event.target.value); setTrail([]); }}><option value="">Choose a note</option>{graph.nodes.map((node) => <option key={node.path} value={node.path}>{node.title} — {node.path}</option>)}</select></label><button disabled={!from || !to || from === to || finding} onClick={findTrail}>{finding ? "Finding…" : "Show connection"}</button>{trail.length > 0 && <ol>{trail.map((path) => <li key={path}><button onClick={() => setSelectedPath(path)}>{nodeByPath.get(path)?.title ?? path}</button></li>)}</ol>}</div>
          </aside>
        </div>
        <footer className="graph-legend"><span><i className="connected"></i>Connected note</span><span><i className="orphan"></i>Unconnected note</span><span><i className="trail"></i>Selected trail</span><span className="graph-gesture-hint">Drag the background to move · drag a note to rearrange · scroll to zoom</span></footer>
      </>}
    </section>
  </div>;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
