import { useEffect, useRef, useState } from "react";
import type { CompileState } from "../useSimulator";
import { Icon, Panel } from "./common";
import { useT } from "../i18n";

/**
 * Shows and edits the Ruby source. While running, the current line is highlighted; in edit mode
 * the code can be rewritten and recompiled with ruby.wasm.
 */
export function SourcePanel(props: {
  source: string;
  line: number | null;
  compileState: CompileState;
  onCompile: (src: string) => Promise<boolean>;
  editing: boolean;
  setEditing: (b: boolean) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(props.source);
  const ref = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!props.editing) setDraft(props.source);
  }, [props.source, props.editing]);

  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(".cur");
    const box = ref.current;
    if (el && box) {
      const top = el.offsetTop - box.offsetTop;
      if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 30) box.scrollTo({ top: top - box.clientHeight / 3, behavior: "smooth" });
    }
  }, [props.line]);

  const busy = props.compileState.status !== "idle";
  const status =
    props.compileState.status === "loading"
      ? `${t("ruby.wasm を読み込み中…", "Loading ruby.wasm…")} ${props.compileState.total ? Math.round((props.compileState.loaded / props.compileState.total) * 100) + "%" : `${(props.compileState.loaded / 1e6).toFixed(1)} MB`}`
      : props.compileState.status === "compiling"
        ? t("コンパイル中…", "Compiling…")
        : null;

  const run = async () => {
    if (await props.onCompile(draft)) props.setEditing(false);
  };

  if (props.editing) {
    return (
      <Panel
        title={t("Ruby ソース (編集中)", "Ruby source (editing)")}
        sub={status ?? t("Ctrl+Enter でコンパイル", "Ctrl+Enter to compile")}
        className="source-panel editing"
        actions={
          <>
            <button className="btn ghost small" onClick={() => props.setEditing(false)} disabled={busy}>
              {t("やめる", "Cancel")}
            </button>
            <button className="btn primary small" onClick={run} disabled={busy}>
              <Icon name="run" /> {t("コンパイルして実行", "Compile & run")}
            </button>
          </>
        }
      >
        <textarea
          className="editor"
          value={draft}
          spellCheck={false}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              run();
            } else if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              const next = draft.slice(0, a) + "  " + draft.slice(b);
              setDraft(next);
              requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
            }
          }}
          aria-label={t("Ruby のソースコード", "Ruby source code")}
        />
        <p className="hint">
          {t(
            "ブラウザの中で本物の CRuby (ruby.wasm, 約 17MB) を動かしてコンパイルします。初回だけ読み込みに少し時間がかかります。",
            "The code is compiled by the real CRuby running in your browser (ruby.wasm, about 17MB). Loading takes a moment the first time only.",
          )}
        </p>
      </Panel>
    );
  }

  const lines = props.source.replace(/\n$/, "").split("\n");
  return (
    <Panel
      title={t("Ruby ソース", "Ruby source")}
      sub={props.line ? t(`${props.line} 行目を実行中`, `Running line ${props.line}`) : ""}
      className="source-panel"
      actions={
        <button className="btn ghost small" onClick={() => props.setEditing(true)}>
          <Icon name="edit" /> {t("書き換える", "Edit")}
        </button>
      }
    >
      <ol className="source" ref={ref}>
        {lines.map((l, i) => (
          <li key={i} className={props.line === i + 1 ? "cur" : ""}>
            <span className="ln">{i + 1}</span>
            <code>{l || " "}</code>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
