import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  ApiError,
  AgentChatError,
  chat,
  getNote,
  getAllNotes,
  getSession,
  getVaults,
  logout,
  searchNotes,
  type Note,
  type NoteSummary,
  type AgentTraceEvent,
  type AgentUsage,
  type ChatModelId,
  type ChatProgress,
  type ReasoningEffort,
  type SearchMatch,
  type Session,
  type Vault,
} from "./api";
import { buildNoteTree, type NoteTreeNode } from "./noteTree";
import { markdownLinkTarget, prepareObsidianMarkdown, resolveInternalNotePath } from "./obsidianMarkdown";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Array<{ id: string; path: string; sha: string }>;
  noteCount?: number;
  trace?: AgentTraceEvent[];
  usage?: AgentUsage;
  model?: ChatModelId;
  reasoningEffort?: ReasoningEffort;
  failed?: boolean;
};

type PendingActivity = { phase: string; trace: AgentTraceEvent[]; usage: AgentUsage };

export function App() {
  const [session, setSession] = useState<Session>();
  const [authChecked, setAuthChecked] = useState(false);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vaultId, setVaultId] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [noteTotal, setNoteTotal] = useState(0);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedSha, setSelectedSha] = useState<string>();
  const [note, setNote] = useState<Note>();
  const [filter, setFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchMatch[]>();
  const [searching, setSearching] = useState(false);
  const [loadingNote, setLoadingNote] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [chatScope, setChatScope] = useState<"note" | "vault">("vault");
  const [chatModel, setChatModel] = useState<ChatModelId>("gpt-5.6-sol");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [asking, setAsking] = useState(false);
  const [pendingActivity, setPendingActivity] = useState<PendingActivity>();
  const [error, setError] = useState<string>();
  const [mobilePane, setMobilePane] = useState<"files" | "note" | "chat">("files");
  const vaultIdRef = useRef(vaultId);
  const chatAbortRef = useRef<AbortController | undefined>(undefined);
  vaultIdRef.current = vaultId;

  useEffect(() => {
    void getSession()
      .then(async (current) => {
        setSession(current);
        if (!current) return;
        setChatModel(current.chat.default_model);
        setReasoningEffort(current.chat.default_reasoning_effort);
        const available = await getVaults();
        setVaults(available);
        setVaultId(available[0]?.id ?? "");
      })
      .catch((caught) => setError(messageFor(caught)))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    setNotes([]);
    setNoteTotal(0);
    setExpandedFolders(new Set());
    setSelectedPath("");
    setSelectedSha(undefined);
    setNote(undefined);
    setSearchResults(undefined);
    setMessages([]);
    setError(undefined);
    void getAllNotes(vaultId)
      .then((page) => {
        if (cancelled) return;
        setNotes(page.notes);
        setNoteTotal(page.total);
      })
      .catch((caught) => { if (!cancelled) setError(messageFor(caught)); });
    return () => { cancelled = true; };
  }, [vaultId]);

  useEffect(() => {
    if (!vaultId || !selectedPath) return;
    let cancelled = false;
    setLoadingNote(true);
    setNote(undefined);
    setError(undefined);
    void getNote(vaultId, selectedPath, selectedSha)
      .then((loaded) => { if (!cancelled) setNote(loaded); })
      .catch((caught) => { if (!cancelled) setError(messageFor(caught)); })
      .finally(() => { if (!cancelled) setLoadingNote(false); });
    return () => { cancelled = true; };
  }, [vaultId, selectedPath, selectedSha]);

  useEffect(() => {
    if (!selectedPath) return;
    const segments = selectedPath.split("/").slice(0, -1);
    setExpandedFolders((current) => {
      const next = new Set(current);
      for (let index = 1; index <= segments.length; index += 1) next.add(segments.slice(0, index).join("/"));
      return next;
    });
  }, [selectedPath]);

  const chatContextKey = `${vaultId}:${chatScope}:${chatScope === "note" ? selectedPath : ""}`;
  const chatContextRef = useRef(chatContextKey);
  chatContextRef.current = chatContextKey;
  useEffect(() => {
    chatAbortRef.current?.abort();
    chatAbortRef.current = undefined;
    setAsking(false);
    setPendingActivity(undefined);
    setMessages([]);
    setQuestion("");
  }, [chatContextKey]);

  const noteTree = useMemo(() => buildNoteTree(notes, filter), [filter, notes]);
  const preparedNote = useMemo(() => note ? prepareObsidianMarkdown(note.content) : undefined, [note]);
  const currentVault = vaults.find((vault) => vault.id === vaultId);
  const conversationUsage = useMemo(() => sumUsage(messages.flatMap((message) => message.usage ? [message.usage] : [])), [messages]);

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!vaultId || query.length < 2) return;
    const requestedVault = vaultId;
    setSearching(true);
    setError(undefined);
    try {
      const results = await searchNotes(requestedVault, query);
      if (vaultIdRef.current === requestedVault) setSearchResults(results);
    } catch (caught) {
      if (vaultIdRef.current === requestedVault) setError(messageFor(caught));
    } finally {
      if (vaultIdRef.current === requestedVault) setSearching(false);
    }
  }

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    const cleanQuestion = question.trim();
    if (!session || !vaultId || !cleanQuestion || (chatScope === "note" && !selectedPath)) return;
    const nextUser: ChatMessage = { id: messageId(), role: "user", content: cleanQuestion };
    const history = messages.filter((message) => !message.failed).slice(-8).map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, nextUser]);
    setQuestion("");
    setAsking(true);
    setPendingActivity({ phase: "Preparing vault snapshot…", trace: [], usage: emptyUsage() });
    setError(undefined);
    const abortController = new AbortController();
    chatAbortRef.current = abortController;
    const requestedVault = vaultId;
    const requestedScope = chatScope;
    const requestedPath = selectedPath;
    const requestedContext = chatContextKey;
    const requestedModel = chatModel;
    const requestedReasoning = reasoningEffort;
    try {
      const reply = await chat(requestedVault, session.csrf_token, {
        question: cleanQuestion,
        activePath: requestedScope === "note" ? requestedPath || undefined : undefined,
        scope: requestedScope,
        history,
        model: requestedModel,
        reasoning_effort: requestedReasoning,
      }, {
        signal: abortController.signal,
        onProgress: (progress) => {
          if (vaultIdRef.current !== requestedVault || chatContextRef.current !== requestedContext) return;
          setPendingActivity((current) => updatePendingActivity(current, progress));
        },
      });
      if (vaultIdRef.current !== requestedVault || chatContextRef.current !== requestedContext) return;
      setMessages((current) => [...current, {
        id: messageId(),
        role: "assistant",
        content: reply.answer,
        citations: reply.citations,
        noteCount: reply.context.note_count,
        trace: reply.trace,
        usage: reply.usage,
        model: reply.agent.model,
        reasoningEffort: reply.agent.reasoning_effort,
      }]);
    } catch (caught) {
      if (abortController.signal.aborted) return;
      setError(messageFor(caught));
      const hasPartialRun = caught instanceof AgentChatError && (caught.usage.totalTokens > 0 || caught.trace.length > 0);
      if (hasPartialRun) {
        setMessages((current) => [...current.map((message) => message.id === nextUser.id ? { ...message, failed: true } : message), {
          id: messageId(),
          role: "assistant",
          content: `This turn stopped before an answer: ${messageFor(caught)}`,
          trace: caught.trace,
          usage: caught.usage,
          model: requestedModel,
          reasoningEffort: requestedReasoning,
          noteCount: uniqueTraceNotes(caught.trace).length,
          failed: true,
        }]);
      } else {
        setMessages((current) => current.filter((message) => message.id !== nextUser.id));
        setQuestion(cleanQuestion);
      }
    } finally {
      if (chatAbortRef.current === abortController) {
        chatAbortRef.current = undefined;
        setAsking(false);
        setPendingActivity(undefined);
      }
    }
  }

  async function signOut() {
    if (!session) return;
    await logout(session.csrf_token).catch(() => undefined);
    location.assign("/");
  }

  function openInternalLink(href: string, currentPath: string) {
    const path = resolveInternalNotePath(href, currentPath, notes);
    if (!path) {
      setError("That linked note was not found in this vault.");
      return;
    }
    setSelectedSha(undefined);
    setSelectedPath(path);
    setMobilePane("note");
  }

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  if (!authChecked) return <LoadingScreen />;
  if (!session) return <SignIn error={error} />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#document">Skip to document</a>
      <header className="topbar">
        <div className="brand"><Logo /><span>Obsidian Vault</span><span className="preview-pill">private preview</span></div>
        <div className="vault-control">
          <label htmlFor="vault-select">Vault</label>
          <select id="vault-select" value={vaultId} onChange={(event) => setVaultId(event.target.value)}>
            {vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.repository}</option>)}
          </select>
        </div>
        <div className="account"><span>@{session.user.login}</span><button className="text-button" onClick={signOut}>Sign out</button></div>
      </header>

      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError(undefined)} aria-label="Dismiss">×</button></div>}

      <div className={`workspace mobile-${mobilePane}`}>
        <nav className="mobile-nav" aria-label="Workspace views">
          <button aria-pressed={mobilePane === "files"} onClick={() => setMobilePane("files")}>Files</button>
          <button aria-pressed={mobilePane === "note"} onClick={() => setMobilePane("note")}>Note</button>
          <button aria-pressed={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>Chat</button>
        </nav>
        <nav className="files-panel" aria-label="Vault files">
          <div className="panel-heading">
            <div><span className="eyebrow">{currentVault?.repository}</span><h2>Files</h2></div>
            <span className="count">{noteTotal || notes.length}</span>
          </div>
          <form className="search-box" onSubmit={submitSearch} role="search">
            <SearchIcon />
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search contents" aria-label="Search note contents" />
            <button aria-label="Search vault" disabled={searching || searchQuery.trim().length < 2}>{searching ? "…" : "↵"}</button>
          </form>
          {searchResults !== undefined && (
            <section className="search-results" aria-label="Search results">
              <div className="section-label" aria-live="polite"><span>{searchResults.length} matches</span><button onClick={() => { setSearchResults(undefined); setSearchQuery(""); }}>Clear</button></div>
              {searchResults.map((result) => (
                <button className="result-card" key={result.path} onClick={() => { setSelectedSha(result.sha); setSelectedPath(result.path); setMobilePane("note"); }}>
                  <strong>{basename(result.path)}</strong><small>{dirname(result.path)}</small><span>{result.excerpt}</span>
                </button>
              ))}
              {searchResults.length === 0 && <Empty text="No matching notes" />}
            </section>
          )}
          {searchResults === undefined && <>
            <div className="path-filter"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter paths" aria-label="Filter note paths" /></div>
            <div className="file-list note-tree" role="tree" aria-label="Markdown notes">
              {noteTree.map((node) => <TreeNode
                key={node.type === "folder" ? node.path : node.note.path}
                node={node}
                depth={0}
                expandedFolders={expandedFolders}
                forceExpanded={Boolean(filter.trim())}
                selectedPath={selectedPath}
                onToggle={toggleFolder}
                onOpen={(path) => { setSelectedSha(undefined); setSelectedPath(path); setMobilePane("note"); }}
              />)}
              {noteTree.length === 0 && <Empty text="No notes here yet" />}
            </div>
          </>}
        </nav>

        <main className="reader" id="document">
          {loadingNote && <DocumentSkeleton />}
          {!loadingNote && note && preparedNote && <article>
            <div className="document-meta">
              <span>{note.path}{note.cited_revision ? " · cited revision" : ""}</span>{note.html_url && <a href={note.html_url} target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>}
            </div>
            {preparedNote.properties.length > 0 && <dl className="document-properties">
              {preparedNote.properties.map((property) => <div key={property.name}><dt>{property.name}</dt><dd>{property.value}</dd></div>)}
            </dl>}
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} urlTransform={(url) => url.startsWith("vault-note:") ? url : defaultUrlTransform(url)} components={{
              a: ({ href, children }) => {
                const internal = href ? markdownLinkTarget(href, note.path) ?? (href.startsWith("vault-note:") ? href : undefined) : undefined;
                if (internal) return <a href="#" onClick={(event) => { event.preventDefault(); openInternalLink(internal, note.path); }}>{children}</a>;
                if (href?.startsWith("#")) return <a href={href}>{children}</a>;
                return <a href={safeExternalHref(href)} target="_blank" rel="noopener noreferrer">{children}</a>;
              },
              img: () => <span className="blocked-media">Image omitted</span>,
            }}>{preparedNote.body}</ReactMarkdown>
          </article>}
          {!loadingNote && !note && <div className="reader-empty"><div className="empty-mark">◇</div><h1>Open a note</h1><p>Select a document or search across <strong>{currentVault?.name}</strong>.</p></div>}
        </main>

        <aside className="chat-panel" aria-label="Ask your vault">
          <div className="chat-header"><div><span className="eyebrow">Agentic · read only</span><h2>Ask your vault</h2></div><SparkIcon /></div>
          <div className="agent-controls">
            <label>Model<select value={chatModel} onChange={(event) => setChatModel(event.target.value as ChatModelId)} disabled={asking}>
              {session.chat.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select></label>
            <label>Reasoning<select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)} disabled={asking}>
              {session.chat.reasoning_efforts.map((effort) => <option key={effort} value={effort}>{reasoningLabel(effort)}</option>)}
            </select></label>
            <button className="new-chat" onClick={() => { chatAbortRef.current?.abort(); setMessages([]); setQuestion(""); setPendingActivity(undefined); setAsking(false); }} disabled={!asking && messages.length === 0}>New chat</button>
          </div>
          <div className="conversation-meter" aria-label={`${formatTokens(conversationUsage.totalTokens)} tokens used in this conversation`}>
            <span>{formatTokens(conversationUsage.totalTokens)} tokens</span><span>{conversationUsage.requests} model call{conversationUsage.requests === 1 ? "" : "s"}</span>
          </div>
          <div className="scope-control">
            <span>Context</span>
            <div className="segmented">
              <button aria-pressed={chatScope === "vault"} className={chatScope === "vault" ? "active" : ""} onClick={() => setChatScope("vault")}>Entire vault</button>
              <button aria-pressed={chatScope === "note"} className={chatScope === "note" ? "active" : ""} onClick={() => setChatScope("note")} disabled={!selectedPath}>This note</button>
            </div>
            {selectedPath && <span className="context-chip"><DocumentIcon />{basename(selectedPath)}</span>}
          </div>
          <div className="messages">
            {messages.length === 0 && <div className="chat-empty"><SparkIcon /><h3>{session.chat_enabled ? "Ask with evidence" : "Chat is not enabled"}</h3><p>{session.chat_enabled ? "I’ll search only this vault and show which notes supported the answer." : "Add the OpenAI secret and enable vault chat in this deployment."}</p><div className="suggestions">
              <button disabled={!session.chat_enabled} onClick={() => setQuestion("Summarize the main themes in this vault")}>Summarize the main themes</button>
              <button disabled={!session.chat_enabled || !selectedPath} onClick={() => setQuestion("What are the key facts in this note?")}>Explain this note</button>
            </div></div>}
            {messages.map((message) => <div className={`message ${message.role}`} key={message.id}>
              <span className="message-role">{message.role === "assistant" ? "Vault agent" : "You"}</span>
              {message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{message.content}</ReactMarkdown> : <p>{message.content}</p>}
              {message.citations && message.citations.length > 0 && <div className="citations">
                {message.citations.map((citation) => <button key={citation.id} onClick={() => { setSelectedSha(citation.sha); setSelectedPath(citation.path); setMobilePane("note"); }}><span>{citation.id}</span>{basename(citation.path)}</button>)}
              </div>}
              {message.noteCount !== undefined && <small className="context-count">Agent inspected {message.noteCount} note revision{message.noteCount === 1 ? "" : "s"}</small>}
              {message.role === "assistant" && message.usage && <AgentActivity
                trace={message.trace ?? []}
                usage={message.usage}
                model={message.model}
                reasoningEffort={message.reasoningEffort}
                onOpenNote={(path, sha) => { setSelectedSha(sha); setSelectedPath(path); setMobilePane("note"); }}
              />}
            </div>)}
            {asking && pendingActivity && <div className="message assistant pending-agent" role="status" aria-live="polite" aria-label="The vault agent is working">
              <div className="thinking"><span></span><span></span><span></span><small>{pendingActivity.phase}</small></div>
              <AgentActivity trace={pendingActivity.trace} usage={pendingActivity.usage} model={chatModel} reasoningEffort={reasoningEffort} live onOpenNote={(path, sha) => { setSelectedSha(sha); setSelectedPath(path); setMobilePane("note"); }} />
            </div>}
          </div>
          <form className="composer" onSubmit={submitQuestion}>
            <label className="sr-only" htmlFor="vault-question">Question for your vault</label>
            <textarea id="vault-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={session.chat_enabled ? "Ask a question about your notes…" : "Chat is disabled"} disabled={!session.chat_enabled} maxLength={4000} rows={3} />
            <div><span>{chatScope === "note" ? "This note only" : "Searches this vault"}</span><button aria-label="Send question" disabled={!session.chat_enabled || asking || !question.trim() || (chatScope === "note" && !selectedPath)}>↑</button></div>
          </form>
          <p className="privacy-note">Chat is ephemeral. Answers may be wrong; verify citations.</p>
        </aside>
      </div>
    </div>
  );
}

function AgentActivity({ trace, usage, model, reasoningEffort, live, onOpenNote }: {
  trace: AgentTraceEvent[];
  usage: AgentUsage;
  model?: ChatModelId;
  reasoningEffort?: ReasoningEffort;
  live?: boolean;
  onOpenNote: (path: string, sha: string) => void;
}) {
  return <details className="agent-activity" open={live || undefined}>
    <summary><span>Activity</span><span>{trace.length} tool{trace.length === 1 ? "" : "s"} · {formatTokens(usage.totalTokens)} tokens</span></summary>
    <div className="agent-run-meta">
      <span>{modelLabel(model)}</span><span>{reasoningLabel(reasoningEffort)} reasoning</span><span>{usage.requests} model call{usage.requests === 1 ? "" : "s"}</span>
    </div>
    {trace.length === 0 ? <p className="no-tools">{live ? "No vault actions yet." : "Answered without opening vault notes."}</p> : <ol className="agent-steps">
      {trace.map((event) => <li key={event.id} className={event.status === "failed" ? "failed" : undefined}>
        <div><span className="tool-name">{toolLabel(event.tool)}</span><span>{event.summary}</span></div>
        {event.notes.length > 0 && <div className="trace-notes">{event.notes.map((traceNote) => <button key={`${traceNote.path}:${traceNote.sha}`} onClick={() => onOpenNote(traceNote.path, traceNote.sha)} aria-label={`Open note ${traceNote.path}`} title={traceNote.path}>{traceNote.path}</button>)}</div>}
      </li>)}
    </ol>}
    <dl className="token-breakdown"><div><dt>Input</dt><dd>{formatTokens(usage.inputTokens)}</dd></div><div><dt>Output</dt><dd>{formatTokens(usage.outputTokens)}</dd></div><div><dt>Reasoning</dt><dd>{formatTokens(usage.reasoningTokens)}</dd></div><div><dt>Cached</dt><dd>{formatTokens(usage.cachedInputTokens)}</dd></div></dl>
    <p className="trace-privacy">Shows actions and note paths, never private reasoning.</p>
  </details>;
}

function SignIn({ error }: { error?: string }) {
  return <main className="signin"><div className="signin-card"><Logo /><span className="eyebrow">Private owner-only deployment</span><h1>Read deeply.<br />Ask precisely.</h1><p>Browse, search, and discuss the Markdown notes in the repositories explicitly authorized for this owner.</p>{error && <div className="signin-error">{error}</div>}<a className="signin-button" href="/web/login"><GitHubIcon />Continue with GitHub</a><small>This preview supports multiple vaults for one configured GitHub owner. Other users cannot onboard.</small></div><div className="signin-art" aria-hidden="true"><div className="orb one"></div><div className="orb two"></div><div className="grid-lines"></div><blockquote>“The map is not the territory,<br />but good notes get us closer.”</blockquote></div></main>;
}

function LoadingScreen() { return <main className="loading-screen"><Logo /><span>Opening your vault…</span></main>; }
function Empty({ text }: { text: string }) { return <div className="empty-list">{text}</div>; }
function DocumentSkeleton() { return <div className="document-skeleton"><i></i><i></i><i></i><i></i><i></i></div>; }
function TreeNode({ node, depth, expandedFolders, forceExpanded, selectedPath, onToggle, onOpen }: {
  node: NoteTreeNode;
  depth: number;
  expandedFolders: Set<string>;
  forceExpanded: boolean;
  selectedPath: string;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  if (node.type === "note") return <button
    role="treeitem"
    aria-current={selectedPath === node.note.path ? "true" : undefined}
    className={selectedPath === node.note.path ? "file-item selected" : "file-item"}
    style={{ paddingLeft: 9 + depth * 14 }}
    onClick={() => onOpen(node.note.path)}
  ><DocumentIcon /><span><strong>{node.name}</strong></span></button>;
  const expanded = forceExpanded || expandedFolders.has(node.path);
  return <div role="treeitem" aria-expanded={expanded}>
    <button className="folder-item" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onToggle(node.path)}>
      <ChevronIcon expanded={expanded} /><FolderIcon /><strong>{node.name}</strong><small>{countNotes(node)}</small>
    </button>
    {expanded && <div role="group">{node.children.map((child) => <TreeNode
      key={child.type === "folder" ? child.path : child.note.path}
      node={child}
      depth={depth + 1}
      expandedFolders={expandedFolders}
      forceExpanded={forceExpanded}
      selectedPath={selectedPath}
      onToggle={onToggle}
      onOpen={onOpen}
    />)}</div>}
  </div>;
}
function countNotes(folder: Extract<NoteTreeNode, { type: "folder" }>): number {
  return folder.children.reduce((total, child) => total + (child.type === "note" ? 1 : countNotes(child)), 0);
}
function basename(path: string) { return path.split("/").pop()?.replace(/\.md$/i, "") ?? path; }
function dirname(path: string) { const parts = path.split("/"); parts.pop(); return parts.join(" / ") || "Vault root"; }
function safeExternalHref(href: string | undefined) { if (!href) return undefined; return /^(https?:|mailto:)/i.test(href) ? href : undefined; }
let messageSequence = 0;
function messageId() { messageSequence += 1; return `message-${Date.now()}-${messageSequence}`; }
function formatTokens(value: number) { return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function sumUsage(values: AgentUsage[]): AgentUsage {
  return values.reduce<AgentUsage>((total, usage) => ({
    requests: total.requests + usage.requests,
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
    cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
  }), emptyUsage());
}
function emptyUsage(): AgentUsage { return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }; }
function updatePendingActivity(current: PendingActivity | undefined, progress: ChatProgress): PendingActivity {
  const pending = current ?? { phase: "Preparing vault snapshot…", trace: [], usage: emptyUsage() };
  if (progress.type === "status") return { ...pending, phase: "Preparing vault snapshot…" };
  if (progress.type === "model_request") return { ...pending, phase: `Reasoning · model pass ${progress.round}` };
  if (progress.type === "usage") return { ...pending, usage: progress.usage };
  return { ...pending, phase: progress.trace.summary, trace: [...pending.trace, progress.trace] };
}
function uniqueTraceNotes(trace: AgentTraceEvent[]) {
  return [...new Map(trace.flatMap((event) => event.notes).map((note) => [`${note.path}\0${note.sha}`, note])).values()];
}
function modelLabel(model: ChatModelId | undefined) {
  if (model === "gpt-5.6-terra") return "Terra";
  if (model === "gpt-5.6-luna") return "Luna";
  return "Sol";
}
function reasoningLabel(effort: ReasoningEffort | undefined) {
  if (effort === "none") return "None";
  if (effort === "xhigh") return "Extra high";
  if (effort === "max") return "Maximum";
  return effort ? effort[0].toUpperCase() + effort.slice(1) : "Medium";
}
function toolLabel(tool: AgentTraceEvent["tool"]) {
  const labels: Record<AgentTraceEvent["tool"], string> = {
    list_notes: "Listed notes",
    search_notes: "Searched notes",
    read_notes: "Read notes",
    get_note_links: "Checked links",
    get_graph_overview: "Inspected graph",
  };
  return labels[tool];
}
function messageFor(error: unknown) {
  if (!(error instanceof ApiError)) return "Something went wrong. Please try again.";
  const messages: Record<string, string> = {
    chat_not_configured: "Chat is not configured on this deployment yet.",
    chat_daily_limit_reached: "The daily chat limit has been reached.",
    model_rate_limited: "The model is busy. Try again in a moment.",
    model_unavailable: "The model is temporarily unavailable.",
    model_output_limit: "The answer exceeded the model limit. Try a narrower question.",
    agent_timeout: "The agent took too long. Try again with a narrower scope.",
    agent_tool_limit: "The agent needed too many vault actions. Try a narrower question.",
    agent_round_limit: "The agent could not finish within this turn. Try a narrower question.",
    agent_context_limit: "Too much note content was needed. Try this-note scope or a narrower question.",
    model_refused: "The model could not answer that request.",
    authentication_required: "Your session expired. Sign in again.",
    vault_not_found: "This vault is no longer available.",
  };
  return messages[error.code] ?? "The request could not be completed.";
}

function Logo() { return <svg className="logo" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 27 9l-3 17-8 4-8-4L5 9 16 2Z"/><path d="m5 9 11 8 11-8M16 17v13M8 26l8-9 8 9"/></svg>; }
function SearchIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>; }
function DocumentIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5z"/><path d="M12 2.5v3h3M7.5 9h5M7.5 12h5"/></svg>; }
function FolderIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5h5l1.5 2h8.5v8.5h-15z"/></svg>; }
function ChevronIcon({ expanded }: { expanded: boolean }) { return <svg className={expanded ? "chevron expanded" : "chevron"} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>; }
function SparkIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.5 5.3 2.7 7.5 8 8-5.3.5-7.5 2.7-8 8-.5-5.3-2.7-7.5-8-8 5.3-.5 7.5-2.7 8-8Z"/><path d="M19 16c.2 2 1 2.8 3 3-2 .2-2.8 1-3 3-.2-2-1-2.8-3-3 2-.2 2.8-1 3-3Z"/></svg>; }
function GitHubIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1 1.6 1 .9 1.6 2.4 1.1 2.9.9.1-.7.4-1.1.6-1.3-2.3-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .9-.3 2.8 1a9.7 9.7 0 0 1 5.1 0c2-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1.1 2.7c0 3.9-2.4 4.7-4.7 5 .4.3.7 1 .7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/></svg>; }
