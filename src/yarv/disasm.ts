// Display helpers for instructions (close to the notation of RubyVM::InstructionSequence#disasm)
import type { CallData, Insn, Iseq, Operand } from "./iseq";
import { callFlagNames, localName, outerIseq } from "./iseq";
import { pick, type Lang } from "../i18n";

export interface Token {
  text: string;
  kind: "num" | "local" | "lit" | "sym" | "label" | "iseq" | "cd" | "plain";
  /** For a label, the target pc; for an iseq, the iseq index */
  value?: number;
  title?: string;
}

export function pad4(n: number) {
  return String(n).padStart(4, "0");
}

export function literalText(o: Operand, max = 40): string {
  const s = literalFull(o);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function literalFull(o: Operand): string {
  switch (o.t) {
    case "nil":
    case "true":
    case "false":
      return o.t;
    case "int":
      return o.v;
    case "float":
      return o.v;
    case "sym":
      return ":" + o.v;
    case "str":
      return JSON.stringify(o.v);
    case "range":
      return `${o.b.t === "nil" ? "" : literalFull(o.b)}${o.excl ? "..." : ".."}${o.e.t === "nil" ? "" : literalFull(o.e)}`;
    case "regexp":
      return `/${o.v}/`;
    case "const":
      return o.v;
    case "array":
      return "[" + o.v.map(literalFull).join(", ") + "]";
    case "hash":
      return "{" + o.v.map(([k, v]) => (k.t === "sym" ? `${k.v}: ${literalFull(v)}` : `${literalFull(k)} => ${literalFull(v)}`)).join(", ") + "}";
    case "iseq":
      return `iseq #${o.i}`;
    case "label":
      return pad4(o.pc);
    case "cd":
      return calldataText(o);
    case "cdhash":
      return "{" + o.v.map(([k, pc]) => `${literalFull(k)} => ${pad4(pc)}`).join(", ") + "}";
    case "other":
      return o.v;
  }
}

export function calldataText(cd: CallData): string {
  const parts: string[] = [];
  if (cd.mid) parts.push(`mid:${cd.mid}`);
  parts.push(`argc:${cd.argc}`);
  if (cd.kw) parts.push(`kw:[${cd.kw.join(", ")}]`);
  const flags = callFlagNames(cd.flag);
  if (flags.length) parts.push(flags.join("|"));
  return `<calldata!${parts.join(", ")}>`;
}

/** Turns an instruction's operands into display tokens */
export function operandTokens(insn: Insn, iseq: Iseq, iseqs: Iseq[]): Token[] {
  const { name, ops } = insn;
  const n = (o: Operand) => Number((o as any).v);
  const local = (idx: number, level: number): Token => {
    const s = outerIseq(iseqs, iseq, level);
    return { text: `${localName(s, idx)}@${s.localSize - (idx - 3) - 1}`, kind: "local", title: `EP-${idx} (level ${level})` };
  };
  if (name === "getlocal" || name === "setlocal" || name === "getblockparam" || name === "setblockparam" || name === "getblockparamproxy") {
    return [local(n(ops[0]), n(ops[1])), { text: `, ${n(ops[1])}`, kind: "num" }];
  }
  if (/^(get|set)local_WC_[01]$/.test(name)) return [local(n(ops[0]), name.endsWith("1") ? 1 : 0)];
  if (name === "checkkeyword") return [{ text: `${n(ops[0])}, ${n(ops[1])}`, kind: "num" }];
  return ops.map((o, i): Token => {
    const sep = i < ops.length - 1 ? ", " : "";
    switch (o.t) {
      case "label":
        return { text: pad4(o.pc) + sep, kind: "label", value: o.pc };
      case "iseq":
        return { text: (iseqs[o.i]?.label ?? `#${o.i}`) + sep, kind: "iseq", value: o.i };
      case "cd":
        return { text: cdShort(o) + sep, kind: "cd", title: calldataText(o) };
      case "sym":
        return { text: ":" + o.v + sep, kind: "sym" };
      case "int":
        return { text: o.v + sep, kind: name.startsWith("put") || name.startsWith("dup") ? "lit" : "num" };
      case "array":
        if (name === "opt_getconstant_path") return { text: o.v.map((x) => (x as any).v).join("::") + sep, kind: "sym" };
        return { text: literalText(o) + sep, kind: "lit" };
      default:
        return { text: literalText(o) + sep, kind: "lit" };
    }
  });
}

/** Short form of a calldata (e.g. :+ argc:1) */
export function cdShort(cd: CallData): string {
  const parts = [cd.mid ? `:${cd.mid}` : "yield", `argc:${cd.argc}`];
  if (cd.kw) parts.push(`kw:${cd.kw.join(",")}`);
  const f = callFlagNames(cd.flag).filter((x) => x !== "ARGS_SIMPLE");
  if (f.length) parts.push(f.join("|"));
  return parts.join(" ");
}

export function jumpTargets(insn: Insn): number[] {
  const out: number[] = [];
  for (const o of insn.ops) {
    if (o.t === "label") out.push(o.pc);
    if (o.t === "cdhash") for (const [, pc] of o.v) out.push(pc);
  }
  return out;
}

/** Operand name/value pairs (for the decode stage) */
export function decodeOperands(insn: Insn, iseq: Iseq, iseqs: Iseq[], lang: Lang): { name: string; text: string }[] {
  const toks = operandTokens(insn, iseq, iseqs);
  const names = insn.def.operands;
  if (/^(get|set)local_WC_[01]$/.test(insn.name)) {
    return [
      { name: "idx", text: `${(insn.ops[0] as any).v} (${toks[0].text})` },
      { name: "level", text: `${insn.name.endsWith("1") ? 1 : 0} ${pick(lang, "(命令名に埋め込み)", "(embedded in the name)")}` },
    ];
  }
  if (["getlocal", "setlocal", "getblockparam", "setblockparam", "getblockparamproxy"].includes(insn.name)) {
    return [
      { name: "idx", text: `${(insn.ops[0] as any).v} (${toks[0].text})` },
      { name: "level", text: String((insn.ops[1] as any).v) },
    ];
  }
  return insn.ops.map((o, i) => ({
    name: names[i] ?? `op${i}`,
    text: o.t === "cd" ? calldataText(o) : o.t === "iseq" ? `${iseqs[o.i]?.label} (iseq #${o.i})` : toks[i]?.text.replace(/, $/, "") ?? literalText(o),
  }));
}

/** The role of each slot in the local table */
export function localRoles(iseq: Iseq, lang: Lang): { name: string; role: string }[] {
  const t = (ja: string, en: string) => pick(lang, ja, en);
  const P = iseq.params;
  const out: { name: string; role: string }[] = [];
  const lead = P.lead_num ?? 0;
  const optNum = P.opt ? P.opt.length - 1 : 0;
  const kws = P.keyword ?? [];
  const kwStart = P.kwbits !== undefined ? P.kwbits - kws.length : -1;
  for (let i = 0; i < iseq.localSize; i++) {
    let role = t("変数", "variable");
    if (i < lead) role = t("引数", "argument");
    else if (i < lead + optNum) role = t("省略可能な引数", "optional argument");
    else if (i === P.rest_start) role = t("*残りの引数", "*rest argument");
    else if (P.post_start !== undefined && i >= P.post_start && i < P.post_start + (P.post_num ?? 0)) role = t("後置引数", "post argument");
    else if (kwStart >= 0 && i >= kwStart && i < kwStart + kws.length) role = t("キーワード引数", "keyword argument");
    else if (i === P.kwbits) role = t("キーワードの指定状況", "which keywords were given");
    else if (i === P.kwrest) role = t("**残りのキーワード", "**rest keywords");
    else if (i === P.block_start) role = t("&ブロック引数", "&block argument");
    else if (iseq.type === "rescue" || iseq.type === "ensure") role = i === 0 ? t("例外 ($!)", "exception ($!)") : "変数";
    out.push({ name: iseq.localTable[i] === "?" ? (i === P.kwbits ? "(kwbits)" : "?") : iseq.localTable[i], role });
  }
  return out;
}

const ISEQ_TYPE_LABEL: Record<string, [string, string]> = {
  top: ["トップレベル", "top level"],
  main: ["メイン", "main"],
  method: ["メソッド", "method"],
  block: ["ブロック", "block"],
  class: ["クラス本体", "class body"],
  rescue: ["rescue 節", "rescue clause"],
  ensure: ["ensure 節", "ensure clause"],
  eval: ["eval", "eval"],
  plain: ["その他", "other"],
};

export function iseqTypeLabel(type: string, lang: Lang): string {
  const l = ISEQ_TYPE_LABEL[type] ?? [type, type];
  return lang === "en" ? l[1] : l[0];
}
