import { useEffect, useRef, useState } from "react";
import type { Iseq } from "../yarv/iseq";
import { iseqTypeLabel, operandTokens, pad4 } from "../yarv/disasm";
import { useLang, useT } from "../i18n";
import type { StepInfo, VM } from "../yarv/vm";
import { Panel } from "./common";

function depthOf(iseqs: Iseq[], s: Iseq) {
  let d = 0;
  for (let p = s.parent; p !== null; p = iseqs[p].parent) d++;
  return d;
}

export function IseqTabs(props: { iseqs: Iseq[]; shown: number; active: Set<number>; current: number | null; onSelect: (i: number) => void }) {
  const lang = useLang();
  const t = useT();
  return (
    <div className="irep-tabs" role="tablist" aria-label={t("iseq 一覧", "iseq list")}>
      {props.iseqs.map((s) => (
        <button
          key={s.index}
          role="tab"
          aria-selected={s.index === props.shown}
          className={`irep-tab ${s.index === props.shown ? "sel" : ""} ${props.active.has(s.index) ? "active" : ""} ${s.index === props.current ? "cur" : ""}`}
          style={{ marginLeft: Math.min(depthOf(props.iseqs, s), 4) * 10 }}
          onClick={() => props.onSelect(s.index)}
          title={t(
            `${iseqTypeLabel(s.type, lang)} · ローカル変数 ${s.localSize} 個 · stack_max ${s.stackMax} · ${s.size} 語`,
            `${iseqTypeLabel(s.type, lang)} · ${s.localSize} local variables · stack_max ${s.stackMax} · ${s.size} words`,
          )}
        >
          <span className="irep-no">{iseqTypeLabel(s.type, lang)}</span> {s.label}
        </button>
      ))}
    </div>
  );
}

export function IseqPanel(props: {
  vm: VM;
  iseqs: Iseq[];
  shown: number;
  follow: boolean;
  setFollow: (b: boolean) => void;
  onSelect: (i: number) => void;
  last: StepInfo | null;
  breakpoints: Set<string>;
  toggleBreakpoint: (iseq: number, pc: number) => void;
}) {
  const { vm, iseqs, shown, last } = props;
  const lang = useLang();
  const t = useT();
  const iseq = iseqs[shown];
  const [hover, setHover] = useState<number | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const top = vm.frames[vm.frames.length - 1];
  const curPc = top && top.iseq === iseq ? top.pc : null;
  const suspended = new Set<number>();
  vm.frames.forEach((f, i) => {
    if (i < vm.frames.length - 1 && f.iseq === iseq) suspended.add(f.pc);
  });
  const active = new Set(vm.frames.filter((f) => f.iseq).map((f) => f.iseq!.index));
  const lastPc = last && last.iseqIndex === shown ? last.insn.pc : null;
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || curPc === null) return;
    const row = body.querySelector<HTMLElement>(`[data-pc="${curPc}"]`);
    if (!row) return;
    const t = row.offsetTop - body.offsetTop;
    if (t < body.scrollTop + 24 || t > body.scrollTop + body.clientHeight - 48) {
      body.scrollTo({ top: t - body.clientHeight / 3, behavior: "smooth" });
    }
  }, [curPc, shown]);

  return (
    <Panel
      title={t("命令列 (iseq)", "Instruction sequence (iseq)")}
      sub={t(
        `${iseqTypeLabel(iseq.type, lang)}「${iseq.label}」 · ${iseq.size} 語 · stack_max ${iseq.stackMax}`,
        `${iseqTypeLabel(iseq.type, lang)} "${iseq.label}" · ${iseq.size} words · stack_max ${iseq.stackMax}`,
      )}
      className="iseq-panel"
      actions={
        <label className="toggle">
          <input type="checkbox" checked={props.follow} onChange={(e) => props.setFollow(e.target.checked)} />
          {t("実行中の iseq を追う", "Follow the running iseq")}
        </label>
      }
    >
      <IseqTabs iseqs={iseqs} shown={shown} active={active} current={top?.iseq?.index ?? null} onSelect={props.onSelect} />
      <div className="iseq-head" aria-hidden>
        <span />
        <span>pc</span>
        <span>{t("語", "words")}</span>
        <span>{t("命令", "instruction")}</span>
        <span>{t("オペランド", "operands")}</span>
        <span>{t("行", "line")}</span>
      </div>
      <div className="iseq" ref={bodyRef}>
        {iseq.insns.map((insn) => {
          const isCur = insn.pc === curPc;
          const bp = props.breakpoints.has(`${iseq.index}:${insn.pc}`);
          const landed = last?.jumped && last.iseqIndex === shown && isCur;
          const inRange = range && insn.pc >= range[0] && insn.pc < range[1];
          return (
            <div
              key={insn.pc}
              data-pc={insn.pc}
              className={`insn cat-${insn.def.category} ${isCur ? "cur" : ""} ${insn.pc === lastPc ? "last" : ""} ${landed ? "landed" : ""} ${hover === insn.pc ? "hover-target" : ""} ${inRange ? "in-range" : ""}`}
            >
              <button
                className={`bp ${bp ? "on" : ""}`}
                onClick={() => props.toggleBreakpoint(iseq.index, insn.pc)}
                aria-label={t(`${insn.pc} にブレークポイント`, `Breakpoint at ${insn.pc}`)}
                title={t("クリックでブレークポイント", "Click to toggle a breakpoint")}
              />
              <span className="addr">
                {isCur ? <span className="pc-mark">pc▶</span> : suspended.has(insn.pc) ? <span className="ret-mark" title={t("呼び出し元の戻り先", "where the caller resumes")}>↩</span> : null}
                {pad4(insn.pc)}
              </span>
              <span className="words" title={t(`命令 1 語 + オペランド ${insn.ops.length} 語`, `1 instruction word + ${insn.ops.length} operand word(s)`)}>
                {Array.from({ length: insn.len }, (_, i) => (
                  <i key={i} className={i === 0 ? "w-op" : "w-arg"} />
                ))}
              </span>
              <span className="opname">{insn.name}</span>
              <span className="operands">
                {operandTokens(insn, iseq, iseqs).map((t, i) => (
                  <span
                    key={i}
                    title={t.title}
                    className={`tok tok-${t.kind}`}
                    onMouseEnter={t.kind === "label" ? () => setHover(t.value!) : undefined}
                    onMouseLeave={t.kind === "label" ? () => setHover(null) : undefined}
                    onClick={t.kind === "iseq" ? () => props.onSelect(t.value!) : undefined}
                  >
                    {t.kind === "label" ? (t.value! <= insn.pc ? "↑" : "↓") : ""}
                    {t.text}
                  </span>
                ))}
              </span>
              <span className="line">{insn.events.includes("LINE") ? insn.line : ""}</span>
            </div>
          );
        })}
      </div>
      {iseq.catchTable.length > 0 && (
        <div className="catch-table">
          <h4>{t("例外ハンドラ表 (catch table)", "Catch table")}</h4>
          <table>
            <thead>
              <tr>
                <th>{t("種類", "type")}</th>
                <th>{t("範囲", "range")}</th>
                <th>{t("続き", "cont")}</th>
                <th>sp</th>
                <th>{t("実行する iseq", "iseq to run")}</th>
              </tr>
            </thead>
            <tbody>
              {iseq.catchTable.map((c, i) => (
                <tr key={i} onMouseEnter={() => setRange([c.start, c.end])} onMouseLeave={() => setRange(null)}>
                  <td>
                    <span className={`ct ct-${c.type}`}>{c.type}</span>
                  </td>
                  <td>
                    {pad4(c.start)}〜{pad4(c.end)}
                  </td>
                  <td>{pad4(c.cont)}</td>
                  <td>{c.sp}</td>
                  <td>
                    {c.iseq !== null ? (
                      <button className="link" onClick={() => props.onSelect(c.iseq!)}>
                        {iseqs[c.iseq].label}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            {t(
              "行にマウスを乗せると、その範囲の命令が強調されます。例外や break が起きたとき、VM はこの表で行き先を探します。",
              "Hover over a row to highlight the instructions in its range. When an exception or break happens, the VM looks up this table to find where to go.",
            )}
          </p>
        </div>
      )}
    </Panel>
  );
}
