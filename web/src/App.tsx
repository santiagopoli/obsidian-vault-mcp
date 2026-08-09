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
  getVaultSync,
  connectGoogleDrive,
  runVaultSync,
  disconnectVaultSync,
  type Note,
  type NoteSummary,
  type AgentTraceEvent,
  type AgentUsage,
  type ChatModelId,
  type ChatProgress,
  type ReasoningEffort,
  type SearchMatch,
  type Session,
  type SyncDestination,
  type Vault,
  type VaultSyncSettings,
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
type SyncFeedback = { tone: "success" | "error" | "info"; message: string };
type SyncWatch = {
  vaultId: string;
  kind: "initial" | "manual";
  startedAt: number;
  destinationId?: string;
  revision?: string;
  baselineUpdatedAt?: number;
};

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
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncSettings, setSyncSettings] = useState<VaultSyncSettings>();
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<SyncFeedback>();
  const [syncWatch, setSyncWatch] = useState<SyncWatch>();
  const vaultIdRef = useRef(vaultId);
  const chatAbortRef = useRef<AbortController | undefined>(undefined);
  const syncTriggerRef = useRef<HTMLButtonElement>(null);
  const syncDialogRef = useRef<HTMLElement>(null);
  const syncCloseRef = useRef<HTMLButtonElement>(null);
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
        const callbackVault = new URL(window.location.href).searchParams.get("sync_vault") ?? readPendingSyncVault();
        setVaultId(available.some(({ id }) => id === callbackVault) ? callbackVault ?? "" : available[0]?.id ?? "");
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
    if (!vaultId) return;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("sync");
    if (!result) return;
    const callbackVault = url.searchParams.get("sync_vault") ?? readPendingSyncVault();
    if (callbackVault && callbackVault !== vaultId && vaults.some(({ id }) => id === callbackVault)) {
      setVaultId(callbackVault);
      return;
    }
    url.searchParams.delete("sync");
    url.searchParams.delete("sync_vault");
    window.history.replaceState({}, "", url);
    clearPendingSyncVault();
    setSyncFeedback(result === "connected"
      ? { tone: "success", message: "Google Drive connected. The initial vault snapshot is syncing now." }
      : { tone: "error", message: syncCallbackMessage(result) });
    setSyncOpen(true);
    setSyncSettings(undefined);
    if (result === "connected") setSyncWatch({ vaultId, kind: "initial", startedAt: Date.now() });
    void getVaultSync(vaultId).then(setSyncSettings).catch((caught) => setSyncFeedback({ tone: "error", message: messageFor(caught) }));
  }, [vaultId, vaults]);

  useEffect(() => {
    if (!syncOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = syncDialogRef.current;
    syncCloseRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSyncOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const restoreTarget = previousFocus && document.contains(previousFocus) ? previousFocus : syncTriggerRef.current;
      restoreTarget?.focus();
    };
  }, [syncOpen]);

  useEffect(() => {
    if (!syncOpen || !syncWatch || syncWatch.vaultId !== vaultId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const settings = await getVaultSync(syncWatch.vaultId);
        if (cancelled) return;
        setSyncSettings(settings);
        const destination = syncWatch.destinationId
          ? settings.destinations.find(({ id }) => id === syncWatch.destinationId)
          : settings.destinations.find(({ provider }) => provider === "google_drive");
        if (!destination) return;
        if (destination.status === "reauthorization_required") {
          setSyncFeedback({ tone: "error", message: "Google authorization expired. Reconnect this destination." });
          setSyncWatch(undefined);
          return;
        }
        if (destination.last_error && (syncWatch.baselineUpdatedAt === undefined || destination.updated_at > syncWatch.baselineUpdatedAt)) {
          setSyncFeedback({ tone: "error", message: syncFailureMessage(destination.last_error) });
          setSyncWatch(undefined);
          return;
        }
        const complete = syncWatch.revision
          ? destination.last_synced_revision === syncWatch.revision
          : Boolean(destination.last_synced_at);
        if (complete) {
          setSyncFeedback({ tone: "success", message: syncWatch.kind === "initial" ? "Initial snapshot synced to Google Drive." : "Vault snapshot is up to date in Google Drive." });
          setSyncWatch(undefined);
          return;
        }
        if (Date.now() - syncWatch.startedAt > 5 * 60_000) {
          setSyncFeedback({ tone: "info", message: "The snapshot is still processing in the background. Reopen Sync to check its latest status." });
          setSyncWatch(undefined);
        }
      } catch (caught) {
        if (!cancelled) {
          setSyncFeedback({ tone: "error", message: messageFor(caught) });
          setSyncWatch(undefined);
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [syncOpen, syncWatch, vaultId]);

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

  async function openSyncSettings() {
    if (!vaultId) return;
    setSyncOpen(true);
    setSyncSettings(undefined);
    setSyncFeedback(syncWatch?.vaultId === vaultId ? { tone: "info", message: "Vault snapshot is syncing in the background." } : undefined);
    try { setSyncSettings(await getVaultSync(vaultId)); } catch (caught) { setSyncFeedback({ tone: "error", message: messageFor(caught) }); }
  }

  async function connectSync() {
    if (!session || !vaultId) return;
    setSyncBusy(true);
    setSyncFeedback({ tone: "info", message: "Opening Google authorization…" });
    writePendingSyncVault(vaultId);
    try { window.location.assign(await connectGoogleDrive(vaultId, session.csrf_token)); } catch (caught) {
      clearPendingSyncVault();
      setSyncFeedback({ tone: "error", message: messageFor(caught) });
      setSyncBusy(false);
    }
  }

  async function runSync(destinationId: string) {
    if (!session || !vaultId) return;
    setSyncBusy(true);
    setSyncFeedback({ tone: "info", message: "Queueing the latest vault snapshot…" });
    try {
      const { revision } = await runVaultSync(vaultId, destinationId, session.csrf_token);
      setSyncWatch({
        vaultId,
        destinationId,
        revision,
        kind: "manual",
        startedAt: Date.now(),
        baselineUpdatedAt: syncSettings?.destinations.find(({ id }) => id === destinationId)?.updated_at,
      });
      setSyncFeedback({ tone: "info", message: "Snapshot queued. Waiting for Google Drive…" });
      setSyncSettings(await getVaultSync(vaultId));
    } catch (caught) { setSyncFeedback({ tone: "error", message: messageFor(caught) }); } finally { setSyncBusy(false); }
  }

  async function disconnectSync(destinationId: string) {
    if (!session || !vaultId || !confirm("Disconnect this destination? The existing copy in Google Drive will be preserved.")) return;
    setSyncBusy(true);
    setSyncFeedback(undefined);
    try {
      await disconnectVaultSync(vaultId, destinationId, session.csrf_token);
      if (syncWatch?.destinationId === destinationId || syncWatch?.vaultId === vaultId) setSyncWatch(undefined);
      setSyncSettings(await getVaultSync(vaultId));
      setSyncFeedback({ tone: "success", message: "Google Drive disconnected. The existing remote copy was preserved." });
    } catch (caught) { setSyncFeedback({ tone: "error", message: messageFor(caught) }); } finally { setSyncBusy(false); }
  }

  function closeSyncSettings() { setSyncOpen(false); }

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
        <div className="account"><span>@{session.user.login}</span><button ref={syncTriggerRef} className="text-button" onClick={openSyncSettings}>Sync</button><button className="text-button" onClick={signOut}>Sign out</button></div>
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
      {syncOpen && <div className="sync-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSyncSettings(); }}>
        <section ref={syncDialogRef} className="sync-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-title" aria-describedby="sync-description">
          <div className="sync-heading"><div><span className="eyebrow">Callback destinations</span><h2 id="sync-title">Vault sync</h2></div><button ref={syncCloseRef} onClick={closeSyncSettings} aria-label="Close sync settings">×</button></div>
          <p className="sync-intro" id="sync-description">Every canonical GitHub change queues a coalesced snapshot. Each successful run replaces the previous ZIP, including notes, attachments, and vault settings.</p>
          {syncFeedback && <div className={`sync-feedback ${syncFeedback.tone}`} role={syncFeedback.tone === "error" ? "alert" : "status"}>{syncFeedback.message}</div>}
          {!syncSettings && <div className="sync-loading">Loading destinations…</div>}
          {syncSettings?.destinations.map((destination) => {
            const watched = syncWatch?.vaultId === vaultId && (!syncWatch.destinationId || syncWatch.destinationId === destination.id);
            const health = syncHealth(destination, watched);
            return <article className="sync-destination" key={destination.id}>
              <div className="sync-destination-heading"><div><strong>Google Drive</strong><span className={`sync-connection ${destination.status}`}>{syncConnection(destination.status)}</span></div><span className={`sync-status ${health.tone}`}>{health.label}</span></div>
              <p>{watched ? "Publishing the latest snapshot…" : destination.last_synced_at ? `Last synced ${new Date(destination.last_synced_at * 1000).toLocaleString()}` : "Waiting for the initial snapshot"}</p>
              {destination.last_error && !watched && <small>{syncFailureMessage(destination.last_error)}</small>}
              <div className="sync-actions">{destination.folder_url && <a href={destination.folder_url} target="_blank" rel="noopener noreferrer">Open folder ↗</a>}{destination.status === "reauthorization_required" ? <button disabled={syncBusy} onClick={connectSync}>Reconnect</button> : <button disabled={syncBusy || watched} onClick={() => runSync(destination.id)}>{watched ? "Syncing…" : "Sync now"}</button>}<button className="danger" disabled={syncBusy} onClick={() => disconnectSync(destination.id)}>Disconnect</button></div>
            </article>})}
          {syncSettings && syncSettings.destinations.length === 0 && <article className="sync-provider"><div className="provider-mark google">G</div><div><strong>Google Drive</strong><p>A private, visible folder containing one current vault snapshot.</p></div><button disabled={syncBusy || !syncSettings.google_drive_configured} onClick={connectSync}>{syncBusy ? "Connecting…" : "Connect"}</button>{!syncSettings.google_drive_configured && <small>The deployment owner must configure Google OAuth first.</small>}</article>}
          <article className="sync-provider unavailable"><div className="provider-mark apple">●</div><div><strong>iCloud Drive</strong><p>Requires a local Obsidian companion because Apple does not provide server-side access to arbitrary iCloud Drive folders.</p></div><span>Not available yet</span></article>
          <p className="sync-security">Google access is limited to files created by this app. Tokens are encrypted per owner and vault; disconnecting deletes the server credential but preserves your remote copy.</p>
        </section>
      </div>}
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
    google_drive_sync_not_configured: "Google Drive sync is not configured on this deployment.",
    sync_destination_not_found: "That sync destination is no longer connected.",
  };
  return messages[error.code] ?? "The request could not be completed.";
}

function syncConnection(status: SyncDestination["status"]) {
  if (status === "reauthorization_required") return "Reconnect required";
  if (status === "disabled") return "Disconnected";
  return "Connected";
}

function syncHealth(destination: SyncDestination, watched: boolean): { label: string; tone: "success" | "error" | "warning" | "pending" } {
  if (destination.status === "reauthorization_required") return { label: "Needs attention", tone: "warning" };
  if (watched) return { label: "Syncing", tone: "pending" };
  if (destination.last_error) return { label: "Last run failed", tone: "error" };
  if (destination.last_synced_at) return { label: "Last run succeeded", tone: "success" };
  return { label: "Pending", tone: "pending" };
}

function syncCallbackMessage(result: string): string {
  const messages: Record<string, string> = {
    denied: "Google Drive access was not granted.",
    invalid_state: "The sync authorization expired or was already used. Try connecting again.",
    configuration_error: "Google Drive sync is incomplete on this deployment.",
    connection_failed: "Google Drive could not be connected. Try again.",
  };
  return messages[result] ?? "The sync connection could not be completed.";
}

function syncFailureMessage(code: string): string {
  if (code === "google_reauthorization_required") return "Google authorization expired. Reconnect this destination.";
  if (code === "sync_credential_invalid") return "The stored credential cannot be decrypted. Reconnect this destination.";
  if (code === "sync_network_failed") return "The provider could not be reached. A retry will be scheduled.";
  if (code === "google_drive_upload_failed" || code === "google_drive_create_failed") return "Google Drive rejected the snapshot. Try again or reconnect.";
  if (code === "google_drive_parent_missing") return "The Drive folder was removed. The next run will recreate it.";
  if (code === "github_401" || code === "github_403") return "GitHub access expired. The deployment owner must rotate its repository token.";
  if (code.startsWith("github_") || code === "sync_failed") return "The snapshot could not be created. Check the Worker logs and retry.";
  return "The last sync did not complete. Try again.";
}

const pendingSyncVaultKey = "obsidian-vault-sync-repository";
function readPendingSyncVault(): string | undefined {
  try { return window.sessionStorage.getItem(pendingSyncVaultKey) ?? undefined; } catch { return undefined; }
}
function writePendingSyncVault(vaultId: string): void {
  try { window.sessionStorage.setItem(pendingSyncVaultKey, vaultId); } catch {}
}
function clearPendingSyncVault(): void {
  try { window.sessionStorage.removeItem(pendingSyncVaultKey); } catch {}
}

function Logo() { return <svg className="logo" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 27 9l-3 17-8 4-8-4L5 9 16 2Z"/><path d="m5 9 11 8 11-8M16 17v13M8 26l8-9 8 9"/></svg>; }
function SearchIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>; }
function DocumentIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5z"/><path d="M12 2.5v3h3M7.5 9h5M7.5 12h5"/></svg>; }
function FolderIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5h5l1.5 2h8.5v8.5h-15z"/></svg>; }
function ChevronIcon({ expanded }: { expanded: boolean }) { return <svg className={expanded ? "chevron expanded" : "chevron"} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>; }
function SparkIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.5 5.3 2.7 7.5 8 8-5.3.5-7.5 2.7-8 8-.5-5.3-2.7-7.5-8-8 5.3-.5 7.5-2.7 8-8Z"/><path d="M19 16c.2 2 1 2.8 3 3-2 .2-2.8 1-3 3-.2-2-1-2.8-3-3 2-.2 2.8-1 3-3Z"/></svg>; }
function GitHubIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1 1.6 1 .9 1.6 2.4 1.1 2.9.9.1-.7.4-1.1.6-1.3-2.3-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .9-.3 2.8 1a9.7 9.7 0 0 1 5.1 0c2-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1.1 2.7c0 3.9-2.4 4.7-4.7 5 .4.3.7 1 .7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/></svg>; }
