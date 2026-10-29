// Minimal code editor: CodeMirror 6 with a handful of statically bundled
// languages. Dynamic language loading would split the bundle into chunks,
// and Pouch must stay one hash-checkable file, so the set is fixed here.
//
// Two modes share one view. Normal mode edits a file against a baseline (the
// text last loaded or saved). Diff mode adds @codemirror/merge's unified view
// on top of the same document, so reviewing a change needs no second editor.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, Transaction } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { unifiedMergeView } from '@codemirror/merge';
import { highlightCode, classHighlighter } from '@lezer/highlight';
import { syntaxHighlighting } from '@codemirror/language';
import { javascript, javascriptLanguage, jsxLanguage, typescriptLanguage, tsxLanguage } from '@codemirror/lang-javascript';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { html, htmlLanguage } from '@codemirror/lang-html';
import { css, cssLanguage } from '@codemirror/lang-css';
import { json, jsonLanguage } from '@codemirror/lang-json';

const byExt = {
  js: () => javascript(), mjs: () => javascript(), cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }), tsx: () => javascript({ typescript: true, jsx: true }),
  py: () => python(), md: () => markdown(), markdown: () => markdown(),
  html: () => html(), htm: () => html(), svg: () => html(), xml: () => html(),
  css: () => css(), json: () => json(), jsonc: () => json(),
};

// Code blocks in replies reuse the same parsers: Lezer tokens become spans
// with tok-* classes (styled in pouch.html), built as DOM nodes, never HTML.
const byFence = {
  js: javascriptLanguage, javascript: javascriptLanguage, mjs: javascriptLanguage, cjs: javascriptLanguage,
  jsx: jsxLanguage, ts: typescriptLanguage, typescript: typescriptLanguage, tsx: tsxLanguage,
  py: pythonLanguage, python: pythonLanguage, md: markdownLanguage, markdown: markdownLanguage,
  html: htmlLanguage, htm: htmlLanguage, xml: htmlLanguage, svg: htmlLanguage,
  css: cssLanguage, json: jsonLanguage, jsonc: jsonLanguage,
};
export function highlight(code, lang, doc = document) {
  const language = byFence[lang];
  if (!language) return null;
  const out = [];
  highlightCode(code, language.parser.parse(code), classHighlighter, (text, cls) => {
    if (!cls) return out.push(doc.createTextNode(text));
    const s = doc.createElement('span');
    s.className = cls; s.textContent = text;
    out.push(s);
  }, () => out.push(doc.createTextNode('\n')));
  return out;
}

export function languageFor(path) {
  const ext = path.split('.').pop().toLowerCase();
  return byExt[ext]?.() ?? [];
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  '.cm-chunkButtons button': { minHeight: '1.6rem', padding: '0 .5rem', fontSize: '12px' },
});

// Merge controls with words a screen reader can say; labels depend on the mode.
const controls = (labels) => (type, action) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = labels[type];
  b.setAttribute('aria-label', labels[type] + ' this change');
  b.name = type;
  b.onclick = action; // click, not mousedown, so Enter and Space work too
  return b;
};

// onChange(dirty) fires when the buffer diverges from or returns to the baseline.
// onRevert(text) fires when a reject button in a read-only review changes the text.
export function createEditor(parent, { onSave, onChange, onRevert }) {
  const lang = new Compartment(), merge = new Compartment(), ro = new Compartment(), label = new Compartment(), palette = new Compartment();
  const colorTheme = () => EditorView.theme({}, { dark: document.documentElement.dataset.theme === 'dark' });
  let saved = '';
  let mode = 'normal'; // 'normal' | 'review' (read-only diff) | 'merge' (editable diff)
  const quiet = Transaction.addToHistory.of(false);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup, theme, palette.of(colorTheme()), syntaxHighlighting(classHighlighter), lang.of([]), merge.of([]), ro.of([]), EditorView.lineWrapping,
        label.of(EditorView.contentAttributes.of({ 'aria-label': 'File editor' })),
        keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => (mode !== 'review' && onSave(), true) }]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const text = view.state.doc.toString();
          if (mode === 'review') { if (u.transactions.some((t) => t.isUserEvent('revert'))) onRevert?.(text); }
          else onChange(text !== saved);
        }),
      ],
    }),
  });
  document.documentElement.addEventListener('pouch-theme', () => view.dispatch({ effects: palette.reconfigure(colorTheme()) }));
  function setDoc(path, text, extra = []) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      effects: [lang.reconfigure(languageFor(path)), label.reconfigure(EditorView.contentAttributes.of({ 'aria-label': 'Contents of ' + path })), ...extra],
      selection: { anchor: 0 }, annotations: quiet,
    });
  }
  return {
    view,
    get mode() { return mode; },
    get baseline() { return saved; },
    load(path, text) {
      saved = text; mode = 'normal';
      setDoc(path, text, [merge.reconfigure([]), ro.reconfigure([])]);
      onChange(false);
    },
    text: () => view.state.doc.toString(),
    markSaved() { saved = view.state.doc.toString(); onChange(false); },
    // Acknowledge a newer disk version without touching the buffer.
    setBaseline(text) { saved = text; onChange(view.state.doc.toString() !== saved); },
    // Review: show `current` against `original`, read-only; reject reverts a
    // chunk (reported through onRevert). editable: a merge of the buffer
    // (kept as is) against another version, where reject takes theirs.
    diff(path, original, current, { editable = false, buttons = true } = {}) {
      mode = editable ? 'merge' : 'review';
      const labels = editable ? { accept: 'Keep mine', reject: 'Take theirs' } : { accept: 'Keep', reject: 'Revert' };
      const ext = unifiedMergeView({ original, mergeControls: buttons && controls(labels), collapseUnchanged: { margin: 3 } });
      if (editable && current === view.state.doc.toString()) {
        view.dispatch({ effects: [merge.reconfigure(ext), ro.reconfigure([])] });
      } else {
        setDoc(path, current, [merge.reconfigure(ext), ro.reconfigure(editable ? [] : [EditorState.readOnly.of(true)])]);
      }
    },
    // Leave diff mode, keeping the document as it stands.
    endDiff() {
      mode = 'normal';
      view.dispatch({ effects: [merge.reconfigure([]), ro.reconfigure([])] });
      onChange(view.state.doc.toString() !== saved);
    },
    gotoLine(n) {
      const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    },
    focus: () => view.focus(),
  };
}
