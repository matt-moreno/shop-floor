import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  lintGutter,
  setDiagnostics,
  type Diagnostic as CmDiagnostic,
} from "@codemirror/lint";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import type { Diagnostic } from "../sim/gcode";

const gcode = StreamLanguage.define<{ inComment: boolean }>({
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo(")")) {
        stream.next();
        state.inComment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.eat("(")) {
      state.inComment = true;
      return "comment";
    }
    if (stream.eat(";")) {
      stream.skipToEnd();
      return "comment";
    }
    const m = stream.match(
      /^([A-Za-z])\s*[+-]?(\d+\.?\d*|\.\d+)/,
    ) as RegExpMatchArray | null;
    if (m) {
      const l = m[1].toUpperCase();
      if (l === "G") return "keyword";
      if (l === "M") return "atom";
      if ("XYZ".includes(l)) return "variableName";
      if ("IJKRQP".includes(l)) return "number";
      if ("FST".includes(l)) return "typeName";
      if (l === "N") return "meta";
      return null;
    }
    stream.next();
    return "invalid";
  },
  languageData: { commentTokens: { line: ";" } },
});

const highlight = HighlightStyle.define([
  { tag: tags.comment, color: "#6f7b86", fontStyle: "italic" },
  { tag: tags.keyword, color: "#7cc7ff", fontWeight: "600" },
  { tag: tags.atom, color: "#f2a65a", fontWeight: "600" },
  { tag: tags.variableName, color: "#e8eaed" },
  { tag: tags.number, color: "#b8a3f5" },
  { tag: tags.typeName, color: "#8fd694" },
  { tag: tags.meta, color: "#6f7b86" },
  { tag: tags.invalid, color: "#ff6b6b", textDecoration: "underline wavy" },
]);

export type Mark = { line: number; kind: "run" | "alarm" } | null;
const setMark = StateEffect.define<Mark>();
const runLine = Decoration.line({ class: "cm-run-line" });
const alarmLine = Decoration.line({ class: "cm-alarm-line" });
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMark)) continue;
      const m = e.value;
      if (!m || m.line < 1 || m.line > tr.state.doc.lines)
        return Decoration.none;
      const line = tr.state.doc.line(m.line);
      deco = Decoration.set([
        (m.kind === "run" ? runLine : alarmLine).range(line.from),
      ]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--panel)",
      color: "var(--text)",
    },
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      fontSize: "13px",
      lineHeight: "1.6",
    },
    ".cm-gutters": {
      backgroundColor: "var(--panel)",
      color: "#56616b",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "#ffffff08" },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "#9aa5af",
    },
    ".cm-cursor": { borderLeftColor: "#7cc7ff" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#2b4a66 !important",
    },
    ".cm-run-line": {
      backgroundColor: "#38d6e824",
      boxShadow: "inset 3px 0 #38d6e8",
    },
    ".cm-alarm-line": {
      backgroundColor: "#e0524f30",
      boxShadow: "inset 3px 0 #e0524f",
    },
  },
  { dark: true },
);

interface Props {
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  diagnostics: Diagnostic[];
  mark: Mark;
}

export function Editor({
  value,
  onChange,
  readOnly,
  diagnostics,
  mark,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const ro = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const extensions: Extension[] = [
      lineNumbers(),
      EditorView.lineWrapping,
      history(),
      highlightActiveLine(),
      gcode,
      syntaxHighlighting(highlight),
      lintGutter(),
      markField,
      theme,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      ro.current.of(EditorState.readOnly.of(readOnly)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
    ];
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions }),
    });
    view.current = v;
    return () => v.destroy();
    // The editor owns its document after creation; see the sync effect below.
  }, []);

  useEffect(() => {
    const v = view.current!;
    if (v.state.doc.toString() !== value)
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
      });
  }, [value]);

  useEffect(() => {
    view.current!.dispatch({
      effects: ro.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const v = view.current!;
    const doc = v.state.doc;
    const cm: CmDiagnostic[] = diagnostics
      .filter((d) => d.line >= 1 && d.line <= doc.lines)
      .map((d) => {
        const line = doc.line(d.line);
        return {
          from: line.from,
          to: line.to,
          severity: d.severity,
          message: d.message,
        };
      });
    v.dispatch(setDiagnostics(v.state, cm));
  }, [diagnostics]);

  useEffect(() => {
    const v = view.current!;
    v.dispatch({ effects: setMark.of(mark) });
    if (mark && mark.line <= v.state.doc.lines) {
      const pos = v.state.doc.line(mark.line).from;
      v.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: "nearest", yMargin: 48 }),
      });
    }
  }, [mark?.line, mark?.kind]);

  return <div className="editor" ref={host} />;
}
