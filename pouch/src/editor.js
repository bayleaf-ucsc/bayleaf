// Minimal code editor: CodeMirror 6 with a handful of statically bundled
// languages. Dynamic language loading would split the bundle into chunks,
// and Pouch must stay one hash-checkable file, so the set is fixed here.
//
// Two modes share one view. Normal mode edits a file against a baseline (the
// text last loaded or saved). Merge mode adds @codemirror/merge's unified view
// on top of the same document, to settle a conflict without a second editor.
// flash(other) marks, once, the lines where the buffer and `other` differ
// (continuity: the lines that just changed underneath you, README).
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, Transaction, StateField, StateEffect } from '@codemirror/state';
import { keymap, Decoration } from '@codemirror/view';
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

// Lines that differ between two texts, as a 1-based range in `a` (common
// prefix and suffix trimmed), or null when they are equal.
export function changedLines(a, b) {
  if (a === b) return null;
  const x = a.split('\n'), y = b.split('\n');
  let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0; while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  const from = Math.min(i + 1, x.length);
  return { from, to: Math.max(from, x.length - j) };
}
const setFlash = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setFlash)) return e.value;
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// onChange(dirty) fires when the buffer diverges from or returns to the baseline.
export function createEditor(parent, { onSave, onChange }) {
  const lang = new Compartment(), merge = new Compartment(), ro = new Compartment(), label = new Compartment(), palette = new Compartment();
  const colorTheme = () => EditorView.theme({}, { dark: document.documentElement.dataset.theme === 'dark' });
  let saved = '';
  let mode = 'normal'; // 'normal' | 'merge' (editable diff)
  const quiet = Transaction.addToHistory.of(false);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup, theme, flashField, palette.of(colorTheme()), syntaxHighlighting(classHighlighter), lang.of([]), merge.of([]), ro.of([]), EditorView.lineWrapping,
        label.of(EditorView.contentAttributes.of({ 'aria-label': 'File editor' })),
        keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => (onSave(), true) }]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const text = view.state.doc.toString();
          onChange(text !== saved);
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
    // Merge: the buffer (kept as is) against another version (`original`),
    // where reject takes theirs.
    diff(path, original, current) {
      mode = 'merge';
      const ext = unifiedMergeView({ original, mergeControls: controls({ accept: 'Keep mine', reject: 'Take theirs' }), collapseUnchanged: { margin: 3 } });
      if (current === view.state.doc.toString()) view.dispatch({ effects: [merge.reconfigure(ext), ro.reconfigure([])] });
      else setDoc(path, current, [merge.reconfigure(ext), ro.reconfigure([])]);
    },
    // Mark the lines where the buffer differs from `other`, once (CSS
    // animation .cm-flash; a static highlight under reduced motion).
    flash(other) {
      const r = changedLines(view.state.doc.toString(), other);
      if (!r) return null;
      const doc = view.state.doc, line = Decoration.line({ class: 'cm-flash' });
      const marks = [];
      for (let n = r.from; n <= Math.min(r.to, doc.lines); n++) marks.push(line.range(doc.line(n).from));
      view.dispatch({ effects: setFlash.of(Decoration.set(marks)) });
      setTimeout(() => view.dispatch({ effects: setFlash.of(Decoration.none) }), 1600);
      return r;
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
