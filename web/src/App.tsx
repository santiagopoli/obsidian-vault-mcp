import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  ApiError,
  chat,
  getNote,
  getNotes,
  getSession,
  getVaults,
  logout,
  searchNotes,
  type Note,
  type NoteSummary,
  type SearchMatch,
  type Session,
  type Vault,
} from "./api";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: Array<{ id: string; path: string; sha: string }>;
  noteCount?: number;
};

export function App() {
  const [session, setSession] = useState<Session>();
  const [authChecked, setAuthChecked] = useState(false);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vaultId, setVaultId] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [noteTotal, setNoteTotal] = useState(0);
  const [hasMoreNotes, setHasMoreNotes] = useState(false);
  const [loadingMoreNotes, setLoadingMoreNotes] = useState(false);
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
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string>();
  const [mobilePane, setMobilePane] = useState<"files" | "note" | "chat">("files");
  const vaultIdRef = useRef(vaultId);
  vaultIdRef.current = vaultId;

  useEffect(() => {
    void getSession()
      .then(async (current) => {
        setSession(current);
        if (!current) return;
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
    setHasMoreNotes(false);
    setSelectedPath("");
    setSelectedSha(undefined);
    setNote(undefined);
    setSearchResults(undefined);
    setMessages([]);
    setError(undefined);
    void getNotes(vaultId)
      .then((page) => {
        if (cancelled) return;
        setNotes(page.notes);
        setNoteTotal(page.total);
        setHasMoreNotes(page.hasMore);
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

  const chatContextKey = `${vaultId}:${chatScope}:${chatScope === "note" ? selectedPath : ""}`;
  const chatContextRef = useRef(chatContextKey);
  chatContextRef.current = chatContextKey;
  useEffect(() => {
    setMessages([]);
    setQuestion("");
  }, [chatContextKey]);

  const visibleNotes = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query ? notes.filter((item) => item.path.toLocaleLowerCase().includes(query)) : notes;
  }, [filter, notes]);
  const currentVault = vaults.find((vault) => vault.id === vaultId);

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!vaultId || query.length < 2) return;
    setSearching(true);
    setError(undefined);
    try {
      const requestedVault = vaultId;
      const results = await searchNotes(requestedVault, query);
      if (vaultIdRef.current === requestedVault) setSearchResults(results);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSearching(false);
    }
  }

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    const cleanQuestion = question.trim();
    if (!session || !vaultId || !cleanQuestion || (chatScope === "note" && !selectedPath)) return;
    const nextUser: ChatMessage = { role: "user", content: cleanQuestion };
    const history = messages.slice(-8).map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, nextUser]);
    setQuestion("");
    setAsking(true);
    setError(undefined);
    try {
      const requestedVault = vaultId;
      const requestedScope = chatScope;
      const requestedPath = selectedPath;
      const requestedContext = chatContextKey;
      const reply = await chat(requestedVault, session.csrf_token, {
        question: cleanQuestion,
        activePath: requestedScope === "note" ? requestedPath || undefined : undefined,
        scope: chatScope,
        history,
      });
      if (vaultIdRef.current !== requestedVault || chatContextRef.current !== requestedContext) return;
      setMessages((current) => [...current, {
        role: "assistant",
        content: reply.answer,
        citations: reply.citations,
        noteCount: reply.context.note_count,
      }]);
    } catch (caught) {
      setError(messageFor(caught));
      setQuestion(cleanQuestion);
    } finally {
      setAsking(false);
    }
  }

  async function signOut() {
    if (!session) return;
    await logout(session.csrf_token).catch(() => undefined);
    location.assign("/");
  }

  async function loadMoreNotes() {
    if (!vaultId || loadingMoreNotes || !hasMoreNotes) return;
    setLoadingMoreNotes(true);
    try {
      const page = await getNotes(vaultId, notes.length);
      setNotes((current) => [...current, ...page.notes]);
      setNoteTotal(page.total);
      setHasMoreNotes(page.hasMore);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoadingMoreNotes(false);
    }
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
              <div className="section-label"><span>{searchResults.length} matches</span><button onClick={() => setSearchResults(undefined)}>Clear</button></div>
              {searchResults.map((result) => (
                <button className="result-card" key={result.path} onClick={() => { setSelectedSha(undefined); setSelectedPath(result.path); setMobilePane("note"); }}>
                  <strong>{basename(result.path)}</strong><small>{dirname(result.path)}</small><span>{result.excerpt}</span>
                </button>
              ))}
              {searchResults.length === 0 && <Empty text="No matching notes" />}
            </section>
          )}
          {searchResults === undefined && <>
            <div className="path-filter"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter paths" aria-label="Filter note paths" /></div>
            <div className="file-list" aria-label="Markdown notes">
              {visibleNotes.map((item) => (
                <button
                  aria-current={selectedPath === item.path ? "true" : undefined}
                  className={selectedPath === item.path ? "file-item selected" : "file-item"}
                  key={item.path}
                  onClick={() => { setSelectedSha(undefined); setSelectedPath(item.path); setMobilePane("note"); }}
                >
                  <DocumentIcon /><span><strong>{basename(item.path)}</strong><small>{dirname(item.path)}</small></span>
                </button>
              ))}
              {hasMoreNotes && !filter && <button className="load-more" onClick={loadMoreNotes} disabled={loadingMoreNotes}>{loadingMoreNotes ? "Loading…" : "Load more notes"}</button>}
              {visibleNotes.length === 0 && <Empty text="No notes here yet" />}
            </div>
          </>}
        </nav>

        <main className="reader" id="document">
          {loadingNote && <DocumentSkeleton />}
          {!loadingNote && note && <article>
            <div className="document-meta">
              <span>{note.path}{note.cited_revision ? " · cited revision" : ""}</span>{note.html_url && <a href={note.html_url} target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>}
            </div>
            <ReactMarkdown components={{
              a: ({ href, children }) => <a href={safeHref(href)} target="_blank" rel="noopener noreferrer">{children}</a>,
              img: () => <span className="blocked-media">Image omitted</span>,
            }}>{note.content}</ReactMarkdown>
          </article>}
          {!loadingNote && !note && <div className="reader-empty"><div className="empty-mark">◇</div><h1>Open a note</h1><p>Select a document or search across <strong>{currentVault?.name}</strong>.</p></div>}
        </main>

        <aside className="chat-panel" aria-label="Ask your vault">
          <div className="chat-header"><div><span className="eyebrow">Grounded answers</span><h2>Ask your vault</h2></div><SparkIcon /></div>
          <div className="scope-control">
            <span>Context</span>
            <div className="segmented">
              <button aria-pressed={chatScope === "vault"} className={chatScope === "vault" ? "active" : ""} onClick={() => setChatScope("vault")}>Entire vault</button>
              <button aria-pressed={chatScope === "note"} className={chatScope === "note" ? "active" : ""} onClick={() => setChatScope("note")} disabled={!selectedPath}>This note</button>
            </div>
            {selectedPath && <span className="context-chip"><DocumentIcon />{basename(selectedPath)}</span>}
          </div>
          <div className="messages" aria-live="polite">
            {messages.length === 0 && <div className="chat-empty"><SparkIcon /><h3>{session.chat_enabled ? "Ask with evidence" : "Chat is not enabled"}</h3><p>{session.chat_enabled ? "I’ll search only this vault and show which notes supported the answer." : "Add the OpenAI secret and enable vault chat in this deployment."}</p><div className="suggestions">
              <button disabled={!session.chat_enabled} onClick={() => setQuestion("Summarize the main themes in this vault")}>Summarize the main themes</button>
              <button disabled={!session.chat_enabled || !selectedPath} onClick={() => setQuestion("What are the key facts in this note?")}>Explain this note</button>
            </div></div>}
            {messages.map((message, index) => <div className={`message ${message.role}`} key={index}>
              <span className="message-role">{message.role === "assistant" ? "Vault" : "You"}</span>
              {message.role === "assistant" ? <ReactMarkdown>{message.content}</ReactMarkdown> : <p>{message.content}</p>}
              {message.citations && message.citations.length > 0 && <div className="citations">
                {message.citations.map((citation) => <button key={citation.id} onClick={() => { setSelectedSha(citation.sha); setSelectedPath(citation.path); setMobilePane("note"); }}><span>{citation.id}</span>{basename(citation.path)}</button>)}
              </div>}
              {message.noteCount !== undefined && <small className="context-count">AI received {message.noteCount} note{message.noteCount === 1 ? "" : "s"}</small>}
            </div>)}
            {asking && <div className="message assistant thinking" role="status" aria-label="Searching the vault"><span></span><span></span><span></span></div>}
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

function SignIn({ error }: { error?: string }) {
  return <main className="signin"><div className="signin-card"><Logo /><span className="eyebrow">Private owner-only deployment</span><h1>Read deeply.<br />Ask precisely.</h1><p>Browse, search, and discuss the Markdown notes in the repositories explicitly authorized for this owner.</p>{error && <div className="signin-error">{error}</div>}<a className="signin-button" href="/web/login"><GitHubIcon />Continue with GitHub</a><small>This preview supports multiple vaults for one configured GitHub owner. Other users cannot onboard.</small></div><div className="signin-art" aria-hidden="true"><div className="orb one"></div><div className="orb two"></div><div className="grid-lines"></div><blockquote>“The map is not the territory,<br />but good notes get us closer.”</blockquote></div></main>;
}

function LoadingScreen() { return <main className="loading-screen"><Logo /><span>Opening your vault…</span></main>; }
function Empty({ text }: { text: string }) { return <div className="empty-list">{text}</div>; }
function DocumentSkeleton() { return <div className="document-skeleton"><i></i><i></i><i></i><i></i><i></i></div>; }
function basename(path: string) { return path.split("/").pop()?.replace(/\.md$/i, "") ?? path; }
function dirname(path: string) { const parts = path.split("/"); parts.pop(); return parts.join(" / ") || "Vault root"; }
function safeHref(href: string | undefined) { if (!href) return undefined; return /^(https?:|mailto:)/i.test(href) ? href : undefined; }
function messageFor(error: unknown) {
  if (!(error instanceof ApiError)) return "Something went wrong. Please try again.";
  const messages: Record<string, string> = {
    chat_not_configured: "Chat is not configured on this deployment yet.",
    chat_daily_limit_reached: "The daily chat limit has been reached.",
    model_rate_limited: "The model is busy. Try again in a moment.",
    model_unavailable: "The model is temporarily unavailable.",
    authentication_required: "Your session expired. Sign in again.",
    vault_not_found: "This vault is no longer available.",
  };
  return messages[error.code] ?? "The request could not be completed.";
}

function Logo() { return <svg className="logo" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 27 9l-3 17-8 4-8-4L5 9 16 2Z"/><path d="m5 9 11 8 11-8M16 17v13M8 26l8-9 8 9"/></svg>; }
function SearchIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>; }
function DocumentIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5z"/><path d="M12 2.5v3h3M7.5 9h5M7.5 12h5"/></svg>; }
function SparkIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.5 5.3 2.7 7.5 8 8-5.3.5-7.5 2.7-8 8-.5-5.3-2.7-7.5-8-8 5.3-.5 7.5-2.7 8-8Z"/><path d="M19 16c.2 2 1 2.8 3 3-2 .2-2.8 1-3 3-.2-2-1-2.8-3-3 2-.2 2.8-1 3-3Z"/></svg>; }
function GitHubIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1 1.6 1 .9 1.6 2.4 1.1 2.9.9.1-.7.4-1.1.6-1.3-2.3-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .9-.3 2.8 1a9.7 9.7 0 0 1 5.1 0c2-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1.1 2.7c0 3.9-2.4 4.7-4.7 5 .4.3.7 1 .7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/></svg>; }
