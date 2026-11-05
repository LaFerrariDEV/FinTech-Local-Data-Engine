"use client";

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import * as React from "react";

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#7aa7ef" },
  { tag: [t.string, t.special(t.string)], color: "#9fd29f" },
  { tag: [t.number, t.bool, t.null], color: "#e0a458" },
  { tag: t.comment, color: "#5c626c", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: "#c3a6f5" },
  { tag: t.operator, color: "#9aa0aa" },
  { tag: [t.typeName, t.className], color: "#e88aa9" },
  { tag: t.punctuation, color: "#7d838d" },
]);

const DUCKDB_FUNCTIONS = [
  "time_bucket", "date_trunc", "epoch_ms", "make_timestamp", "strftime", "strptime", "try_strptime", "arg_max", "arg_min",
  "quantile_cont", "median", "stddev_samp", "stddev_pop", "corr", "regr_slope", "lag", "lead", "first_value", "last_value",
  "row_number", "ntile", "cume_dist", "percent_rank", "list", "unnest", "range", "generate_series", "read_csv", "sniff_csv",
];

function functionCompletion(ctx: CompletionContext) {
  const word = ctx.matchBefore(/\w+/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return { from: word.from, options: DUCKDB_FUNCTIONS.map((f) => ({ label: f, type: "function", apply: `${f}(` })), validFor: /^\w*$/ };
}

function languageExtension(schema: SQLNamespace) {
  return [sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true }), PostgreSQL.language.data.of({ autocomplete: functionCompletion })];
}

export interface SqlEditorHandle {
  focus(): void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun: (text: string) => void;
  schema: SQLNamespace;
}

/** CodeMirror 6 SQL editor with schema-aware autocomplete. Mod-Enter runs the selection or the whole script. */
export const SqlEditor = React.forwardRef<SqlEditorHandle, Props>(function SqlEditor({ value, onChange, onRun, schema }, ref) {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  const language = React.useRef(new Compartment());
  const callbacks = React.useRef({ onChange, onRun });
  callbacks.current = { onChange, onRun };

  React.useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), []);

  React.useEffect(() => {
    if (!host.current) return;
    const runKey = Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: (v) => {
            const sel = v.state.selection.main;
            callbacks.current.onRun(sel.empty ? v.state.doc.toString() : v.state.sliceDoc(sel.from, sel.to));
            return true;
          },
        },
      ]),
    );
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          runKey,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          autocompletion({ activateOnTyping: true, maxRenderedOptions: 50 }),
          syntaxHighlighting(highlight),
          placeholder("SELECT * FROM my_dataset LIMIT 100  —  ⌘/Ctrl + Enter to run"),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          language.current.of(languageExtension(schema)),
          EditorView.theme({}, { dark: true }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ "aria-label": "SQL editor", "data-testid": "sql-editor" }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor is created once; value/schema updates are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (history, snippets, "show SQL").
  React.useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  React.useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(languageExtension(schema)) });
  }, [schema]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
});
