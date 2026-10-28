// Ruby values handled by the VM. Corresponds to CRuby's VALUE.
import type { Iseq } from "./iseq";

export type Value =
  | NilV
  | TrueV
  | FalseV
  | IntV
  | FloatV
  | SymV
  | StrO
  | AryO
  | HashO
  | RangeO
  | ProcO
  | ObjO
  | ClassO;

export interface NilV { t: "nil" }
export interface TrueV { t: "true" }
export interface FalseV { t: "false" }
export interface IntV { t: "int"; v: bigint }
export interface FloatV { t: "float"; v: number }
export interface SymV { t: "sym"; name: string }

interface HeapBase {
  id: number;
  /** Set for instances with a singleton class or of a user-defined subclass */
  cls?: ClassO;
  ivars?: Map<string, Value>;
  frozen?: boolean;
}

export interface StrO extends HeapBase { t: "str"; s: string }
export interface AryO extends HeapBase { t: "array"; items: Value[] }
export interface HashO extends HeapBase { t: "hash"; map: Map<string, [Value, Value]>; default: Value }
export interface RangeO extends HeapBase { t: "range"; first: Value; last: Value; excl: boolean }
export interface ObjO extends HeapBase { t: "object"; cls: ClassO; ivars: Map<string, Value> }

/**
 * The environment of local variables (the area CRuby's ep points to).
 * While the frame is alive it lives on the VM stack; once captured by a Proc
 * it is moved to the heap (rb_env_t).
 */
export interface Env {
  id: number;
  iseq: Iseq;
  /** Number of local variables (local_table_size) */
  size: number;
  /** Position of ep on the VM stack (the flags slot, the last of the 3 env data slots) */
  ep: number;
  /** Contents after moving to the heap (laid out as [locals..., me/cref, specval, flags]) */
  heap: Value[] | null;
  /** The outer environment (for blocks and rescue clauses). null for a local environment (methods etc.) */
  prev: Env | null;
  /** The block given to a local environment (specval) */
  block: Value;
  frameId: number;
  /** Whether it was captured as a Proc or block (moved to the heap when the frame is popped) */
  captured: boolean;
  /** Whether the block parameter (&blk) has been turned into a Proc (VM_FRAME_FLAG_MODIFIED_BLOCK_PARAM) */
  blockParamSet?: boolean;
  /** The method of the frame that created this environment (for super and __method__) */
  me: Method | null;
  cref: ClassO;
  lambda?: boolean;
}

export type FrameKind = "top" | "method" | "block" | "class" | "rescue" | "ensure" | "cfunc";

export interface ProcO extends HeapBase {
  t: "proc";
  iseq: Iseq | null;
  /** A Proc created natively (Symbol#to_proc, Method, etc.) */
  native?: (vm: any, self: Value, args: Value[], blk: Value) => any;
  env: Env | null;
  self: Value;
  targetClass: ClassO | null;
  lambda: boolean;
  /** A block that was only passed to a method and has not become a Proc object yet */
  isBlock?: boolean;
  /** The original symbol of Symbol#to_proc */
  symbol?: string;
}

export type NativeFn = (vm: any, self: Value, args: Value[], blk: Value, kw: HashO | null) => any;

export interface Method {
  owner: ClassO;
  name: string;
  /** Body of a method defined with def */
  iseq?: Iseq;
  /** Body of a method defined with define_method */
  proc?: ProcO;
  native?: NativeFn;
  visibility?: "public" | "private";
}

export interface ClassO extends HeapBase {
  t: "class";
  name: string;
  superclass: ClassO | null;
  isModule: boolean;
  methods: Map<string, Method>;
  consts: Map<string, Value>;
  ivars: Map<string, Value>;
  cvars: Map<string, Value>;
  includes: ClassO[];
  /** For a singleton class, the object it belongs to */
  attached?: Value;
  singleton?: ClassO;
  outer?: ClassO;
}

export const NIL: NilV = { t: "nil" };
export const TRUE: TrueV = { t: "true" };
export const FALSE: FalseV = { t: "false" };

export const int = (v: bigint | number): IntV => ({ t: "int", v: typeof v === "bigint" ? v : BigInt(Math.trunc(v)) });
export const flo = (v: number): FloatV => ({ t: "float", v });
export const bool = (b: boolean): Value => (b ? TRUE : FALSE);

const symCache = new Map<string, SymV>();
export function sym(name: string): SymV {
  let s = symCache.get(name);
  if (!s) {
    s = { t: "sym", name };
    symCache.set(name, s);
  }
  return s;
}

export function truthy(v: Value): boolean {
  return v.t !== "nil" && v.t !== "false";
}

export function isHeap(v: Value): v is StrO | AryO | HashO | RangeO | ProcO | ObjO | ClassO {
  return "id" in v;
}

/** String representation used as a Hash key (equivalent to eql?) */
export function hashKey(v: Value): string {
  switch (v.t) {
    case "nil":
    case "true":
    case "false":
      return v.t;
    case "int":
      return "i" + v.v;
    case "float":
      return "f" + v.v;
    case "sym":
      return "y" + v.name;
    case "str":
      return "s" + v.s;
    case "array":
      return "a[" + v.items.map(hashKey).join(",") + "]";
    default:
      return "o" + v.id;
  }
}

export function formatFloat(f: number): string {
  if (Number.isNaN(f)) return "NaN";
  if (f === Infinity) return "Infinity";
  if (f === -Infinity) return "-Infinity";
  if (f === 0) return Object.is(f, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(f);
  if (abs >= 1e16 || abs < 1e-4) {
    let [m, e] = f.toExponential().split("e");
    if (!m.includes(".")) m += ".0";
    const sign = e.startsWith("-") ? "-" : "+";
    const digits = e.replace(/^[+-]/, "").padStart(2, "0");
    return `${m}e${sign}${digits}`;
  }
  const s = String(f);
  return s.includes(".") ? s : s + ".0";
}

export function inspectString(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\x1b":
        out += "\\e";
        break;
      case "#":
        out += "#";
        break;
      default: {
        const c = ch.codePointAt(0)!;
        if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).toUpperCase().padStart(2, "0");
        else out += ch;
      }
    }
  }
  return out + '"';
}

const SIMPLE_SYM = /^(?:[A-Za-z_][A-Za-z0-9_]*[?!=]?|\[\]=?|[+\-*\/%<>=!~^&|]+|\+@|-@|<=>|===?|=~|\*\*)$/;
export function inspectSymbol(name: string): string {
  return ":" + (SIMPLE_SYM.test(name) ? name : inspectString(name));
}

/** Builtin type name (class name) */
export function builtinClassName(v: Value): string {
  switch (v.t) {
    case "nil":
      return "NilClass";
    case "true":
      return "TrueClass";
    case "false":
      return "FalseClass";
    case "int":
      return "Integer";
    case "float":
      return "Float";
    case "sym":
      return "Symbol";
    case "str":
      return "String";
    case "array":
      return "Array";
    case "hash":
      return "Hash";
    case "range":
      return "Range";
    case "proc":
      return "Proc";
    case "object":
      return v.cls.name;
    case "class":
      return v.isModule ? "Module" : "Class";
  }
}
