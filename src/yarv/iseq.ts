// Types for the JSON written by dump_iseq.rb, and code that turns it into a shape convenient for the VM.
// Based on the contents of RubyVM::InstructionSequence#to_a.
import { INSNS, InsnDef } from "./insns";

export type Operand =
  | { t: "nil" }
  | { t: "true" }
  | { t: "false" }
  | { t: "int"; v: string }
  | { t: "float"; v: string }
  | { t: "sym"; v: string }
  | { t: "str"; v: string }
  | { t: "range"; b: Operand; e: Operand; excl: boolean }
  | { t: "regexp"; v: string; o: number }
  | { t: "const"; v: string }
  | { t: "hash"; v: [Operand, Operand][] }
  | { t: "array"; v: Operand[] }
  | { t: "iseq"; i: number }
  | { t: "label"; pc: number }
  | { t: "cdhash"; v: [Operand, number][] }
  | { t: "cd"; mid: string | null; flag: number; argc: number; kw?: string[] }
  | { t: "other"; v: string };

export type CallData = Extract<Operand, { t: "cd" }>;

export interface Insn {
  pc: number;
  name: string;
  ops: Operand[];
  line: number;
  events: string[];
  /** Length of the instruction (1 instruction word + the number of operand words) */
  len: number;
  def: InsnDef;
}

export interface CatchEntry {
  type: "rescue" | "ensure" | "retry" | "break" | "redo" | "next";
  iseq: number | null;
  start: number;
  end: number;
  cont: number;
  sp: number;
}

export interface KeywordParam {
  name: string;
  required: boolean;
  static?: boolean;
  default?: Operand | null;
}

export interface Params {
  lead_num?: number;
  opt?: number[];
  rest_start?: number;
  post_start?: number;
  post_num?: number;
  block_start?: number;
  kwbits?: number;
  keyword?: KeywordParam[];
  kwrest?: number;
  ambiguous_param0?: boolean;
  accepts_no_kwarg?: boolean;
  use_block?: boolean;
  forwardable?: boolean;
}

export type IseqType = "top" | "main" | "method" | "block" | "class" | "rescue" | "ensure" | "eval" | "plain";

export interface Iseq {
  index: number;
  type: IseqType;
  label: string;
  parent: number | null;
  firstLine: number;
  localTable: string[];
  localSize: number;
  argSize: number;
  stackMax: number;
  codeLocation: [number, number, number, number];
  params: Params;
  catchTable: CatchEntry[];
  insns: Insn[];
  size: number;
  /** pc → instruction */
  byPc: Map<number, Insn>;
}

export interface Program {
  ruby: string;
  description: string;
  iseqs: Iseq[];
  root: Iseq;
}

export class CompileError extends Error {}

export function loadDump(json: string | object): Program {
  const d: any = typeof json === "string" ? JSON.parse(json) : json;
  if (d.error) throw new CompileError(d.error);
  const iseqs: Iseq[] = d.iseqs.map((raw: any) => {
    const insns: Insn[] = raw.insns.map((i: any) => {
      const def = INSNS[i.name];
      if (!def) throw new CompileError(`unsupported instruction: ${i.name}`);
      return { ...i, len: 1 + i.ops.length, def };
    });
    return { ...raw, insns, byPc: new Map(insns.map((i) => [i.pc, i])) } as Iseq;
  });
  return { ruby: d.ruby, description: d.description, iseqs, root: iseqs[0] };
}

/** Turns a local variable index (offset from ep) into the variable name */
export function localName(iseq: Iseq, idx: number): string {
  const i = iseq.localSize - (idx - 3) - 1;
  return iseq.localTable[i] ?? "?";
}

/** Follows the parent iseq (the parent of a block) level times */
export function outerIseq(iseqs: Iseq[], iseq: Iseq, level: number): Iseq {
  let s = iseq;
  for (let i = 0; i < level && s.parent !== null; i++) s = iseqs[s.parent];
  return s;
}

export const CALL_FLAGS: [number, string][] = [
  [0x01, "ARGS_SPLAT"],
  [0x02, "ARGS_BLOCKARG"],
  [0x04, "FCALL"],
  [0x08, "VCALL"],
  [0x10, "ARGS_SIMPLE"],
  [0x20, "KWARG"],
  [0x40, "KW_SPLAT"],
  [0x80, "TAILCALL"],
  [0x100, "SUPER"],
  [0x200, "ZSUPER"],
  [0x400, "OPT_SEND"],
  [0x800, "KW_SPLAT_MUT"],
  [0x1000, "ARGS_SPLAT_MUT"],
  [0x2000, "FORWARDING"],
];

export const VM_CALL = {
  ARGS_SPLAT: 0x01,
  ARGS_BLOCKARG: 0x02,
  FCALL: 0x04,
  VCALL: 0x08,
  ARGS_SIMPLE: 0x10,
  KWARG: 0x20,
  KW_SPLAT: 0x40,
  SUPER: 0x100,
  ZSUPER: 0x200,
  FORWARDING: 0x2000,
};

export function callFlagNames(flag: number): string[] {
  return CALL_FLAGS.filter(([b]) => flag & b).map(([, n]) => n);
}
