import { useEffect, useMemo, useRef, useState } from "react";
import { getVaultGraph, getVaultGraphPath, type VaultGraph, type VaultGraphNode } from "./api";
import { graphDegree, layoutGraph } from "./graphLayout";

interface GraphExplorerProps {
  vaultId: string;
  onClose: () => void;
  onOpenNote: (path: string) => void;
  onAskAboutNote: (path: string) => void;
}

export function GraphExplorer({ vaultId, onClose, onOpenNote, onAskAboutNote }: GraphExplorerProps) {
  const [graph, setGraph] = useState<VaultGraph>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [tag, setTag] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [trail, setTrail] = useState<string[]>([]);
  const [finding, setFinding] = useState(false);
  const [zoom, setZoom] = useState(1);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setGraph(undefined);
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
  const layout = useMemo(() => layoutGraph(visibleNodes.map((node) => ({ path: node.path, degree: graphDegree(node), orphan: node.orphan }))), [visibleNodes]);
  const positions = useMemo(() => new Map(layout.nodes.map((node) => [node.path, node])), [layout.nodes]);
  const nodeByPath = useMemo(() => new Map(graph?.nodes.map((node) => [node.path, node]) ?? []), [graph]);
  const selected = nodeByPath.get(selectedPath);
  const trailNodes = useMemo(() => new Set(trail), [trail]);
  const trailEdges = useMemo(() => new Set(trail.slice(1).flatMap((path, index) => {
    const previous = trail[index];
    return previous ? [`${previous}\u0000${path}`, `${path}\u0000${previous}`] : [];
  })), [trail]);
  const viewWidth = layout.width / zoom;
  const viewHeight = layout.height / zoom;
  const viewBox = `${(layout.width - viewWidth) / 2} ${(layout.height - viewHeight) / 2} ${viewWidth} ${viewHeight}`;

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

  return <div className="graph-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="graph-explorer" role="dialog" aria-modal="true" aria-labelledby="graph-title">
      <header className="graph-header">
        <div><span className="eyebrow">Knowledge map</span><h1 id="graph-title">Graph</h1><p>Explore how your notes connect.</p></div>
        <button ref={closeRef} className="graph-close" onClick={onClose} aria-label="Close graph">×</button>
      </header>

      {error && <div className="graph-feedback" role="alert">{error}<button onClick={() => setError(undefined)} aria-label="Dismiss message">×</button></div>}
      {!graph && !error && <div className="graph-loading" role="status">Building your graph…</div>}
      {graph && <>
        <div className="graph-toolbar">
          <label>Find notes<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, path or tag" /></label>
          <label>Folder<select value={folder} onChange={(event) => setFolder(event.target.value)}><option value="">All folders</option>{folders.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Tag<select value={tag} onChange={(event) => setTag(event.target.value)}><option value="">All tags</option>{tags.map((value) => <option key={value}>{value}</option>)}</select></label>
          <div className="graph-zoom" aria-label="Graph zoom"><button onClick={() => setZoom((value) => Math.max(.7, value - .2))} aria-label="Zoom out">−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(2.2, value + .2))} aria-label="Zoom in">+</button></div>
        </div>
        <div className="graph-stats" aria-live="polite"><span>{visibleNodes.length} notes</span><span>{visibleEdges.length} links</span><span>{visibleNodes.filter(({ orphan }) => orphan).length} unconnected</span>{graph.truncated && <strong>Showing the first 10,000 links</strong>}</div>

        <div className="graph-body">
          <div className="graph-canvas-wrap">
            {visibleNodes.length === 0 ? <div className="graph-empty">No notes match these filters.</div> : <svg className="graph-canvas" viewBox={viewBox} aria-hidden="true">
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
                return <g key={node.path} className={`graph-node${active ? " selected" : ""}${onTrail ? " trail" : ""}${node.orphan ? " orphan" : ""}`} onClick={() => selectNode(node)}>
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
        <footer className="graph-legend"><span><i className="connected"></i>Connected note</span><span><i className="orphan"></i>Unconnected note</span><span><i className="trail"></i>Selected trail</span></footer>
      </>}
    </section>
  </div>;
}
