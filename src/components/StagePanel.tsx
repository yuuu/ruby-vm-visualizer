import type { Insn, Iseq } from "../yarv/iseq";
import { CATEGORY_LABEL } from "../yarv/insns";
import { decodeOperands, pad4 } from "../yarv/disasm";
import type { StepInfo, VM } from "../yarv/vm";
import { Panel, ValueChip } from "./common";
import { useLang, useT } from "../i18n";

export function StagePanel(props: { vm: VM; iseqs: Iseq[]; last: StepInfo | null; playing: boolean; speed: number }) {
  const { vm, last, iseqs } = props;
  const t = useT();
  const lang = useLang();
  const top = vm.frames[vm.frames.length - 1];
  let insn: Insn | undefined;
  let iseq: Iseq | undefined;
  let pending = false;
  if (last) {
    insn = last.insn;
    iseq = iseqs[last.iseqIndex];
  } else if (top?.iseq) {
    iseq = top.iseq;
    insn = top.iseq.byPc.get(top.pc);
    pending = true;
  }
  const dur = props.playing ? Math.min(900, Math.max(160, 1000 / props.speed - 60)) : 900;

  if (!insn || !iseq) {
    return (
      <Panel title={t("フェッチ → デコード → 実行", "Fetch → Decode → Execute")} className="stage-panel">
        <p className="muted">{t("プログラムが終了しました。", "The program has finished.")}</p>
      </Panel>
    );
  }
  const ops = decodeOperands(insn, iseq, iseqs, lang);
  const { def } = insn;
  return (
    <Panel
      title={t("フェッチ → デコード → 実行", "Fetch → Decode → Execute")}
      sub={pending ? t("次に実行する命令", "Next instruction to run") : t(`ステップ ${last!.index + 1} で実行した命令`, `Instruction run at step ${last!.index + 1}`)}
      className="stage-panel"
    >
      <div className={`stages ${pending ? "pending" : "run"}`} key={last ? last.index : -1} style={{ ["--dur" as string]: `${dur}ms` }}>
        <div className="stage s1">
          <div className="stage-label">
            <span className="stage-no">1</span>
            {t("フェッチ", "Fetch")}
          </div>
          <div className="stage-body">
            <div className="fetch-line">
              {lang === "en" ? (
                <>
                  Read {insn.len} word{insn.len > 1 ? "s" : ""} from <code>pc = {pad4(insn.pc)}</code>
                </>
              ) : (
                <>
                  <code>pc = {pad4(insn.pc)}</code> から命令列を {insn.len} 語読み出す
                </>
              )}
            </div>
            <div className="wordbox">
              <div className="word w-insn">
                <span className="word-val">{insn.name}</span>
                <span className="word-label">{t("命令", "insn")}</span>
              </div>
              {ops.map((o, i) => (
                <div key={i} className="word w-operand">
                  <span className="word-val">{o.text.length > 26 ? o.text.slice(0, 25) + "…" : o.text}</span>
                  <span className="word-label">{o.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="stage-arrow" aria-hidden>
          →
        </div>
        <div className="stage s2">
          <div className="stage-label">
            <span className="stage-no">2</span>
            {t("デコード", "Decode")}
          </div>
          <div className="stage-body">
            <div className="decode-op">
              <span className={`opname cat-${def.category}`}>{insn.name}</span>
              <span className="chip">{t(...CATEGORY_LABEL[def.category])}</span>
            </div>
            {ops.length > 0 && (
              <div className="decode-operands">
                {ops.map((o, i) => (
                  <span key={i} className="operand">
                    {o.name} = {o.text}
                  </span>
                ))}
              </div>
            )}
            <div className="stack-effect" title={t("insns.def に書かれた、スタックから取り出す値と積む値", "Values popped from and pushed to the stack, as written in insns.def")}>
              <span className="se-label">{t("スタック", "stack")}</span>
              <span className="se-pop">{def.pop.length ? def.pop.join(" ") : t("なし", "none")}</span>
              <span className="se-arrow">⇒</span>
              <span className="se-push">{def.push.length ? def.push.join(" ") : t("なし", "none")}</span>
            </div>
          </div>
        </div>
        <div className="stage-arrow" aria-hidden>
          →
        </div>
        <div className="stage s3">
          <div className="stage-label">
            <span className="stage-no">3</span>
            {t("実行", "Execute")}
          </div>
          <div className="stage-body">
            <p className="op-ja">{t(def.doc, def.docEn)}</p>
            {pending ? (
              <p className="exec-desc muted">{t("「1つ進める」を押すと、この命令を実行します。", "Press \"Step\" to run this instruction.")}</p>
            ) : (
              <>
                <p className="exec-desc">{last!.desc}</p>
                {(last!.popped.length > 0 || last!.pushed.length > 0) && (
                  <div className="popush">
                    {last!.popped.length > 0 && (
                      <span className="pp pp-pop">
                        <b>pop</b>
                        {last!.popped.map((v, i) => (
                          <ValueChip key={i} vm={vm} v={v} max={18} />
                        ))}
                      </span>
                    )}
                    {last!.pushed.length > 0 && (
                      <span className="pp pp-push">
                        <b>push</b>
                        {last!.pushed.map((v, i) => (
                          <ValueChip key={i} vm={vm} v={v} max={18} />
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
            {last?.event && !pending && <span className={`event ev-${last.event.type}`}>{last.event.text}</span>}
          </div>
        </div>
      </div>
    </Panel>
  );
}
