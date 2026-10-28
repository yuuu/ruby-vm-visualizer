import { useEffect, useRef } from "react";
import { localRoles } from "../yarv/disasm";
import type { Frame, Slot, StepInfo, VM } from "../yarv/vm";
import { NIL, Value } from "../yarv/values";
import { Panel, ValueChip } from "./common";
import { pick, useLang, useT, type Lang } from "../i18n";

export function frameColor(depth: number) {
  return `var(--frame-${depth % 6})`;
}

interface Row {
  slot: number;
  frame: Frame | null;
  depth: number;
  kind: "recv" | "local" | "env" | "operand" | "free" | "cfunc";
  label: string;
  role?: string;
  /** Value from the environment after it moved to the heap */
  heap?: Value;
}

/** Works out which frame each slot belongs to and what it is */
function layout(vm: VM, lang: Lang): { rows: Row[]; top: number } {
  const t = (ja: string, en: string) => pick(lang, ja, en);
  const frames = vm.frames;
  const topFrame = frames[frames.length - 1];
  let end = 1;
  for (const f of frames) end = Math.max(end, f.sp);
  // Show a few slots above sp too (popping does not erase the values)
  const shownEnd = end + 3;
  const rows: Row[] = [];
  for (let s = 0; s < shownEnd; s++) rows.push({ slot: s, frame: null, depth: -1, kind: "free", label: "" });
  frames.forEach((f, d) => {
    const set = (s: number, r: Omit<Row, "slot" | "frame" | "depth">) => {
      if (s >= 0 && s < rows.length) rows[s] = { slot: s, frame: f, depth: d, ...r };
    };
    if (f.recvSlot !== null && f.kind !== "cfunc") set(f.recvSlot, { kind: "recv", label: t("レシーバ", "receiver"), role: "self" });
    if (f.iseq && f.env) {
      const roles = localRoles(f.iseq, lang);
      const e = f.env;
      roles.forEach((r, i) => {
        const s = f.localStart + i;
        const idx = e.size - i + 2;
        set(s, { kind: "local", label: r.name, role: r.role, heap: e.heap ? (e.heap[e.size + 2 - idx] ?? NIL) : undefined });
      });
    } else if (f.kind === "cfunc" && f.recvSlot !== null) {
      set(f.recvSlot, { kind: "recv", label: t("レシーバ", "receiver"), role: "self" });
      for (let s = f.recvSlot + 1; s < f.ep - 2; s++) set(s, { kind: "cfunc", label: t("引数", "argument"), role: t("組み込みメソッドの引数", "argument of the builtin method") });
    }
    set(f.ep - 2, { kind: "env", label: "me / cref", role: t("どのメソッドか / 定義先のクラス", "which method / the class to define in") });
    set(f.ep - 1, { kind: "env", label: "specval", role: t("ブロック、または外側の環境 (EP)", "the block, or the outer environment (EP)") });
    set(f.ep, { kind: "env", label: "flags", role: t("フレームの種類", "the frame type") });
    for (let s = f.ep + 1; s < f.sp; s++) set(s, { kind: "operand", label: "", role: t("オペランドスタック", "operand stack") });
  });
  return { rows, top: topFrame ? topFrame.sp : 0 };
}

export function StackPanel(props: { vm: VM; last: StepInfo | null; selectedId: number | null; version: number }) {
  const { vm, last } = props;
  const lang = useLang();
  const t = useT();
  const { rows } = layout(vm, lang);
  const frames = vm.frames;
  const topFrame = frames[frames.length - 1];
  const writes = new Set(last?.writes ?? []);
  const pops = new Set(last?.pops ?? []);
  const pushes = new Set(last?.pushes ?? []);
  const reads = new Set(last?.reads ?? []);
  const boxRef = useRef<HTMLDivElement>(null);

  // Scroll so that the running frame's sp is visible
  useEffect(() => {
    const box = boxRef.current;
    const el = box?.querySelector<HTMLElement>(".srow.sp-here");
    if (!box || !el) return;
    const t = el.offsetTop - box.offsetTop;
    if (t < box.scrollTop + 20 || t > box.scrollTop + box.clientHeight - 60) box.scrollTo({ top: t - box.clientHeight / 3, behavior: "smooth" });
  }, [props.version]);

  const valueOf = (s: Slot): Value | null => (s && s.t !== "envdata" ? s : null);

  return (
    <Panel
      title={t("VM スタック", "VM stack")}
      sub={topFrame ? `sp = ${topFrame.sp} · ep = ${topFrame.ep} · ${frames.length} ${t("フレーム", frames.length === 1 ? "frame" : "frames")}` : t("空", "empty")}
      className="stack-panel"
    >
      <div className="stack-legend">
        {frames.map((f, d) => (
          <span key={f.id} className={`sl ${props.selectedId === f.id ? "sel" : ""}`} style={{ ["--c" as string]: frameColor(d) }}>
            {f.label}
          </span>
        ))}
      </div>
      <div className="srows yarv" ref={boxRef}>
        {rows
          .slice()
          .reverse()
          .map((r) => {
            const s = r.slot;
            const raw = vm.stack[s];
            const isEnv = raw && raw.t === "envdata";
            const v = valueOf(raw);
            const free = r.kind === "free";
            const spHere = topFrame && s === topFrame.sp;
            const epHere = frames.filter((f) => f.ep === s);
            const spOthers = frames.filter((f) => f !== topFrame && f.sp === s);
            const cls = [
              "srow",
              `k-${r.kind}`,
              writes.has(s) && !free ? "written" : "",
              pushes.has(s) && !free ? "pushed" : "",
              pops.has(s) && free ? "popped" : "",
              reads.has(s) ? "read" : "",
              spHere ? "sp-here" : "",
              r.frame && props.selectedId === r.frame.id ? "sel" : "",
            ].join(" ");
            return (
              <div key={`${s}-${writes.has(s) ? last?.index : ""}`} className={cls} style={r.frame ? { ["--c" as string]: frameColor(r.depth) } : undefined}>
                <span className="sidx">{s}</span>
                <span className="sbar" />
                <span className="slabel">
                  {r.kind === "local" ? (
                    <>
                      <b>{r.label}</b>
                      <small>{r.role}</small>
                    </>
                  ) : r.kind === "recv" ? (
                    <>
                      <b>self</b>
                      <small>{t("レシーバ", "receiver")}</small>
                    </>
                  ) : r.kind === "env" ? (
                    <>
                      <b className="envname">{r.label}</b>
                    </>
                  ) : r.kind === "operand" ? (
                    <small>{t("オペランド", "operand")}</small>
                  ) : r.kind === "cfunc" ? (
                    <small>{r.label}</small>
                  ) : (
                    <small className="muted">{t("空き", "free")}</small>
                  )}
                </span>
                <span className="sval">
                  {isEnv ? (
                    <span className="envdata" title={r.role}>
                      {raw.text}
                    </span>
                  ) : r.heap !== undefined ? (
                    <span className="heapval" title={t("この環境は Proc に捕まえられてヒープへ移った。以後はヒープ側を読み書きする", "This environment was captured by a Proc and moved to the heap. From now on the heap copy is read and written")}>
                      <span className="badge-heap">{t("ヒープ", "heap")}</span>
                      <ValueChip vm={vm} v={r.heap} max={26} />
                    </span>
                  ) : v ? (
                    <ValueChip vm={vm} v={v} max={free ? 20 : 32} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </span>
                <span className="sptr">
                  {spHere && <span className="ptr ptr-sp">← sp</span>}
                  {spOthers.map((f) => (
                    <span key={f.id} className="ptr ptr-sp2" title={t(`${f.label} の sp`, `sp of ${f.label}`)}>
                      sp
                    </span>
                  ))}
                  {epHere.map((f) => (
                    <span key={f.id} className="ptr ptr-ep" style={{ ["--c" as string]: frameColor(frames.indexOf(f)) }} title={t(`${f.label} の ep`, `ep of ${f.label}`)}>
                      ep
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
      </div>
      <div className="legend">
        <span className="lg lg-push">{t("積んだ (push)", "pushed")}</span>
        <span className="lg lg-pop">{t("取り出した (pop)", "popped")}</span>
        <span className="lg lg-read">{t("読んだ", "read")}</span>
      </div>
    </Panel>
  );
}
