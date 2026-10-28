import { useEffect, useRef } from "react";
import type { Iseq } from "../yarv/iseq";
import { iseqTypeLabel, localRoles, pad4 } from "../yarv/disasm";
import { useLang, useT } from "../i18n";
import type { Frame, VM } from "../yarv/vm";
import { Panel, ValueChip } from "./common";
import { frameColor } from "./StackPanel";

const KIND_LABEL: Record<string, string> = {
  top: "TOP",
  method: "METHOD",
  block: "BLOCK",
  class: "CLASS",
  rescue: "RESCUE",
  ensure: "ENSURE",
  cfunc: "CFUNC",
};

export function ControlFramePanel(props: { vm: VM; selectedId: number | null; onSelect: (f: Frame) => void }) {
  const { vm } = props;
  const frames = vm.frames.map((f, d) => ({ f, d })).reverse();
  const t = useT();
  return (
    <Panel title={t("制御フレーム (cfp)", "Control frames (cfp)")} sub={t(`${vm.frames.length} フレーム`, `${vm.frames.length} frame${vm.frames.length === 1 ? "" : "s"}`)} className="callstack-panel">
      {frames.length === 0 && <p className="muted">{t("フレームはありません (実行終了)", "No frames (finished)")}</p>}
      <ol className="frames">
        {frames.map(({ f, d }, i) => (
          <li key={f.id}>
            <button
              className={`frame ${props.selectedId === f.id || (props.selectedId === null && i === 0) ? "sel" : ""}`}
              style={{ ["--c" as string]: frameColor(d) }}
              onClick={() => props.onSelect(f)}
            >
              <span className="frame-label">{f.label}</span>
              <span className="frame-meta">
                <span className={`kind kind-${f.kind}`}>{KIND_LABEL[f.kind]}</span>
                {f.lambda && <span className="kind kind-lambda">LAMBDA</span>}
                {f.iseq ? <span>pc {pad4(f.pc)}</span> : null}
                <span>sp {f.sp}</span>
                <span>ep {f.ep}</span>
                {f.env?.heap && <span className="badge-heap">{t("env はヒープ", "env on heap")}</span>}
              </span>
              <span className="frame-self">
                self = <ValueChip vm={vm} v={f.self} max={28} />
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="hint">
        {t(
          "上が実行中のフレーム。CRuby はこの「制御フレーム」の列を、値のスタックとは別に持っています。",
          "The top one is the running frame. CRuby keeps this list of control frames separately from the value stack.",
        )}
      </p>
    </Panel>
  );
}

export function OutputPanel({ vm, version }: { vm: VM; version: number }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [version]);
  const t = useT();
  const status = vm.halted ? (vm.uncaught ? t("例外で終了", "Ended with an exception") : t("終了", "Finished")) : t(`${vm.steps} ステップ実行`, `${vm.steps} steps`);
  return (
    <Panel title={t("標準出力", "Standard output")} sub={status} className="output-panel">
      <pre className="console" ref={ref}>
        {vm.output.length === 0 && <span className="muted">{t("(まだ出力はありません)", "(no output yet)")}</span>}
        {vm.output.map((o, i) => (
          <span key={i} className={o.kind === "err" ? "err" : ""}>
            {o.text}
          </span>
        ))}
      </pre>
    </Panel>
  );
}

export function LocalTablePanel({ iseq }: { iseq: Iseq }) {
  const lang = useLang();
  const t = useT();
  const roles = localRoles(iseq, lang);
  return (
    <Panel
      title={t("ローカル変数表 (local table)", "Local table")}
      sub={t(`${iseqTypeLabel(iseq.type, lang)}「${iseq.label}」`, `${iseqTypeLabel(iseq.type, lang)} "${iseq.label}"`)}
      className="pool-panel"
    >
      {roles.length === 0 ? (
        <p className="muted small">{t("ローカル変数はありません", "No local variables")}</p>
      ) : (
        <ul className="kv">
          {roles.map((r, i) => (
            <li key={i}>
              <span className="k" title={t("ep からの距離 (getlocal のオペランド)", "distance from ep (the getlocal operand)")}>EP-{iseq.localSize - i + 2}</span>
              <span className="v">
                <b>{r.name}</b> <small className="muted">{r.role}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        {t(
          "ローカル変数は ep (環境ポインタ) からの距離で指定されます。env データが 3 つあるので、最後の変数が EP-3 になります。",
          "Local variables are addressed by their distance from ep (the environment pointer). There are 3 env data slots, so the last variable is EP-3.",
        )}
      </p>
    </Panel>
  );
}

export function VarsPanel({ vm }: { vm: VM }) {
  const g = [...vm.globals.entries()];
  // Only user-defined constants (excluding builtin classes)
  const t = useT();
  const user = [...vm.object.consts.entries()].filter(([k]) => !vm.builtinConsts.has(k));
  if (g.length === 0 && user.length === 0) return null;
  return (
    <Panel title={t("グローバル変数・定数", "Globals & constants")} className="vars-panel">
      <ul className="kv">
        {g.map(([k, v]) => (
          <li key={k}>
            <span className="k">{k}</span>
            <ValueChip vm={vm} v={v} max={30} />
          </li>
        ))}
        {user.map(([k, v]) => (
          <li key={k}>
            <span className="k">{k}</span>
            <ValueChip vm={vm} v={v} max={30} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
