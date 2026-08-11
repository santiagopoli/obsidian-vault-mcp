import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { NoteSummary } from "./api";
import {
  MAX_NOTE_MENTIONS,
  activeNoteMention,
  extractMentionedPaths,
  insertNoteMention,
  mentionMenuKeyAction,
  parseMentionDocument,
  removeMentionOccurrence,
  serializeMentionDocument,
  suggestNoteMentions,
} from "./noteMentions";

interface MentionEditorProps {
  value: string;
  notes: NoteSummary[];
  disabled: boolean;
  maxLength: number;
  placeholder: string;
  noteHref: (path: string) => string;
  onChange: (value: string) => void;
  onMentionAdded: (value: string) => void;
  onOpenNote: (path: string) => void;
}

interface ChipMenu {
  path: string;
  occurrence: number;
  rawStart: number;
  left: number;
  top: number;
  above: boolean;
}

export function MentionEditor({ value, notes, disabled, maxLength, placeholder, noteHref, onChange, onMentionAdded, onOpenNote }: MentionEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const chipMenuRef = useRef<HTMLDivElement>(null);
  const [editorValue, setEditorValue] = useState(value);
  const [mentionCaret, setMentionCaret] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [chipMenu, setChipMenu] = useState<ChipMenu>();
  const [feedback, setFeedback] = useState("");
  const validPaths = useMemo(() => new Set(notes.map(({ path }) => path)), [notes]);
  const mentionedPaths = useMemo(() => extractMentionedPaths(editorValue), [editorValue]);
  const activeMention = useMemo(
    () => mentionCaret === null ? undefined : activeNoteMention(editorValue, mentionCaret),
    [editorValue, mentionCaret],
  );
  const suggestions = useMemo(
    () => activeMention ? suggestNoteMentions(notes, activeMention.query, mentionedPaths) : [],
    [activeMention, mentionedPaths, notes],
  );

  useEffect(() => { setMentionIndex(0); }, [activeMention?.query]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editorMatchesValue(editor, value, validPaths)) {
      setEditorValue(value);
      return;
    }
    renderEditor(editor, value, validPaths);
    setEditorValue(value);
    setMentionCaret(null);
    setChipMenu(undefined);
  }, [validPaths, value]);

  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setChipMenu(undefined);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function commit(nextValue: string, caret: number, mentionAdded = false) {
    if (nextValue.length > maxLength) return;
    const editor = editorRef.current;
    if (!editor) return;
    renderEditor(editor, nextValue, validPaths);
    setEditorValue(nextValue);
    setMentionCaret(caret);
    setChipMenu(undefined);
    onChange(nextValue);
    if (mentionAdded) onMentionAdded(nextValue);
    requestAnimationFrame(() => {
      editor.focus();
      setCaretAtRawOffset(editor, caret);
    });
  }

  function reconcileEditor() {
    const editor = editorRef.current;
    if (!editor) return;
    const nextValue = readEditorValue(editor);
    if (nextValue.length > maxLength) {
      renderEditor(editor, editorValue, validPaths);
      setCaretAtRawOffset(editor, editorValue.length);
      return;
    }
    const caret = rawSelectionOffset(editor);
    setEditorValue(nextValue);
    setMentionCaret(caret);
    setChipMenu(undefined);
    onChange(nextValue);
  }

  function chooseMention(path: string) {
    if (!activeMention) return;
    const inserted = insertNoteMention(editorValue, activeMention, path);
    commit(inserted.value, inserted.caret, true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (chipMenu && event.key === "Escape") {
      event.preventDefault();
      closeChipMenu(true);
      return;
    }
    const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-mention-chip]");
    if (chip && (event.key === "Enter" || event.key === " " || event.key === "ArrowDown")) {
      event.preventDefault();
      openChipMenu(chip);
      return;
    }
    const action = mentionMenuKeyAction(event.key, mentionIndex, suggestions.length, event.nativeEvent.isComposing);
    if (action.type === "navigate") {
      event.preventDefault();
      setMentionIndex(action.index);
    } else if (action.type === "select") {
      event.preventDefault();
      const suggestion = suggestions[action.index];
      if (suggestion) chooseMention(suggestion.path);
    } else if (action.type === "close") {
      event.preventDefault();
      setMentionCaret(null);
    }
  }

  function handleBeforeInput(event: FormEvent<HTMLDivElement>) {
    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.inputType !== "insertParagraph" && inputEvent.inputType !== "insertLineBreak") return;
    event.preventDefault();
    insertPlainText("\n");
    reconcileEditor();
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    insertPlainText(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
    const editor = editorRef.current;
    if (!editor) return;
    const nextValue = readEditorValue(editor);
    const addedMention = extractMentionedPaths(nextValue).some((path) => !mentionedPaths.includes(path));
    commit(nextValue, rawSelectionOffset(editor) ?? nextValue.length, addedMention);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-mention-chip]");
    if (!chip) return;
    event.preventDefault();
    openChipMenu(chip);
  }

  function openChipMenu(chip: HTMLElement) {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const chipRect = chip.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const above = chipRect.bottom + 150 > window.innerHeight;
    editorRef.current?.querySelectorAll<HTMLElement>("[data-mention-chip]").forEach((candidate) => candidate.setAttribute("aria-expanded", String(candidate === chip)));
    setChipMenu({
      path: chip.dataset.mentionPath ?? "",
      occurrence: Number(chip.dataset.mentionOccurrence ?? "0"),
      rawStart: Number(chip.dataset.mentionStart ?? "0"),
      left: Math.max(0, Math.min(chipRect.left - wrapperRect.left, wrapperRect.width - 180)),
      top: above ? chipRect.top - wrapperRect.top - 6 : chipRect.bottom - wrapperRect.top + 6,
      above,
    });
    requestAnimationFrame(() => chipMenuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus());
  }

  function closeChipMenu(restoreFocus = false) {
    if (restoreFocus && chipMenu) editorRef.current?.querySelector<HTMLElement>(`[data-mention-start="${chipMenu.rawStart}"]`)?.focus();
    editorRef.current?.querySelectorAll<HTMLElement>("[data-mention-chip]").forEach((chip) => chip.setAttribute("aria-expanded", "false"));
    setChipMenu(undefined);
  }

  function removeMention() {
    if (!chipMenu) return;
    const parts = parseMentionDocument(editorValue, validPaths);
    const nextValue = serializeMentionDocument(removeMentionOccurrence(parts, chipMenu.occurrence));
    commit(nextValue, Math.min(chipMenu.rawStart, nextValue.length));
    setFeedback("Mention removed");
  }

  async function copyMentionLink() {
    if (!chipMenu) return;
    try {
      await navigator.clipboard.writeText(new URL(noteHref(chipMenu.path), window.location.origin).href);
      setFeedback("Link copied");
      setChipMenu(undefined);
    } catch {
      setFeedback("Link could not be copied");
    }
  }

  return <div ref={wrapperRef} className="mention-editor-wrap">
    <div
      id="vault-question"
      ref={editorRef}
      className="mention-editor"
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="combobox"
      aria-label="Question for your vault"
      aria-multiline="true"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-expanded={Boolean(activeMention)}
      aria-controls={activeMention ? "note-mention-options" : undefined}
      aria-activedescendant={activeMention && suggestions.length > 0 ? `note-mention-option-${mentionIndex}` : undefined}
      aria-disabled={disabled}
      data-placeholder={placeholder}
      onInput={reconcileEditor}
      onBeforeInput={handleBeforeInput}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onKeyUp={() => { const editor = editorRef.current; if (editor) setMentionCaret(rawSelectionOffset(editor)); }}
      onPointerUp={() => { const editor = editorRef.current; if (editor) setMentionCaret(rawSelectionOffset(editor)); }}
      onPointerDown={handlePointerDown}
      onBlur={(event) => { if (!wrapperRef.current?.contains(event.relatedTarget as Node)) setMentionCaret(null); }}
    />

    {activeMention && <div id="note-mention-options" className="mention-menu" role="listbox" aria-label="Mention a note">
      {suggestions.map((suggestion, index) => <button
        id={`note-mention-option-${index}`}
        type="button"
        role="option"
        aria-selected={index === mentionIndex}
        className={index === mentionIndex ? "active" : ""}
        key={suggestion.path}
        onPointerDown={(event) => { event.preventDefault(); chooseMention(suggestion.path); }}
      ><strong>{basename(suggestion.path)}</strong><span>{dirname(suggestion.path)}</span></button>)}
      {suggestions.length === 0 && <p>{mentionedPaths.length >= MAX_NOTE_MENTIONS ? `You can mention up to ${MAX_NOTE_MENTIONS} notes.` : "No matching note"}</p>}
    </div>}

    {chipMenu && <div ref={chipMenuRef} className={`mention-chip-menu${chipMenu.above ? " above" : ""}`} role="menu" style={{ left: chipMenu.left, top: chipMenu.top }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeChipMenu(true); } }}>
      <a role="menuitem" href={noteHref(chipMenu.path)} onClick={(event) => { event.preventDefault(); setChipMenu(undefined); onOpenNote(chipMenu.path); }}>Open note</a>
      <button type="button" role="menuitem" onClick={() => void copyMentionLink()}>Copy link</button>
      <button type="button" role="menuitem" className="remove" onClick={removeMention}>Remove mention</button>
    </div>}
    <span className="sr-only" aria-live="polite">{feedback}</span>
  </div>;
}

function renderEditor(editor: HTMLElement, value: string, validPaths: ReadonlySet<string>) {
  const fragment = document.createDocumentFragment();
  let occurrence = 0;
  let rawOffset = 0;
  for (const part of parseMentionDocument(value, validPaths)) {
    if (part.type === "text") {
      fragment.append(document.createTextNode(part.text));
      rawOffset += part.text.length;
      continue;
    }
    const token = `@[[${part.path}]]`;
    const chip = document.createElement("span");
    chip.className = "mention-chip";
    chip.contentEditable = "false";
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-haspopup", "menu");
    chip.setAttribute("aria-expanded", "false");
    chip.dataset.mentionChip = "true";
    chip.dataset.mentionPath = part.path;
    chip.dataset.mentionOccurrence = String(occurrence);
    chip.dataset.mentionStart = String(rawOffset);
    chip.title = part.path;
    chip.setAttribute("aria-label", `Mentioned note: ${basename(part.path)}, ${part.path}`);
    const label = document.createElement("span");
    label.className = "mention-chip-label";
    label.textContent = `@${basename(part.path)}`;
    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "mention-chip-toggle";
    menu.tabIndex = -1;
    menu.setAttribute("aria-label", `Actions for ${part.path}`);
    menu.textContent = "⌄";
    chip.append(label, menu);
    fragment.append(chip);
    occurrence += 1;
    rawOffset += token.length;
  }
  editor.replaceChildren(fragment);
}

function readEditorValue(editor: HTMLElement): string {
  return [...editor.childNodes].map(readNode).join("");
}

function editorMatchesValue(editor: HTMLElement, value: string, validPaths: ReadonlySet<string>): boolean {
  if (readEditorValue(editor) !== value) return false;
  const expectedPaths = parseMentionDocument(value, validPaths).flatMap((part) => part.type === "mention" ? [part.path] : []);
  const renderedPaths = [...editor.querySelectorAll<HTMLElement>("[data-mention-chip]")].map((chip) => chip.dataset.mentionPath ?? "");
  return expectedPaths.length === renderedPaths.length && expectedPaths.every((path, index) => path === renderedPaths[index]);
}

function readNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.dataset.mentionPath) return `@[[${node.dataset.mentionPath}]]`;
  if (node.tagName === "BR") return "\n";
  return [...node.childNodes].map(readNode).join("");
}

function rawSelectionOffset(editor: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) && range.startContainer !== editor) return null;
  return offsetWithin(editor, range.startContainer, range.startOffset)?.offset ?? null;
}

function offsetWithin(root: Node, target: Node, targetOffset: number): { found: true; offset: number } | undefined {
  if (root === target) {
    if (root.nodeType === Node.TEXT_NODE) return { found: true, offset: Math.min(targetOffset, root.textContent?.length ?? 0) };
    return { found: true, offset: [...root.childNodes].slice(0, targetOffset).reduce((total, child) => total + rawLength(child), 0) };
  }
  let offset = 0;
  for (const child of root.childNodes) {
    const nested = offsetWithin(child, target, targetOffset);
    if (nested) return { found: true, offset: offset + nested.offset };
    offset += rawLength(child);
  }
  return undefined;
}

function rawLength(node: Node): number {
  return readNode(node).length;
}

function setCaretAtRawOffset(editor: HTMLElement, requestedOffset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  let remaining = Math.max(0, requestedOffset);
  for (let index = 0; index < editor.childNodes.length; index += 1) {
    const child = editor.childNodes[index];
    const length = rawLength(child);
    if (remaining <= length) {
      if (child.nodeType === Node.TEXT_NODE) range.setStart(child, Math.min(remaining, child.textContent?.length ?? 0));
      else range.setStart(editor, remaining === 0 ? index : index + 1);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
  }
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPlainText(text: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function basename(path: string) { return path.split("/").pop()?.replace(/\.md$/i, "") ?? path; }
function dirname(path: string) { const parts = path.split("/"); parts.pop(); return parts.join(" / ") || "Vault root"; }
