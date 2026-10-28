// A reimplementation of the CRuby VM (YARV: vm_exec.c / vm_insnhelper.c / insns.def) in TypeScript,
// so that it can run one instruction at a time.
//
// YARV is a stack machine. Instructions pop values from the operand stack and push their results.
// The VM stack is a single array, and each frame is laid out as follows.
//
//   [receiver] [locals ...] [me/cref] [specval] [flags] [operand stack ...]
//                                                        ↑ep                       ↑sp
//
// On a method call, the arguments pushed by the caller become the callee's local variables as is
// (no copying). This overlap is reproduced as well.
import type { CallData, CatchEntry, Insn, Iseq, Operand, Program } from "./iseq";
import { VM_CALL, localName } from "./iseq";
import {
  AryO,
  ClassO,
  Env,
  FALSE,
  FrameKind,
  HashO,
  Method,
  NIL,
  ObjO,
  ProcO,
  RangeO,
  StrO,
  TRUE,
  Value,
  bool,
  builtinClassName,
  flo,
  formatFloat,
  hashKey,
  inspectString,
  inspectSymbol,
  int,
  isHeap,
  sym,
  truthy,
} from "./values";
import { installBuiltins } from "./builtins";
import type { Lang } from "../i18n";

export class RubyError extends Error {
  constructor(public exc: ObjO) {
    super("RubyError");
  }
}

/** Unexpected error inside the VM (unsupported instruction, etc.) */
export class VMError extends Error {}

/** Env data on the VM stack (me/cref, specval, flags) */
export interface EnvSlot {
  t: "envdata";
  kind: "me" | "specval" | "flags";
  text: string;
}
export type Slot = Value | EnvSlot | undefined;

/** Control frame (rb_control_frame_t) */
export interface Frame {
  id: number;
  kind: FrameKind;
  iseq: Iseq | null;
  /** Address of the next instruction to run */
  pc: number;
  /** Stack pointer: where the next value is pushed */
  sp: number;
  /** Environment pointer: position of the env data (flags) */
  ep: number;
  env: Env | null;
  self: Value;
  label: string;
  /** Position on the caller's stack where the return value is written */
  retSlot: number;
  /** Start of the local variable area */
  localStart: number;
  /** For a method frame, where the receiver is */
  recvSlot: number | null;
  lambda: boolean;
  me: Method | null;
  gen?: Generator<CallRequest, Value, Value>;
  /** Receives the returned value and does extra work (slow paths such as objtostring) */
  afterReturn?: ((v: Value) => void) | null;
}

export type CallRequest =
  | { type: "send"; recv: Value; mid: string; args: Value[]; blk: Value }
  | { type: "proc"; proc: ProcO; args: Value[]; self?: Value; blk?: Value };

export interface OutputLine {
  text: string;
  kind: "out" | "err";
}

export interface StepInfo {
  index: number;
  frameId: number;
  iseqIndex: number;
  insn: Insn;
  /** Description of what happened (with the actual values) */
  desc: string;
  /** Slots that were popped */
  pops: number[];
  /** Slots that were pushed */
  pushes: number[];
  /** Popped values (in slot order) */
  popped: Value[];
  /** Pushed values (in slot order) */
  pushed: Value[];
  /** Slots that were read (local variables, etc.) */
  reads: number[];
  /** Slots that were written */
  writes: number[];
  spBefore: number;
  jumped: boolean;
  event?: { type: "call" | "return" | "raise" | "rescue" | "halt" | "error" | "escape"; text: string };
}

/** Information carried by the throw instruction and exceptions (vm_throw_data) */
export interface ThrowData {
  state: number;
  val: Value;
  /** The frame to escape to (break / return / retry) */
  escapeId: number | null;
}

export const TAG = { NONE: 0, RETURN: 1, BREAK: 2, NEXT: 3, RETRY: 4, REDO: 5, RAISE: 6, THROW: 7 };
const TAG_NAME: Record<number, string> = { 1: "return", 2: "break", 3: "next", 4: "retry", 5: "redo", 6: "raise", 7: "throw" };

const MAX_STACK = 200000;
const MAX_FRAMES = 3000;

const FRAME_TYPE: Record<FrameKind, string> = {
  top: "TOP",
  method: "METHOD",
  block: "BLOCK",
  class: "CLASS",
  rescue: "RESCUE",
  ensure: "RESCUE",
  cfunc: "CFUNC",
};

export class VM {
  stack: Slot[] = [];
  frames: Frame[] = [];
  globals = new Map<string, Value>();
  classes: Record<string, ClassO> = {} as any;
  output: OutputLine[] = [];
  halted = false;
  result: Value = NIL;
  uncaught: ObjO | null = null;
  steps = 0;
  /** $! (the exception being rescued) */
  errinfo: Value = NIL;
  private nextId = 1;
  private nextFrameId = 1;
  /** Reproducible random numbers (so the same run can be repeated to step back) */
  private seed = 20240607;

  object!: ClassO;
  /** Names of the constants that exist from startup (builtins) */
  builtinConsts!: Set<string>;
  main!: ObjO;
  /** The VM core pushed by putspecialobject 1 (FrozenCore) */
  core!: ObjO;
  /** Record of which slots were read and written while running one instruction */
  private cur: StepInfo | null = null;

  constructor(
    public program: Program,
    public lang: Lang = "ja",
  ) {
    installBuiltins(this);
    this.object = this.classes.Object;
    this.builtinConsts = new Set(this.object.consts.keys());
    this.main = this.newObject(this.object);
    this.main.ivars.set("__main", TRUE);
    this.core = this.newObject(this.classes.__Core);
    this.core.ivars.set("__core", TRUE);
    const root = program.root;
    // Bottom of the stack: self of the top level
    this.stack[0] = this.main;
    this.pushIseqFrame({
      kind: "top",
      iseq: root,
      retSlot: 0,
      localStart: 1,
      recvSlot: 0,
      self: this.main,
      locals: new Array(root.localSize).fill(NIL),
      prev: null,
      block: NIL,
      me: null,
      cref: this.object,
      lambda: false,
      label: "<main>",
      pc: 0,
    });
  }

  /** Picks a description in the current language */
  tr(ja: string, en: string): string {
    return this.lang === "en" ? en : ja;
  }

  // ───────────────────────── Creating values ─────────────────────────

  id() {
    return this.nextId++;
  }
  str(s: string): StrO {
    return { t: "str", s, id: this.id() };
  }
  ary(items: Value[]): AryO {
    return { t: "array", items, id: this.id() };
  }
  hash(pairs: [Value, Value][] = []): HashO {
    const h: HashO = { t: "hash", map: new Map(), default: NIL, id: this.id() };
    for (const [k, v] of pairs) this.hashSet(h, k, v);
    return h;
  }
  hashSet(h: HashO, k: Value, v: Value) {
    // String keys are duplicated and frozen (same as Ruby)
    if (k.t === "str" && !k.frozen) k = { ...k, id: this.id(), frozen: true };
    h.map.set(hashKey(k), [k, v]);
  }
  hashGet(h: HashO, k: Value): Value | undefined {
    return h.map.get(hashKey(k))?.[1];
  }
  range(first: Value, last: Value, excl: boolean): RangeO {
    return { t: "range", first, last, excl, id: this.id() };
  }
  newObject(cls: ClassO): ObjO {
    return { t: "object", cls, ivars: new Map(), id: this.id() };
  }
  newClass(name: string, superclass: ClassO | null, isModule = false, outer?: ClassO): ClassO {
    return {
      t: "class",
      name,
      superclass,
      isModule,
      methods: new Map(),
      consts: new Map(),
      ivars: new Map(),
      cvars: new Map(),
      includes: [],
      id: this.id(),
      outer,
    };
  }
  newProc(iseq: Iseq | null, env: Env | null, self: Value, targetClass: ClassO | null, lambda: boolean): ProcO {
    return { t: "proc", iseq, env, self, targetClass, lambda, id: this.id() };
  }
  random(): number {
    // xorshift32
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 0x100000000;
  }

  makeError(clsName: string, msg: string): ObjO {
    const cls = this.classes[clsName] ?? this.classes.RuntimeError;
    const e = this.newObject(cls);
    e.ivars.set("__mesg", this.str(msg));
    return e;
  }
  error(clsName: string, msg: string): never {
    throw new RubyError(this.makeError(clsName, msg));
  }

  /** Turns a literal embedded in the instruction sequence into a value */
  literal(o: Operand): Value {
    switch (o.t) {
      case "nil":
        return NIL;
      case "true":
        return TRUE;
      case "false":
        return FALSE;
      case "int":
        return int(BigInt(o.v));
      case "float":
        return flo(Number(o.v));
      case "sym":
        return sym(o.v);
      case "str": {
        const s = this.str(o.v);
        s.frozen = true;
        return s;
      }
      case "range":
        return this.range(this.literal(o.b), this.literal(o.e), o.excl);
      case "array": {
        const a = this.ary(o.v.map((x) => this.literal(x)));
        a.frozen = true;
        return a;
      }
      case "hash": {
        const h = this.hash(o.v.map(([k, v]) => [this.literal(k), this.literal(v)]));
        h.frozen = true;
        return h;
      }
      case "const": {
        let c: Value = this.object;
        for (const part of o.v.split("::")) c = (c as ClassO).consts.get(part) ?? this.error("NameError", `uninitialized constant ${o.v}`);
        return c;
      }
      case "regexp":
        this.error("NotImplementedError", this.tr("このビジュアライザは正規表現 (Regexp) に対応していません", "This visualizer does not support regular expressions (Regexp)"));
      default:
        throw new VMError(this.tr(`未対応のリテラルです: ${JSON.stringify(o)}`, `Unsupported literal: ${JSON.stringify(o)}`));
    }
  }

  /** Duplicates a literal (duparray, putstring, etc.) */
  dupValue(v: Value): Value {
    if (v.t === "str") return this.str(v.s);
    if (v.t === "array") return this.ary(v.items.map((x) => this.dupValue(x)));
    if (v.t === "hash") {
      const h = this.hash();
      for (const [k, val] of v.map.values()) this.hashSet(h, k, this.dupValue(val));
      return h;
    }
    return v;
  }

  // ───────────────────────── Classes and methods ─────────────────────────

  singletonClass(v: Value): ClassO {
    if (v.t === "class") {
      if (!v.singleton) {
        const sup = v.superclass ? this.singletonClass(v.superclass) : v.isModule ? this.classes.Module : this.classes.Class;
        const s = this.newClass(`#<Class:${v.name}>`, sup);
        s.attached = v;
        v.singleton = s;
      }
      return v.singleton;
    }
    if (!isHeap(v)) this.error("TypeError", `can't define singleton`);
    const h = v as any;
    if (h.cls?.attached === v) return h.cls;
    const s = this.newClass(`#<Class:${this.inspect(v)}>`, this.classOf(v));
    s.attached = v;
    h.cls = s;
    return s;
  }

  /** The class method lookup starts from, including singleton classes */
  classOf(v: Value): ClassO {
    switch (v.t) {
      case "object":
        return v.cls;
      case "class":
        return this.singletonClass(v);
      default:
        if (isHeap(v) && v.cls) return v.cls;
        return this.classes[builtinClassName(v)];
    }
  }

  /** The object's real class, excluding singleton classes */
  realClassOf(v: Value): ClassO {
    let c: ClassO | null = this.classOf(v);
    while (c && c.attached) c = c.superclass;
    return c ?? this.object;
  }

  ancestors(cls: ClassO): ClassO[] {
    const out: ClassO[] = [];
    const seen = new Set<ClassO>();
    const addModule = (m: ClassO) => {
      if (seen.has(m)) return;
      seen.add(m);
      out.push(m);
      for (let i = m.includes.length - 1; i >= 0; i--) addModule(m.includes[i]);
    };
    for (let c: ClassO | null = cls; c; c = c.superclass) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      for (let i = c.includes.length - 1; i >= 0; i--) addModule(c.includes[i]);
    }
    return out;
  }

  findMethod(cls: ClassO, mid: string, after?: ClassO | null): Method | undefined {
    const anc = this.ancestors(cls);
    let i = 0;
    if (after) {
      const idx = anc.indexOf(after);
      i = idx < 0 ? anc.length : idx + 1;
    }
    for (; i < anc.length; i++) {
      const m = anc[i].methods.get(mid);
      if (m) return m.native || m.proc || m.iseq ? m : undefined; // an undefined method stops the lookup
    }
    return undefined;
  }

  respondTo(v: Value, mid: string) {
    return !!this.findMethod(this.classOf(v), mid);
  }

  isKindOf(v: Value, cls: ClassO): boolean {
    return this.ancestors(this.classOf(v)).includes(cls);
  }

  defineNative(cls: ClassO, name: string, fn: Method["native"]) {
    cls.methods.set(name, { owner: cls, name, native: fn });
  }

  className(c: ClassO): string {
    return c.name;
  }

  // ───────────────────────── String conversion for display (does not call user-defined methods) ─────────────────────────

  inspect(v: Value, depth = 0): string {
    if (depth > 4) return "...";
    switch (v.t) {
      case "nil":
        return "nil";
      case "true":
        return "true";
      case "false":
        return "false";
      case "int":
        return v.v.toString();
      case "float":
        return formatFloat(v.v);
      case "sym":
        return inspectSymbol(v.name);
      case "str":
        return inspectString(v.s);
      case "array":
        return "[" + v.items.map((x) => this.inspect(x, depth + 1)).join(", ") + "]";
      case "hash": {
        if (v.map.size === 0) return "{}";
        const parts = [...v.map.values()].map(([k, val]) => {
          if (k.t === "sym" && /^[A-Za-z_][A-Za-z0-9_]*[?!]?$/.test(k.name)) return `${k.name}: ${this.inspect(val, depth + 1)}`;
          return `${this.inspect(k, depth + 1)} => ${this.inspect(val, depth + 1)}`;
        });
        return "{" + parts.join(", ") + "}";
      }
      case "range":
        return `${v.first.t === "nil" ? "" : this.inspect(v.first, depth + 1)}${v.excl ? "..." : ".."}${v.last.t === "nil" ? "" : this.inspect(v.last, depth + 1)}`;
      case "proc":
        return `#<Proc:0x${v.id.toString(16).padStart(4, "0")}${v.lambda ? " (lambda)" : ""}>`;
      case "class":
        return v.name;
      case "object": {
        if (this.isException(v)) {
          const m = this.excMessage(v);
          return m === v.cls.name ? v.cls.name : `#<${v.cls.name}: ${m}>`;
        }
        if (v.ivars.has("__main")) return "main";
        if (v.ivars.has("__core")) return this.tr("#<VM コア>", "#<VM core>");
        if ((v as any).td) return `#<THROW_DATA ${TAG_NAME[(v as any).td.state] ?? ""}>`;
        const iv = [...v.ivars.entries()].filter(([k]) => k.startsWith("@"));
        const cname = this.realClassOf(v).name;
        if (iv.length === 0) return `#<${cname}>`;
        return `#<${cname} ` + iv.map(([k, val]) => `${k}=${this.inspect(val, depth + 1)}`).join(", ") + ">";
      }
    }
  }

  /** Equivalent of to_s (builtin types only) */
  toS(v: Value): string {
    switch (v.t) {
      case "nil":
        return "";
      case "str":
        return v.s;
      case "sym":
        return v.name;
      case "object":
        if (this.isException(v)) return this.excMessage(v);
        if (v.ivars.has("__main")) return "main";
        return `#<${this.realClassOf(v).name}>`;
      default:
        return this.inspect(v);
    }
  }

  isException(v: Value): boolean {
    return v.t === "object" && this.isKindOf(v, this.classes.Exception);
  }
  excMessage(e: ObjO): string {
    const m = e.ivars.get("__mesg");
    if (!m || m.t === "nil") return e.cls.name;
    return this.toS(m);
  }

  describeRecv(v: Value): string {
    switch (v.t) {
      case "nil":
        return "nil";
      case "true":
        return "true";
      case "false":
        return "false";
      case "class":
        return `${v.isModule ? "module" : "class"} ${v.name}`;
      case "object":
        if (v.ivars.has("__main")) return "main:Object";
        return `an instance of ${this.realClassOf(v).name}`;
      default:
        return `an instance of ${this.realClassOf(v).name}`;
    }
  }

  // ───────────────────────── Stack and environments ─────────────────────────

  top(): Frame {
    return this.frames[this.frames.length - 1];
  }

  /** The topmost Ruby-level frame (excluding CFUNC) */
  rubyTop(): Frame | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].iseq) return this.frames[i];
    return undefined;
  }

  private val(i: number): Value {
    const v = this.stack[i];
    if (!v || v.t === "envdata") return NIL;
    return v;
  }

  /** The environment level levels out */
  envAt(f: Frame, level: number): Env {
    let e = f.env!;
    for (let i = 0; i < level; i++) {
      if (!e.prev) throw new VMError(this.tr("環境の連鎖が途切れています", "The environment chain is broken"));
      e = e.prev;
    }
    return e;
  }

  /** The local environment (of a method or the top level) */
  localEnv(e: Env): Env {
    while (e.prev) e = e.prev;
    return e;
  }

  /** Position of local variable (ep - idx) on the stack, or -1 if it has moved to the heap */
  localSlot(e: Env, idx: number): number {
    return e.heap ? -1 : e.ep - idx;
  }

  localGet(e: Env, idx: number): Value {
    if (e.heap) return e.heap[e.size + 2 - idx] ?? NIL;
    const at = e.ep - idx;
    this.cur?.reads.push(at);
    return this.val(at);
  }

  localSet(e: Env, idx: number, v: Value) {
    if (e.heap) {
      e.heap[e.size + 2 - idx] = v;
      return;
    }
    this.stack[e.ep - idx] = v;
  }

  /**
   * Moves an environment to the heap (vm_make_env_object). So that a Proc can keep the variables outside the block,
   * the local variables on the stack are copied to the heap, and from then on the heap copy is read and written.
   */
  escapeEnv(e: Env | null): boolean {
    let moved = false;
    for (let x = e; x; x = x.prev) {
      if (x.heap) continue;
      x.heap = [];
      for (let i = x.ep - x.size - 2; i <= x.ep; i++) x.heap.push(this.val(i));
      moved = true;
    }
    return moved;
  }

  // ───────────────────────── Frame operations ─────────────────────────

  private pushIseqFrame(p: {
    kind: FrameKind;
    iseq: Iseq;
    retSlot: number;
    localStart: number;
    recvSlot: number | null;
    self: Value;
    locals: Value[];
    prev: Env | null;
    block: Value;
    me: Method | null;
    cref: ClassO;
    lambda: boolean;
    label: string;
    pc: number;
  }): Frame {
    if (this.frames.length >= MAX_FRAMES) this.error("SystemStackError", "stack level too deep");
    const { iseq } = p;
    const size = iseq.localSize;
    const ep = p.localStart + size + 2;
    if (ep + iseq.stackMax + 4 > MAX_STACK) this.error("SystemStackError", "stack level too deep");
    for (let i = 0; i < size; i++) this.stack[p.localStart + i] = p.locals[i] ?? NIL;
    const id = this.nextFrameId++;
    const env: Env = {
      id: this.id(),
      iseq,
      size,
      ep,
      heap: null,
      prev: p.prev,
      block: p.block,
      frameId: id,
      captured: false,
      me: p.me,
      cref: p.cref,
      lambda: p.lambda,
    };
    const meText = p.me ? `me: ${p.me.owner.attached ? this.inspect(p.me.owner.attached) + "." : p.me.owner.name + "#"}${p.me.name}` : `cref: ${p.cref.name}`;
    let spec: string;
    if (p.prev) spec = this.tr(`前の EP → ${p.prev.iseq.label}`, `prev EP → ${p.prev.iseq.label}`);
    else if (p.block.t === "proc") spec = this.tr(`ブロック: ${p.block.iseq ? p.block.iseq.label : "(組み込み)"}`, `block: ${p.block.iseq ? p.block.iseq.label : "(builtin)"}`);
    else spec = this.tr("ブロックなし", "no block");
    const flags = [FRAME_TYPE[p.kind], p.prev ? "" : "LOCAL", p.lambda ? "LAMBDA" : ""].filter(Boolean).join("|");
    this.stack[ep - 2] = { t: "envdata", kind: "me", text: meText };
    this.stack[ep - 1] = { t: "envdata", kind: "specval", text: spec };
    this.stack[ep] = { t: "envdata", kind: "flags", text: flags };
    const f: Frame = {
      id,
      kind: p.kind,
      iseq,
      pc: p.pc,
      sp: ep + 1,
      ep,
      env,
      self: p.self,
      label: p.label,
      retSlot: p.retSlot,
      localStart: p.localStart,
      recvSlot: p.recvSlot,
      lambda: p.lambda,
      me: p.me,
      afterReturn: null,
    };
    this.frames.push(f);
    return f;
  }

  private pushCfuncFrame(at: number, self: Value, me: Method | null, label: string, retSlot: number, recvSlot: number | null, gen: Generator<CallRequest, Value, Value>): Frame {
    if (this.frames.length >= MAX_FRAMES) this.error("SystemStackError", "stack level too deep");
    const ep = at + 2;
    this.stack[at] = { t: "envdata", kind: "me", text: me ? `me: ${me.owner.name}#${me.name}` : this.tr("me: (組み込み)", "me: (builtin)") };
    this.stack[at + 1] = { t: "envdata", kind: "specval", text: this.tr("(組み込みメソッド)", "(builtin method)") };
    this.stack[at + 2] = { t: "envdata", kind: "flags", text: "CFUNC|LOCAL" };
    const f: Frame = {
      id: this.nextFrameId++,
      kind: "cfunc",
      iseq: null,
      pc: 0,
      sp: ep + 1,
      ep,
      env: null,
      self,
      label,
      retSlot,
      localStart: at,
      recvSlot,
      lambda: false,
      me,
      gen,
      afterReturn: null,
    };
    this.frames.push(f);
    return f;
  }

  private popFrame(f: Frame) {
    const i = this.frames.lastIndexOf(f);
    if (i >= 0) this.frames.splice(i, 1);
    // Move a captured environment to the heap before it disappears from the stack
    if (f.env && f.env.captured && !f.env.heap) this.escapeEnv(f.env);
    if (f.gen) {
      try {
        f.gen.return(NIL);
      } catch {
        /* ignore failures while cleaning up */
      }
    }
  }

  frameOfEnv(e: Env): Frame | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].env === e) return this.frames[i];
    return undefined;
  }

  private ownerName(owner: ClassO, recv: Value) {
    if (owner.attached) return `${this.inspect(owner.attached)}.`;
    if (recv.t === "class" && owner === this.classes.Class) return `${recv.name}.`;
    return `${owner.name}#`;
  }

  // ───────────────────────── Blocks and Procs ─────────────────────────

  /** When a send has a block (blockiseq), bundles the current frame's environment and self into a block */
  captureBlock(f: Frame, iseq: Iseq): ProcO {
    const p = this.newProc(iseq, f.env, f.self, f.env!.cref, false);
    p.isBlock = true;
    for (let e: Env | null = f.env; e; e = e.prev) e.captured = true;
    return p;
  }

  /** Turns a block into a Proc object. The environment moves to the heap at this point */
  toProcObject(blk: Value, info?: StepInfo): Value {
    if (blk.t !== "proc") return blk;
    if (blk.isBlock) {
      const moved = this.escapeEnv(blk.env);
      blk.isBlock = false;
      info = info ?? this.cur ?? undefined;
      if (moved && info) info.event = { type: "escape", text: this.tr("Proc を作るため、ブロックが参照する環境 (ローカル変数) をスタックからヒープへ移動", "To create a Proc, the environment (local variables) the block refers to is moved from the stack to the heap") };
    }
    return blk;
  }

  /** Turns a value passed as &obj into a block */
  toBlock(v: Value): Value {
    if (v.t === "nil" || v.t === "proc") return v;
    if (v.t === "sym") {
      const name = v.name;
      const p = this.newProc(null, null, NIL, null, true);
      p.lambda = false;
      p.symbol = name;
      p.native = function* (vm: VM, _self: Value, args: Value[]) {
        if (args.length === 0) vm.error("ArgumentError", "no receiver given");
        return (yield { type: "send", recv: args[0], mid: name, args: args.slice(1), blk: NIL } as CallRequest) as Value;
      } as any;
      return p;
    }
    this.error("TypeError", `wrong argument type ${builtinClassName(v)} (expected Proc)`);
  }

  /** Whether a block was given to the calling method (block_given?) */
  blockGiven(): boolean {
    const f = this.rubyTop();
    if (!f || !f.env) return false;
    return this.localEnv(f.env).block.t === "proc";
  }

  // ───────────────────────── Receiving arguments (vm_args.c) ─────────────────────────

  /**
   * Lays out the arguments as local variables. Returns [initial values of the locals, starting pc].
   * Blocks (non-lambda Procs) do not raise an error when the number of arguments does not match.
   */
  setupParams(iseq: Iseq, args: Value[], kw: HashO | null, blk: Value, strict: boolean, isBlock: boolean): { locals: Value[]; pc: number } {
    const P = iseq.params;
    const locals: Value[] = new Array(iseq.localSize).fill(NIL);
    const lead = P.lead_num ?? 0;
    const optNum = P.opt ? P.opt.length - 1 : 0;
    const post = P.post_num ?? 0;
    const hasRest = P.rest_start !== undefined;
    const kws = P.keyword ?? [];
    const acceptsKw = kws.length > 0 || P.kwrest !== undefined;
    args = [...args];

    // If the method takes no keyword arguments, pass them as the last positional argument (a hash)
    if (kw && !acceptsKw) {
      if (kw.map.size > 0) args.push(kw);
      kw = null;
    }
    // If a block receives a single array, expand it (|a, b| etc.)
    if (isBlock && !strict && args.length === 1 && args[0].t === "array" && !P.ambiguous_param0 && lead + post + optNum + (hasRest ? 1 : 0) > 0 && (lead + post > 1 || optNum > 0 || (hasRest && lead + post > 0))) {
      args = [...(args[0] as AryO).items];
    }

    const required = lead + post;
    if (strict) {
      if (args.length < required || (!hasRest && args.length > required + optNum)) {
        const expected = hasRest ? `${required}+` : optNum ? `${required}..${required + optNum}` : `${required}`;
        this.error("ArgumentError", `wrong number of arguments (given ${args.length}, expected ${expected})`);
      }
    }
    let i = 0;
    for (let j = 0; j < lead; j++) locals[j] = args[i++] ?? NIL;
    // Post arguments are taken from the end
    const postVals: Value[] = [];
    const avail = Math.max(0, args.length - lead);
    const postTake = Math.min(post, avail);
    for (let j = 0; j < post; j++) postVals.push(j < postTake ? args[args.length - postTake + j] : NIL);
    const middle = args.slice(lead, args.length - postTake);
    let used = 0;
    for (let j = 0; j < optNum && used < middle.length; j++) locals[lead + j] = middle[used++];
    const pc = P.opt ? P.opt[used] : 0;
    if (hasRest) locals[P.rest_start!] = this.ary(middle.slice(used));
    if (post) for (let j = 0; j < post; j++) locals[P.post_start! + j] = postVals[j];

    if (acceptsKw) {
      const given = new Map<string, Value>();
      const rest = this.hash();
      if (kw) {
        for (const [k, v] of kw.map.values()) {
          if (k.t === "sym" && kws.some((x) => x.name === k.name)) given.set(k.name, v);
          else this.hashSet(rest, k, v);
        }
      }
      const kwStart = (P.kwbits ?? 0) - kws.length;
      // Bits of keywords that were not given (their default expression must run). Numbered excluding required keywords
      let bits = 0;
      const reqNum = kws.filter((k) => k.required).length;
      const missing: string[] = [];
      kws.forEach((k, j) => {
        if (given.has(k.name)) locals[kwStart + j] = given.get(k.name)!;
        else if (k.required) missing.push(k.name);
        else if (k.static && k.default) locals[kwStart + j] = this.literal(k.default);
        else bits |= 1 << (j - reqNum);
      });
      if (missing.length && strict) this.error("ArgumentError", `missing keyword${missing.length > 1 ? "s" : ""}: ${missing.map((m) => ":" + m).join(", ")}`);
      if (P.kwbits !== undefined) locals[P.kwbits] = int(bits);
      if (P.kwrest !== undefined) locals[P.kwrest] = rest;
      else if (rest.map.size > 0 && strict) {
        const names = [...rest.map.values()].map(([k]) => this.inspect(k));
        this.error("ArgumentError", `unknown keyword${names.length > 1 ? "s" : ""}: ${names.join(", ")}`);
      }
    }
    if (P.block_start !== undefined) locals[P.block_start] = NIL;
    void blk;
    return { locals, pc };
  }

  // ───────────────────────── Method calls ─────────────────────────

  /**
   * Calls a method using [recv, args...] on the stack.
   * For a method written in Ruby, pushes a frame and returns undefined; for a builtin method, returns the result right away.
   * retSlot is where the return value is written (usually the receiver's slot).
   */
  invoke(
    caller: Frame,
    retSlot: number,
    recv: Value,
    mid: string,
    args: Value[],
    kw: HashO | null,
    blk: Value,
    opts: { fcall?: boolean; vcall?: boolean; superFrom?: ClassO | null } = {},
  ): { value: Value } | undefined {
    const cls = this.classOf(recv);
    const m = this.findMethod(cls, mid, opts.superFrom);
    if (!m) {
      if (opts.superFrom !== undefined) this.error("NoMethodError", `super: no superclass method '${mid}' for ${this.describeRecv(recv)}`);
      const mm = this.findMethod(cls, "method_missing");
      if (mm && !mm.native) return this.invoke(caller, retSlot, recv, "method_missing", [sym(mid), ...args], kw, blk, opts);
      if (!opts.vcall) this.error("NoMethodError", `undefined method '${mid}' for ${this.describeRecv(recv)}`);
      this.error("NameError", `undefined local variable or method '${mid}' for ${this.describeRecv(recv)}`);
    }
    if (m.visibility === "private" && !opts.fcall && !mid.endsWith("=")) this.error("NoMethodError", `private method '${mid}' called for ${this.describeRecv(recv)}`);
    const label = `${this.ownerName(m.owner, recv)}${mid}`;
    if (m.iseq) {
      const { locals, pc } = this.setupParams(m.iseq, args, kw, blk, true, false);
      caller.sp = retSlot;
      this.stack[retSlot] = recv;
      this.pushIseqFrame({
        kind: "method",
        iseq: m.iseq,
        retSlot,
        localStart: retSlot + 1,
        recvSlot: retSlot,
        self: recv,
        locals,
        prev: null,
        block: blk,
        me: m,
        cref: m.owner,
        lambda: false,
        label,
        pc,
      });
      return undefined;
    }
    if (m.proc) {
      // A method defined with define_method: call it as a lambda
      caller.sp = retSlot;
      return this.callProc(caller, retSlot, retSlot + 1, m.proc, args, blk, recv, m, true);
    }
    if (recv.t === "proc" && (m as any).procCall) {
      caller.sp = retSlot;
      return this.callProc(caller, retSlot, retSlot, recv, kw && kw.map.size ? [...args, kw] : args, blk);
    }
    const nargs = kw && kw.map.size > 0 ? [...args, kw] : args;
    const r = m.native!(this, recv, nargs, blk, kw);
    if (isGenerator(r)) {
      // A builtin method calls a block: push a CFUNC frame and run the block on top of it
      const at = Math.max(caller.sp, retSlot + 1 + args.length);
      const f = this.pushCfuncFrame(at, recv, m, label, retSlot, retSlot, r);
      caller.sp = retSlot;
      return this.resumeNative(f, { next: NIL });
    }
    caller.sp = retSlot;
    return { value: r ?? NIL };
  }

  /** Calls a Proc (block). The arguments are laid out from argStart */
  callProc(caller: Frame, retSlot: number, argStart: number, proc: ProcO, args: Value[], blk: Value, self?: Value, me?: Method, asLambda?: boolean): { value: Value } | undefined {
    if (proc.native) {
      const r = proc.native(this, self ?? proc.self, args, blk);
      if (isGenerator(r)) {
        const f = this.pushCfuncFrame(Math.max(caller.sp, argStart), self ?? proc.self, null, proc.symbol ? `&:${proc.symbol}` : this.tr("Proc (組み込み)", "Proc (builtin)"), retSlot, null, r);
        return this.resumeNative(f, { next: NIL });
      }
      return { value: r ?? NIL };
    }
    const iseq = proc.iseq!;
    const lambda = asLambda || proc.lambda;
    const { locals, pc } = this.setupParams(iseq, args, null, blk, lambda, true);
    const env = proc.env;
    const label = (lambda && !me ? "lambda: " : "") + (me ? `${this.ownerName(me.owner, self ?? proc.self)}${me.name}` : iseq.label);
    this.pushIseqFrame({
      kind: "block",
      iseq,
      retSlot,
      localStart: argStart,
      recvSlot: me ? retSlot : null,
      self: self ?? proc.self,
      locals,
      prev: env,
      block: blk,
      me: me ?? env?.me ?? null,
      cref: proc.targetClass ?? env?.cref ?? this.object,
      lambda,
      label,
      pc,
    });
    const f = this.top();
    // When called as a method, this frame receives the block argument
    if (me) f.env!.block = blk;
    return undefined;
  }

  /** Resumes a builtin method's generator. When it finishes, returns the value for the caller */
  private resumeNative(f: Frame, input: { next: Value } | { throw: RubyError }): { value: Value } | undefined {
    let cur: { next: Value } | { throw: RubyError } = input;
    for (;;) {
      let r: IteratorResult<CallRequest, Value>;
      try {
        r = "throw" in cur ? f.gen!.throw(cur.throw) : f.gen!.next(cur.next);
      } catch (e) {
        f.gen = undefined;
        this.popFrame(f);
        throw e;
      }
      if (r.done) {
        f.gen = undefined;
        this.popFrame(f);
        return { value: r.value ?? NIL };
      }
      const req = r.value;
      let res: { value: Value } | undefined;
      const base = f.sp;
      try {
        if (req.type === "proc") {
          for (let i = 0; i < req.args.length; i++) this.stack[base + i] = req.args[i];
          res = this.callProc(f, base, base, req.proc, req.args, req.blk ?? NIL, req.self);
        } else {
          this.stack[base] = req.recv;
          for (let i = 0; i < req.args.length; i++) this.stack[base + 1 + i] = req.args[i];
          f.sp = base + 1 + req.args.length;
          res = this.invoke(f, base, req.recv, req.mid, req.args, null, req.blk, { fcall: true });
          f.sp = base;
        }
      } catch (e) {
        f.sp = base;
        if (e instanceof RubyError) {
          cur = { throw: e };
          continue;
        }
        throw e;
      }
      if (!res) return undefined;
      cur = { next: res.value };
    }
  }

  /** Frame f finishes, returning value v (leave) */
  private returnFrom(f: Frame, v: Value) {
    this.popFrame(f);
    this.deliver(v, f.retSlot);
  }

  /** Delivers a return value to the caller */
  private deliver(value: Value, retSlot: number) {
    for (;;) {
      const top = this.top();
      if (!top) {
        this.halted = true;
        this.result = value;
        return;
      }
      if (top.kind !== "cfunc") {
        top.sp = retSlot;
        this.stack[top.sp++] = value;
        this.cur?.pushes.push(retSlot);
        if (top.afterReturn) {
          const fn = top.afterReturn;
          top.afterReturn = null;
          fn(value);
        }
        return;
      }
      const r = this.resumeNative(top, { next: value });
      if (!r) return;
      value = r.value;
      retSlot = top.retSlot;
    }
  }

  // ───────────────────────── Escapes and exceptions (vm_exec_handle_exception) ─────────────────────────

  makeThrowObject(td: ThrowData): ObjO {
    const o = this.newObject(this.classes.__Throw);
    (o as any).td = td;
    return o;
  }

  throwDataOf(v: Value): ThrowData | null {
    return v.t === "object" ? ((v as any).td ?? null) : null;
  }

  /**
   * For break / return / next / retry and exceptions, unwinds frames looking for where to go.
   * If a frame's catch table has a rescue / ensure entry on the way, runs that clause as a new frame.
   */
  handleThrow(td: ThrowData, info?: StepInfo) {
    let state = td.state;
    for (;;) {
      const f = this.top();
      if (!f) {
        this.halted = true;
        if (state === TAG.RAISE) {
          const exc = td.val as ObjO;
          this.uncaught = exc;
          const msg = `${this.excMessage(exc)} (${exc.cls.name})`;
          this.output.push({ text: `main.rb: ${msg}\n`, kind: "err" });
          if (info) info.event = { type: "error", text: this.tr(`捕捉されない例外: ${msg}`, `Uncaught exception: ${msg}`) };
        } else {
          this.result = td.val;
        }
        return;
      }
      if (f.kind === "cfunc") {
        if (state === TAG.RAISE && f.gen) {
          // Throw the exception into the builtin method (e.g. loop catching StopIteration)
          let r: { value: Value } | undefined;
          try {
            r = this.resumeNative(f, { throw: new RubyError(td.val as ObjO) });
          } catch (e) {
            if (e instanceof RubyError) {
              td = { state: TAG.RAISE, val: e.exc, escapeId: null };
              continue;
            }
            throw e;
          }
          if (r) this.deliver(r.value, f.retSlot);
          return;
        }
        this.popFrame(f);
        continue;
      }
      const iseq = f.iseq!;
      const epc = f.pc;
      const covers = (e: CatchEntry) => e.start < epc && e.end >= epc;
      let entry: CatchEntry | undefined;

      if ((state === TAG.BREAK || state === TAG.RETURN) && td.escapeId === f.id) {
        if (state === TAG.RETURN) {
          entry = iseq.catchTable.find((e) => covers(e) && e.type === "ensure");
          if (!entry) {
            this.returnFrom(f, td.val);
            if (info) info.event = { type: "return", text: this.tr(`return で ${f.label} から戻る`, `return from ${f.label}`) };
            return;
          }
        } else {
          this.stack[f.sp] = td.val;
          this.cur?.pushes.push(f.sp);
          f.sp++;
          if (info) info.event = { type: "return", text: this.tr(`break で ${f.label} の呼び出しを抜ける`, `break out of the call in ${f.label}`) };
          return;
        }
      }
      if (!entry) {
        if (state === TAG.RAISE) {
          entry = iseq.catchTable.find((e) => covers(e) && (e.type === "rescue" || e.type === "ensure"));
        } else if (state === TAG.RETRY) {
          for (const e of iseq.catchTable) {
            if (!covers(e)) continue;
            if (e.type === "ensure") {
              entry = e;
              break;
            }
            if (e.type === "retry" && td.escapeId === f.id) {
              f.pc = e.cont;
              if (info) {
                info.jumped = true;
                info.event = { type: "rescue", text: this.tr(`retry: ${pad4(e.cont)} からやり直す`, `retry: start over from ${pad4(e.cont)}`) };
              }
              return;
            }
          }
        } else if ((state === TAG.BREAK && td.escapeId === null) || state === TAG.NEXT || state === TAG.REDO) {
          const type = state === TAG.BREAK ? "break" : state === TAG.NEXT ? "next" : "redo";
          for (const e of iseq.catchTable) {
            if (!covers(e)) continue;
            if (e.type === "ensure") {
              entry = e;
              break;
            }
            if (e.type === type) {
              f.pc = e.cont;
              f.sp = f.ep + 1 + e.sp;
              if (state !== TAG.REDO) {
                this.stack[f.sp] = td.val;
                this.cur?.pushes.push(f.sp);
                f.sp++;
              }
              if (info) {
                info.jumped = true;
                info.event = { type: "rescue", text: this.tr(`${type}: 例外ハンドラ表の ${type} エントリに従って ${pad4(e.cont)} へ`, `${type}: go to ${pad4(e.cont)} following the ${type} entry of the catch table`) };
              }
              return;
            }
          }
        } else {
          entry = iseq.catchTable.find((e) => covers(e) && e.type === "ensure");
        }
      }

      if (entry && entry.iseq !== null) {
        // Run the rescue / ensure clause as a new frame
        const catchIseq = this.program.iseqs[entry.iseq];
        f.sp = f.ep + 1 + entry.sp;
        f.pc = entry.cont;
        const err: Value = state === TAG.RAISE ? td.val : this.makeThrowObject({ ...td, state });
        const at = f.sp;
        const locals = new Array(catchIseq.localSize).fill(NIL);
        locals[0] = err;
        this.pushIseqFrame({
          kind: entry.type === "rescue" ? "rescue" : "ensure",
          iseq: catchIseq,
          retSlot: at,
          localStart: at,
          recvSlot: null,
          self: f.self,
          locals,
          prev: f.env,
          block: NIL,
          me: f.env!.me,
          cref: f.env!.cref,
          lambda: false,
          label: catchIseq.label,
          pc: 0,
        });
        if (state === TAG.RAISE) this.errinfo = td.val;
        if (info)
          info.event = {
            type: "rescue",
            text: this.tr(`例外ハンドラ表の ${entry.type} エントリ (${pad4(entry.start)}〜${pad4(entry.end)}) が見つかったので「${catchIseq.label}」を実行`, `Found a ${entry.type} entry (${pad4(entry.start)}-${pad4(entry.end)}) in the catch table, so run "${catchIseq.label}"`),
          };
        return;
      }
      this.popFrame(f);
    }
  }

  /** Raises an exception */
  raise(exc: ObjO, info?: StepInfo) {
    this.handleThrow({ state: TAG.RAISE, val: exc, escapeId: null }, info);
  }

  /** throw instruction: decides the frame to escape to (vm_throw_start) */
  private throwStart(f: Frame, state: number, flag: number, val: Value): ThrowData {
    if (flag !== 0) return { state, val, escapeId: null };
    if (state === TAG.BREAK) {
      let e = f.env!;
      let base = f.iseq!;
      let escape: Frame | undefined = f;
      while (base.type !== "block") {
        if (escape && escape.iseq?.type === "class") {
          const i = this.frames.indexOf(escape);
          escape = this.frames[i - 1];
          e = escape.env!;
          base = escape.iseq!;
        } else {
          if (!e.prev || base.parent === null) throw new VMError(this.tr("break の行き先が見つかりません", "Cannot find where to break to"));
          e = e.prev;
          base = this.program.iseqs[base.parent];
          escape = this.frameOfEnv(e);
        }
      }
      if (escape && escape.lambda) return { state: TAG.RETURN, val, escapeId: escape.id };
      const target = e.prev;
      const tf = target ? this.frameOfEnv(target) : undefined;
      if (tf && tf.iseq) {
        const ok = tf.iseq.catchTable.some((c) => c.type === "break" && c.iseq === base.index && c.start < tf.pc && c.end >= tf.pc && c.cont === tf.pc);
        if (ok) return { state, val, escapeId: tf.id };
      }
      this.error("LocalJumpError", "break from proc-closure");
    }
    if (state === TAG.RETRY) {
      const tf = f.env!.prev ? this.frameOfEnv(f.env!.prev) : undefined;
      return { state, val, escapeId: tf?.id ?? null };
    }
    if (state === TAG.RETURN) {
      for (let e: Env | null = f.env; e; e = e.prev) {
        const fr = this.frameOfEnv(e);
        if (e.lambda) {
          if (fr) return { state, val, escapeId: fr.id };
          break;
        }
        if (!e.prev) {
          if (fr && (fr.kind === "method" || fr.kind === "top")) return { state, val, escapeId: fr.id };
          break;
        }
      }
      this.error("LocalJumpError", "unexpected return");
    }
    return { state, val, escapeId: null };
  }

  // ───────────────────────── Execution ─────────────────────────

  /** Runs one instruction */
  step(): StepInfo | null {
    if (this.halted) return null;
    const f = this.top();
    if (!f || !f.iseq) {
      this.halted = true;
      return null;
    }
    const insn = f.iseq.byPc.get(f.pc);
    if (!insn) {
      this.halted = true;
      this.output.push({ text: this.tr(`不正な pc: ${f.pc}\n`, `Invalid pc: ${f.pc}\n`), kind: "err" });
      return null;
    }
    const info: StepInfo = {
      index: this.steps,
      frameId: f.id,
      iseqIndex: f.iseq.index,
      insn,
      desc: "",
      pops: [],
      pushes: [],
      reads: [],
      writes: [],
      popped: [],
      pushed: [],
      spBefore: f.sp,
      jumped: false,
    };
    const end0 = this.watchEnd();
    const before = this.stack.slice(0, end0);
    f.pc = insn.pc + insn.len;
    this.cur = info;
    try {
      this.exec(f, insn, info);
    } catch (e) {
      if (e instanceof RubyError) {
        info.desc += (info.desc ? " → " : "") + this.tr(`例外 ${e.exc.cls.name}: ${this.excMessage(e.exc)}`, `exception ${e.exc.cls.name}: ${this.excMessage(e.exc)}`);
        if (!info.event) info.event = { type: "raise", text: `${e.exc.cls.name}: ${this.excMessage(e.exc)}` };
        this.raise(e.exc, info);
      } else if (e instanceof VMError) {
        this.halted = true;
        this.output.push({ text: e.message + "\n", kind: "err" });
        info.event = { type: "error", text: e.message };
      } else {
        throw e;
      }
    } finally {
      this.cur = null;
    }
    const end1 = this.watchEnd();
    const writes = new Set<number>();
    for (let i = 0; i < Math.max(before.length, end1); i++) if (before[i] !== this.stack[i]) writes.add(i);
    info.writes = [...writes];
    const asValue = (x: Slot): Value => (x && x.t !== "envdata" ? x : NIL);
    const pops = [...new Set(info.pops)].sort((a, b) => a - b);
    info.popped = pops.map((i) => asValue(before[i]));
    const pushes = [...new Set(info.pushes)].sort((a, b) => a - b);
    info.pushed = pushes.map((i) => asValue(this.stack[i]));
    if (this.halted && !info.event) info.event = { type: "halt", text: this.tr("プログラムの実行が終わりました", "The program has finished") };
    this.steps++;
    return info;
  }

  private watchEnd() {
    let end = 1;
    for (const fr of this.frames) end = Math.max(end, fr.sp, fr.ep + 1);
    return Math.min(end + 8, this.stack.length);
  }

  /** Executes instruction insn in frame f */
  private exec(f: Frame, insn: Insn, info: StepInfo) {
    const S = this.stack;
    const ops = insn.ops;
    const push = (v: Value) => {
      if (f.sp >= MAX_STACK) this.error("SystemStackError", "stack level too deep");
      info.pushes.push(f.sp);
      S[f.sp++] = v;
    };
    const pop = (): Value => {
      if (f.sp <= f.ep + 1) throw new VMError(this.tr(`スタックが空です (${insn.name})`, `The stack is empty (${insn.name})`));
      const i = --f.sp;
      info.pops.push(i);
      return this.val(i);
    };
    const topn = (n: number): Value => {
      const i = f.sp - 1 - n;
      info.reads.push(i);
      return this.val(i);
    };
    const I = (v: Value) => this.inspect(v);
    const num = (o: Operand) => Number((o as any).v);
    const jump = (pc: number) => {
      f.pc = pc;
      info.jumped = true;
    };
    const lname = (level: number, idx: number) => {
      const e = this.envAt(f, level);
      return localName(e.iseq, idx);
    };
    const name = insn.name;

    switch (name) {
      case "nop":
        info.desc = this.tr("何もしない", "Do nothing");
        return;

      // ── Local variables ──
      case "getlocal":
      case "getlocal_WC_0":
      case "getlocal_WC_1": {
        const idx = num(ops[0]);
        const level = name === "getlocal" ? num(ops[1]) : name === "getlocal_WC_1" ? 1 : 0;
        const e = this.envAt(f, level);
        const v = this.localGet(e, idx);
        push(v);
        info.desc = this.tr(`${level ? `${level} つ外側の` : ""}ローカル変数 ${lname(level, idx)} (EP-${idx}${e.heap ? "、ヒープ上" : ""}) の値 ${I(v)} を積む`, `Push the value ${I(v)} of ${level ? `the outer (level ${level}) ` : ""}local variable ${lname(level, idx)} (EP-${idx}${e.heap ? ", on the heap" : ""})`);
        return;
      }
      case "setlocal":
      case "setlocal_WC_0":
      case "setlocal_WC_1": {
        const idx = num(ops[0]);
        const level = name === "setlocal" ? num(ops[1]) : name === "setlocal_WC_1" ? 1 : 0;
        const e = this.envAt(f, level);
        const v = pop();
        this.localSet(e, idx, v);
        info.desc = this.tr(`${I(v)} を取り出して、${level ? `${level} つ外側の` : ""}ローカル変数 ${lname(level, idx)} (EP-${idx}${e.heap ? "、ヒープ上" : ""}) に代入`, `Pop ${I(v)} and store it in ${level ? `the outer (level ${level}) ` : ""}local variable ${lname(level, idx)} (EP-${idx}${e.heap ? ", on the heap" : ""})`);
        return;
      }
      case "getblockparam":
      case "getblockparamproxy": {
        const idx = num(ops[0]);
        const level = num(ops[1]);
        const e = this.envAt(f, level);
        if (!e.blockParamSet) {
          const blk = this.localEnv(e).block;
          if (name === "getblockparamproxy" && blk.t === "proc" && blk.isBlock) {
            push(blk);
            info.desc = this.tr(`ブロック引数 ${lname(level, idx)} を読む (Proc を作らずにブロックをそのまま積む)`, `Read block parameter ${lname(level, idx)} (push the block as is, without creating a Proc)`);
            return;
          }
          const p = this.toProcObject(blk, info);
          this.localSet(e, idx, p);
          e.blockParamSet = true;
          push(p);
          info.desc = this.tr(`渡されたブロックを Proc オブジェクトにして、ブロック引数 ${lname(level, idx)} に入れてから積む`, `Turn the given block into a Proc object, store it in block parameter ${lname(level, idx)}, and push it`);
          return;
        }
        const v = this.localGet(e, idx);
        push(v);
        info.desc = this.tr(`ブロック引数 ${lname(level, idx)} の値 ${I(v)} を積む`, `Push the value ${I(v)} of block parameter ${lname(level, idx)}`);
        return;
      }
      case "setblockparam": {
        const idx = num(ops[0]);
        const level = num(ops[1]);
        const e = this.envAt(f, level);
        const v = pop();
        this.localSet(e, idx, v);
        e.blockParamSet = true;
        info.desc = this.tr(`ブロック引数 ${lname(level, idx)} に ${I(v)} を代入`, `Assign ${I(v)} to block parameter ${lname(level, idx)}`);
        return;
      }
      case "getspecial":
        push(NIL);
        info.desc = this.tr("特殊変数 ($~ など) を積む (このビジュアライザでは常に nil)", "Push a special variable ($~ etc.; always nil in this visualizer)");
        return;
      case "setspecial":
        pop();
        info.desc = this.tr("特殊変数に書き込む", "Write a special variable");
        return;

      // ── Other variables ──
      case "getinstancevariable": {
        const id = (ops[0] as any).v as string;
        const v = this.ivars(f.self).get(id) ?? NIL;
        push(v);
        info.desc = this.tr(`self のインスタンス変数 ${id} の値 ${I(v)} を積む`, `Push the value ${I(v)} of self's instance variable ${id}`);
        return;
      }
      case "setinstancevariable": {
        const id = (ops[0] as any).v as string;
        const v = pop();
        this.checkFrozen(f.self);
        this.ivars(f.self).set(id, v);
        info.desc = this.tr(`${I(v)} を取り出して、self (${truncate(I(f.self), 24)}) のインスタンス変数 ${id} に代入`, `Pop ${I(v)} and store it in instance variable ${id} of self (${truncate(I(f.self), 24)})`);
        return;
      }
      case "getclassvariable": {
        const id = (ops[0] as any).v as string;
        const v = this.cvarGet(this.cvarBase(f), id);
        push(v);
        info.desc = this.tr(`クラス変数 ${id} の値 ${I(v)} を積む`, `Push the value ${I(v)} of class variable ${id}`);
        return;
      }
      case "setclassvariable": {
        const id = (ops[0] as any).v as string;
        const v = pop();
        this.cvarSet(this.cvarBase(f), id, v);
        info.desc = this.tr(`クラス変数 ${id} に ${I(v)} を代入`, `Assign ${I(v)} to class variable ${id}`);
        return;
      }
      case "opt_getconstant_path": {
        const path = (ops[0] as any).v.map((x: Operand) => (x as any).v as string) as string[];
        let v: Value;
        let i = 0;
        if (path[0] === "") {
          v = this.object;
          i = 1;
        } else {
          v = this.constGet(f.env!.cref, path[0]);
          i = 1;
        }
        for (; i < path.length; i++) {
          if (v.t !== "class") this.error("TypeError", `${I(v)} is not a class/module`);
          v = this.constGet(v, path[i], true);
        }
        push(v);
        info.desc = this.tr(`定数 ${path.filter(Boolean).join("::")} を探して、その値 ${truncate(I(v), 30)} を積む`, `Look up constant ${path.filter(Boolean).join("::")} and push its value ${truncate(I(v), 30)}`);
        return;
      }
      case "getconstant": {
        const id = (ops[0] as any).v as string;
        pop(); // allow_nil
        const klass = pop();
        const v = klass.t === "nil" ? this.constGet(f.env!.cref, id) : this.constGet(klass as ClassO, id, true);
        push(v);
        info.desc = this.tr(`定数 ${id} の値 ${truncate(I(v), 30)} を積む`, `Push the value ${truncate(I(v), 30)} of constant ${id}`);
        return;
      }
      case "setconstant": {
        const id = (ops[0] as any).v as string;
        const cbase = pop();
        const v = pop();
        this.constSet(cbase.t === "class" ? cbase : f.env!.cref, id, v);
        info.desc = this.tr(`定数 ${id} に ${truncate(I(v), 30)} を設定`, `Set constant ${id} to ${truncate(I(v), 30)}`);
        return;
      }
      case "getglobal": {
        const id = (ops[0] as any).v as string;
        const v = id === "$!" ? this.errinfo : (this.globals.get(id) ?? NIL);
        push(v);
        info.desc = this.tr(`グローバル変数 ${id} の値 ${I(v)} を積む`, `Push the value ${I(v)} of global variable ${id}`);
        return;
      }
      case "setglobal": {
        const id = (ops[0] as any).v as string;
        const v = pop();
        this.globals.set(id, v);
        info.desc = this.tr(`グローバル変数 ${id} に ${I(v)} を代入`, `Assign ${I(v)} to global variable ${id}`);
        return;
      }

      // ── Pushing values ──
      case "putnil":
        push(NIL);
        info.desc = this.tr("nil を積む", "Push nil");
        return;
      case "putself":
        push(f.self);
        info.desc = this.tr(`self (${truncate(I(f.self), 30)}) を積む`, `Push self (${truncate(I(f.self), 30)})`);
        return;
      case "putobject": {
        const v = this.literal(ops[0]);
        push(v);
        info.desc = this.tr(`${truncate(I(v), 40)} を積む`, `Push ${truncate(I(v), 40)}`);
        return;
      }
      case "putobject_INT2FIX_0_":
      case "putobject_INT2FIX_1_": {
        const v = int(name === "putobject_INT2FIX_0_" ? 0 : 1);
        push(v);
        info.desc = this.tr(`${I(v)} を積む`, `Push ${I(v)}`);
        return;
      }
      case "putspecialobject": {
        const t = num(ops[0]);
        const v = t === 1 ? this.core : f.env!.cref;
        push(v);
        info.desc = t === 1 ? this.tr("VM コア (内部用のオブジェクト) を積む", "Push the VM core (an internal object)") : this.tr(`${t === 2 ? "定義先のクラス" : "定数の探索起点"} ${I(v)} を積む`, `Push ${t === 2 ? "the class to define in" : "the base for constant lookup"} ${I(v)}`);
        return;
      }
      case "putstring":
      case "putchilledstring": {
        const v = this.str((ops[0] as any).v);
        push(v);
        info.desc = this.tr(`文字列 ${truncate(I(v), 40)} を複製して積む`, `Duplicate the string ${truncate(I(v), 40)} and push it`);
        return;
      }

      // ── Strings, arrays, hashes ──
      case "concatstrings": {
        const n = num(ops[0]);
        const parts: string[] = [];
        for (let i = 0; i < n; i++) parts.unshift(this.toS(pop()));
        const v = this.str(parts.join(""));
        push(v);
        info.desc = this.tr(`${n} 個の文字列を連結して ${truncate(I(v), 40)} を積む`, `Concatenate ${n} strings and push ${truncate(I(v), 40)}`);
        return;
      }
      case "anytostring": {
        const s = pop();
        const v = pop();
        const r = s.t === "str" ? s : this.str(`#<${this.realClassOf(v).name}>`);
        push(r);
        info.desc = this.tr(`to_s の結果 ${truncate(I(r), 30)} を積む`, `Push the result of to_s, ${truncate(I(r), 30)}`);
        return;
      }
      case "objtostring": {
        const recv = topn(0);
        if (recv.t === "str") {
          info.desc = this.tr(`${truncate(I(recv), 30)} はすでに文字列なので、そのまま`, `${truncate(I(recv), 30)} is already a string, so leave it as is`);
          return;
        }
        if (!this.hasUserMethod(recv, "to_s")) {
          pop();
          const v = this.str(this.toS(recv));
          push(v);
          info.desc = this.tr(`${truncate(I(recv), 30)}.to_s を呼んで ${truncate(I(v), 30)} を積む`, `Call ${truncate(I(recv), 30)}.to_s and push ${truncate(I(v), 30)}`);
          return;
        }
        this.sendCD(f, ops[0] as CallData, null, info);
        return;
      }
      case "toregexp":
        this.error("NotImplementedError", this.tr("このビジュアライザは正規表現 (Regexp) に対応していません", "This visualizer does not support regular expressions (Regexp)"));
      case "intern": {
        const s = pop();
        const v = sym(this.toS(s));
        push(v);
        info.desc = this.tr(`文字列 ${I(s)} をシンボル ${I(v)} にする`, `Turn the string ${I(s)} into the symbol ${I(v)}`);
        return;
      }
      case "newarray": {
        const n = num(ops[0]);
        const items: Value[] = [];
        for (let i = 0; i < n; i++) items.unshift(pop());
        const v = this.ary(items);
        push(v);
        info.desc = this.tr(`上から ${n} 個の値を取り出して配列 ${truncate(I(v), 40)} を作って積む`, `Pop ${n} values and push them as the array ${truncate(I(v), 40)}`);
        return;
      }
      case "pushtoarraykwsplat": {
        const h = pop();
        const a = pop() as AryO;
        if (h.t === "hash" && h.map.size > 0) a.items.push(h);
        push(a);
        info.desc = this.tr(`キーワード引数のハッシュを配列に追加`, `Add the keyword-argument hash to the array`);
        return;
      }
      case "duparray":
      case "duphash": {
        const v = this.dupValue(this.literal(ops[0]));
        push(v);
        info.desc = this.tr(`${name === "duparray" ? "配列" : "ハッシュ"}リテラル ${truncate(I(v), 40)} を複製して積む`, `Duplicate the ${name === "duparray" ? "array" : "hash"} literal ${truncate(I(v), 40)} and push it`);
        return;
      }
      case "opt_ary_freeze":
      case "opt_hash_freeze":
      case "opt_str_freeze":
      case "opt_str_uminus": {
        const v = this.literal(ops[0]);
        push(v);
        info.desc = this.tr(`凍結済みのリテラル ${truncate(I(v), 30)} を積む`, `Push the frozen literal ${truncate(I(v), 30)}`);
        return;
      }
      case "expandarray": {
        const n = num(ops[0]);
        const flag = num(ops[1]);
        const src = pop();
        const items = src.t === "array" ? src.items : [src];
        const splat = flag & 1;
        if (flag & 2) {
          let i = 0;
          for (; i < n - items.length; i++) push(NIL);
          let j = 0;
          for (; i < n; i++, j++) push(items[items.length - j - 1]);
          if (splat) push(this.ary(items.slice(0, items.length - j)));
        } else {
          if (splat) push(this.ary(items.slice(n)));
          for (let i = n - 1; i >= 0; i--) push(items[i] ?? NIL);
        }
        info.desc = this.tr(`${truncate(I(src), 30)} を ${n} 個の値に分解して積む (先頭の要素がいちばん上)`, `Split ${truncate(I(src), 30)} into ${n} values and push them (the first element ends up on top)`);
        return;
      }
      case "concatarray":
      case "concattoarray": {
        const b = pop();
        const a = pop();
        const v = name === "concattoarray" ? (a as AryO) : this.ary(this.splat(a));
        v.items.push(...this.splat(b));
        push(v);
        info.desc = this.tr(`配列を連結して ${truncate(I(v), 40)} を積む`, `Concatenate arrays and push ${truncate(I(v), 40)}`);
        return;
      }
      case "pushtoarray": {
        const n = num(ops[0]);
        const vals: Value[] = [];
        for (let i = 0; i < n; i++) vals.unshift(pop());
        const a = pop() as AryO;
        a.items.push(...vals);
        push(a);
        info.desc = this.tr(`${n} 個の値を配列に追加`, `Append ${n} values to the array`);
        return;
      }
      case "splatarray": {
        const a = pop();
        const v = a.t === "array" ? (truthy(this.literal(ops[0])) ? this.ary([...a.items]) : a) : this.ary(this.splat(a));
        push(v);
        info.desc = this.tr(`*${truncate(I(a), 30)} を展開するために配列にする`, `Convert to an array to expand *${truncate(I(a), 30)}`);
        return;
      }
      case "splatkw": {
        const blk = pop();
        const h = pop();
        push(h.t === "nil" ? NIL : h);
        push(blk);
        info.desc = this.tr(`**${truncate(I(h), 30)} を展開するためにハッシュにする`, `Convert to a hash to expand **${truncate(I(h), 30)}`);
        return;
      }
      case "newhash": {
        const n = num(ops[0]);
        const vals: Value[] = [];
        for (let i = 0; i < n; i++) vals.unshift(pop());
        const h = this.hash();
        for (let i = 0; i < n; i += 2) this.hashSet(h, vals[i], vals[i + 1]);
        push(h);
        info.desc = this.tr(`上から ${n} 個 (キーと値 ${n / 2} 組) を取り出してハッシュ ${truncate(I(h), 40)} を作って積む`, `Pop ${n} values (${n / 2} key/value pairs) and push them as the hash ${truncate(I(h), 40)}`);
        return;
      }
      case "newrange": {
        const hi = pop();
        const lo = pop();
        const v = this.range(lo, hi, num(ops[0]) === 1);
        push(v);
        info.desc = this.tr(`範囲 ${I(v)} を作って積む`, `Create the range ${I(v)} and push it`);
        return;
      }

      // ── Stack operations ──
      case "pop": {
        const v = pop();
        info.desc = this.tr(`スタックトップの ${truncate(I(v), 30)} を捨てる`, `Discard ${truncate(I(v), 30)} on the top of the stack`);
        return;
      }
      case "dup": {
        const v = topn(0);
        push(v);
        info.desc = this.tr(`スタックトップの ${truncate(I(v), 30)} を複製して積む`, `Duplicate ${truncate(I(v), 30)} on the top of the stack`);
        return;
      }
      case "dupn": {
        const n = num(ops[0]);
        const vals: Value[] = [];
        for (let i = n - 1; i >= 0; i--) vals.push(topn(i));
        for (const v of vals) push(v);
        info.desc = this.tr(`上から ${n} 個の値を複製して積む`, `Duplicate the top ${n} values`);
        return;
      }
      case "swap": {
        const a = pop();
        const b = pop();
        push(a);
        push(b);
        info.desc = this.tr(`上 2 つ (${truncate(I(b), 16)} と ${truncate(I(a), 16)}) を入れ替える`, `Swap the top two values (${truncate(I(b), 16)} and ${truncate(I(a), 16)})`);
        return;
      }
      case "opt_reverse": {
        const n = num(ops[0]);
        const vals: Value[] = [];
        for (let i = 0; i < n; i++) vals.push(pop());
        for (const v of vals) push(v);
        info.desc = this.tr(`上から ${n} 個の値の並びを逆にする`, `Reverse the order of the top ${n} values`);
        return;
      }
      case "topn": {
        const n = num(ops[0]);
        const v = topn(n);
        push(v);
        info.desc = this.tr(`上から ${n} 番目の値 ${truncate(I(v), 30)} を複製して積む`, `Push a copy of the value ${truncate(I(v), 30)}, ${n} below the top`);
        return;
      }
      case "setn": {
        const n = num(ops[0]);
        const v = topn(0);
        S[f.sp - 1 - n] = v;
        info.desc = this.tr(`スタックトップの ${truncate(I(v), 30)} を、上から ${n} 番目にも書き込む`, `Also write the top value ${truncate(I(v), 30)} to the slot ${n} below the top`);
        return;
      }
      case "adjuststack": {
        const n = num(ops[0]);
        for (let i = 0; i < n; i++) pop();
        info.desc = this.tr(`上から ${n} 個の値を捨てる`, `Discard the top ${n} values`);
        return;
      }

      // ── Other ──
      case "defined": {
        const type = num(ops[0]);
        const obj = this.literal(ops[1]);
        const pushval = this.literal(ops[2]);
        const v = pop();
        let ok = false;
        switch (type) {
          case 2: // ivar
            ok = this.ivars(f.self).has((obj as any).name);
            break;
          case 4: // gvar
            ok = this.globals.has((obj as any).name);
            break;
          case 5: // cvar
            ok = this.cvarDefined(this.cvarBase(f), (obj as any).name);
            break;
          case 6: // const
            ok = this.constDefined(v.t === "class" ? v : f.env!.cref, (obj as any).name);
            break;
          case 7: // method
            ok = this.respondTo(v, (obj as any).name);
            break;
          case 8: // yield
            ok = this.localEnv(f.env!).block.t === "proc";
            break;
          case 9: // zsuper
            ok = !!f.env!.me && !!this.findMethod(this.classOf(f.self), f.env!.me.name, f.env!.me.owner);
            break;
          case 16: // func
            ok = this.respondTo(f.self, (obj as any).name);
            break;
          default:
            ok = true;
        }
        const r = ok ? pushval : NIL;
        push(r);
        info.desc = this.tr(`defined? の結果 ${I(r)} を積む`, `Push the result of defined?, ${I(r)}`);
        return;
      }
      case "definedivar": {
        const id = (ops[0] as any).v as string;
        const r = this.ivars(f.self).has(id) ? this.literal(ops[2]) : NIL;
        push(r);
        info.desc = this.tr(`defined?(${id}) の結果 ${I(r)} を積む`, `Push the result of defined?(${id}), ${I(r)}`);
        return;
      }
      case "checkmatch": {
        const flag = num(ops[0]);
        const type = flag & 3;
        const pattern = pop();
        const target = pop();
        const pats = flag & 4 ? this.splat(pattern) : [pattern];
        if (type === 1) {
          // when (without a case target)
          const r = pats.find((p) => truthy(p)) ?? FALSE;
          push(r);
          info.desc = this.tr(`条件 ${I(r)} を積む`, `Push the condition ${I(r)}`);
          return;
        }
        if (type === 3) {
          for (const p of pats) if (p.t !== "class") this.error("TypeError", "class or module required for rescue clause");
        }
        // For a builtin ===, decide directly in the VM
        if (pats.every((p) => !this.hasUserMethod(p, "==="))) {
          let ok = false;
          for (const p of pats) if (this.builtinCaseEq(p, target)) ok = true;
          push(bool(ok));
          info.desc = this.tr(`${pats.map((p) => truncate(I(p), 20)).join(", ")} === ${truncate(I(target), 24)} を調べて ${ok} を積む`, `Check ${pats.map((p) => truncate(I(p), 20)).join(", ")} === ${truncate(I(target), 24)} and push ${ok}`);
          return;
        }
        const at = f.sp;
        S[at] = pats[0];
        S[at + 1] = target;
        f.sp = at + 2;
        const r = this.invoke(f, at, pats[0], "===", [target], null, NIL, { fcall: true });
        if (r) {
          S[f.sp++] = r.value;
          info.pushes.push(at);
        } else info.event = { type: "call", text: this.tr(`${I(pats[0])}.=== を呼び出す`, `call ${I(pats[0])}.===`) };
        info.desc = this.tr(`${truncate(I(pats[0]), 24)} === ${truncate(I(target), 24)} を調べる`, `Check ${truncate(I(pats[0]), 24)} === ${truncate(I(target), 24)}`);
        return;
      }
      case "checkkeyword": {
        const bitsIdx = num(ops[0]);
        const kwIdx = num(ops[1]);
        const bits = this.localGet(f.env!, bitsIdx);
        const given = !(bits.t === "int" && (Number(bits.v) & (1 << kwIdx)));
        push(bool(given));
        const kws = f.iseq!.params.keyword ?? [];
        const kwName = kws[kws.filter((k) => k.required).length + kwIdx]?.name ?? kwIdx;
        info.desc = this.tr(`キーワード引数 ${kwName} が${given ? "渡されている → true" : "渡されていない → false (デフォルト値を計算する)"}`, `Keyword argument ${kwName} ${given ? "was given → true" : "was not given → false (compute the default value)"}`);
        return;
      }
      case "checktype": {
        const type = num(ops[0]);
        const v = pop();
        const map: Record<number, string> = { 5: "str", 7: "array", 8: "hash", 0x14: "sym" };
        const r = bool(map[type] === v.t);
        push(r);
        info.desc = this.tr(`型を調べて ${I(r)} を積む`, `Check the type and push ${I(r)}`);
        return;
      }

      // ── Definitions ──
      case "defineclass": {
        const id = (ops[0] as any).v as string;
        const body = this.program.iseqs[(ops[1] as any).i];
        const flags = num(ops[2]);
        const sup = pop();
        const cbase = pop();
        const type = flags & 7;
        let cls: ClassO;
        let what: string;
        if (type === 1) {
          cls = this.singletonClass(cbase);
          what = this.tr(`${I(cbase)} の特異クラス`, `the singleton class of ${I(cbase)}`);
        } else {
          const base = cbase.t === "class" ? cbase : f.env!.cref;
          const target = base.attached && base.attached.t === "class" ? base.attached : base;
          const existing = target.consts.get(id) ?? (target === this.object || flags & 8 ? undefined : this.lookupLexicalOnly(target, id));
          if (existing && existing.t === "class") {
            cls = existing;
            if (type === 0 && sup.t === "class" && cls.superclass && this.realSuper(cls) !== sup) this.error("TypeError", `superclass mismatch for class ${id}`);
            what = this.tr(`既存の${type === 2 ? "モジュール" : "クラス"} ${cls.name} を再オープン`, `Reopen the existing ${type === 2 ? "module" : "class"} ${cls.name}`);
          } else {
            if (type === 0 && sup.t !== "nil" && sup.t !== "class") this.error("TypeError", "superclass must be a Class");
            const fullName = target === this.object ? id : `${target.name}::${id}`;
            cls = this.newClass(fullName, type === 2 ? null : sup.t === "class" ? sup : this.object, type === 2, target);
            target.consts.set(id, cls);
            if (type === 0 && sup.t === "class") {
              const inh = this.findMethod(this.singletonClass(sup), "inherited");
              if (inh && !inh.native) {
                /* the inherited hook is omitted */
              }
            }
            what = this.tr(`新しい${type === 2 ? "モジュール" : "クラス"} ${cls.name} を作成`, `Create a new ${type === 2 ? "module" : "class"} ${cls.name}`);
          }
        }
        const at = f.sp;
        this.pushIseqFrame({
          kind: "class",
          iseq: body,
          retSlot: at,
          localStart: at,
          recvSlot: null,
          self: cls,
          locals: new Array(body.localSize).fill(NIL),
          prev: null,
          block: NIL,
          me: null,
          cref: cls,
          lambda: false,
          label: body.label,
          pc: 0,
        });
        info.desc = this.tr(`${what}し、クラス本体「${body.label}」を新しいフレームで実行する`, `${what}, then run the class body "${body.label}" in a new frame`);
        info.event = { type: "call", text: this.tr(`${body.label} を実行`, `run ${body.label}`) };
        return;
      }
      case "definemethod": {
        const id = (ops[0] as any).v as string;
        const body = this.program.iseqs[(ops[1] as any).i];
        const cref = f.env!.cref;
        const target = f.kind === "method" || this.localEnv(f.env!).iseq.type === "method" ? cref : cref;
        target.methods.set(id, { owner: target, name: id, iseq: body, visibility: (target as any).__defaultPrivate ? "private" : undefined });
        info.desc = this.tr(`${target === this.object ? "Object" : target.name} にメソッド ${id} を定義 (本体は iseq「${body.label}」)`, `Define method ${id} on ${target === this.object ? "Object" : target.name} (its body is the iseq "${body.label}")`);
        return;
      }
      case "definesmethod": {
        const id = (ops[0] as any).v as string;
        const body = this.program.iseqs[(ops[1] as any).i];
        const obj = pop();
        const s = this.singletonClass(obj);
        s.methods.set(id, { owner: s, name: id, iseq: body });
        info.desc = this.tr(`${truncate(I(obj), 24)} の特異メソッド ${id} を定義`, `Define singleton method ${id} on ${truncate(I(obj), 24)}`);
        return;
      }

      // ── Method calls ──
      case "send":
      case "opt_send_without_block": {
        const cd = ops[0] as CallData;
        const blockIseq = name === "send" && ops[1].t === "iseq" ? this.program.iseqs[ops[1].i] : null;
        this.sendCD(f, cd, blockIseq, info);
        return;
      }
      case "invokesuper": {
        const cd = ops[0] as CallData;
        const blockIseq = ops[1].t === "iseq" ? this.program.iseqs[ops[1].i] : null;
        this.sendCD(f, cd, blockIseq, info, true);
        return;
      }
      case "sendforward":
      case "invokesuperforward":
        throw new VMError(this.tr(`引数の転送 (...) にはまだ対応していません (${name})`, `Argument forwarding (...) is not supported yet (${name})`));
      case "invokeblock": {
        const cd = ops[0] as CallData;
        const blk = this.localEnv(f.env!).block;
        if (blk.t !== "proc") this.error("LocalJumpError", "no block given (yield)");
        const { args, argv } = this.popArgs(f, cd, info);
        f.sp = argv;
        const r = this.callProc(f, argv, argv, blk, args, NIL);
        info.desc = this.tr(`yield: 渡されたブロック「${blk.iseq?.label ?? "組み込み"}」を引数 (${args.map((a) => truncate(I(a), 14)).join(", ")}) で呼び出す`, `yield: call the given block "${blk.iseq?.label ?? "builtin"}" with arguments (${args.map((a) => truncate(I(a), 14)).join(", ")})`);
        if (r) {
          S[f.sp++] = r.value;
          info.pushes.push(argv);
          info.desc += ` → ${truncate(I(r.value), 24)}`;
        } else info.event = { type: "call", text: this.tr(`ブロック ${blk.iseq?.label} を実行`, `run block ${blk.iseq?.label}`) };
        return;
      }
      case "opt_new": {
        const cd = ops[0] as CallData;
        const dst = (ops[1] as any).pc as number;
        const argc = cd.argc;
        const klass = topn(argc);
        const m = klass.t === "class" ? this.findMethod(this.classOf(klass), "new") : undefined;
        if (klass.t === "class" && m === this.classes.Class.methods.get("new") && !klass.isModule && this.plainAllocatable(klass)) {
          const obj = this.newObject(klass);
          S[f.sp - argc - 1] = obj;
          S[f.sp - argc - 2] = obj;
          info.desc = this.tr(`${klass.name}.new が再定義されていないので、ここでオブジェクト ${I(obj)} を確保し、続けて initialize を呼ぶ`, `${klass.name}.new is not redefined, so allocate the object ${I(obj)} here and then call initialize`);
          return;
        }
        jump(dst);
        info.desc = this.tr(`new が特別なので、${pad4(dst)} へ飛んで普通に new を呼ぶ`, `new is special, so jump to ${pad4(dst)} and call new normally`);
        return;
      }
      case "opt_duparray_send": {
        const ary = this.dupValue(this.literal(ops[0]));
        const mid = (ops[1] as any).v as string;
        const argc = num(ops[2]);
        const args: Value[] = [];
        for (let i = 0; i < argc; i++) args.unshift(pop());
        const at = f.sp;
        S[at] = ary;
        args.forEach((a, i) => (S[at + 1 + i] = a));
        f.sp = at + 1 + argc;
        const r = this.invoke(f, at, ary, mid, args, null, NIL);
        if (r) {
          S[f.sp++] = r.value;
          info.pushes.push(at);
        }
        info.desc = this.tr(`配列リテラル ${truncate(I(ary), 24)}.${mid}(${args.map((a) => truncate(I(a), 12)).join(", ")}) を計算${r ? ` → ${I(r.value)}` : ""}`, `Compute the array literal ${truncate(I(ary), 24)}.${mid}(${args.map((a) => truncate(I(a), 12)).join(", ")})${r ? ` → ${I(r.value)}` : ""}`);
        return;
      }
      case "opt_newarray_send": {
        const n = num(ops[0]);
        const method = num(ops[1]);
        const vals: Value[] = [];
        for (let i = 0; i < n; i++) vals.unshift(pop());
        const mid = { 1: "max", 2: "min", 3: "hash", 6: "include?" }[method];
        if (!mid) throw new VMError(this.tr(`未対応の opt_newarray_send: ${method}`, `Unsupported opt_newarray_send: ${method}`));
        const recv = this.ary(method === 6 ? vals.slice(0, -1) : vals);
        const args = method === 6 ? [vals[vals.length - 1]] : [];
        const at = f.sp;
        S[at] = recv;
        f.sp = at + 1;
        const r = this.invoke(f, at, recv, mid, args, null, NIL);
        if (r) {
          S[f.sp++] = r.value;
          info.pushes.push(at);
        }
        info.desc = this.tr(`配列を作らずに [${vals.map((v) => truncate(I(v), 10)).join(", ")}].${mid} を計算${r ? ` → ${I(r.value)}` : ""}`, `Compute [${vals.map((v) => truncate(I(v), 10)).join(", ")}].${mid} without creating the array${r ? ` → ${I(r.value)}` : ""}`);
        return;
      }
      case "leave": {
        const v = pop();
        const label = f.label;
        if (this.frames.length === 1) {
          this.popFrame(f);
          this.halted = true;
          this.result = v;
          info.desc = this.tr(`トップレベルの実行が終わり、VM を終了する (結果 ${truncate(I(v), 24)})`, `The top level has finished, so the VM stops (result ${truncate(I(v), 24)})`);
          info.event = { type: "halt", text: this.tr("プログラムの実行が終わりました", "The program has finished") };
          return;
        }
        if (f.kind === "rescue" || f.kind === "ensure") this.errinfo = NIL;
        this.returnFrom(f, v);
        info.desc = this.tr(`${label} を終えて、戻り値 ${truncate(I(v), 30)} を呼び出し元のスタックに積む`, `Finish ${label} and push the return value ${truncate(I(v), 30)} onto the caller's stack`);
        info.event = { type: "return", text: this.tr(`${label} から戻る → ${truncate(I(v), 30)}`, `return from ${label} → ${truncate(I(v), 30)}`) };
        return;
      }
      case "throw": {
        const op = num(ops[0]);
        const state = op & 0xff;
        const flag = op & 0x8000;
        const v = pop();
        if (state === 0) {
          // Re-raise (the exception or escape information held in $!)
          const td = this.throwDataOf(v);
          if (td) {
            info.desc = this.tr(`ensure 節が終わったので、中断していた ${TAG_NAME[td.state]} を続ける`, `The ensure clause has finished, so resume the interrupted ${TAG_NAME[td.state]}`);
            this.handleThrow(td, info);
            return;
          }
          if (v.t === "nil") {
            info.desc = this.tr("何もしない", "Do nothing");
            return;
          }
          info.desc = this.tr(`例外 ${truncate(I(v), 40)} を再送出する`, `Re-raise the exception ${truncate(I(v), 40)}`);
          if (!info.event) info.event = { type: "raise", text: this.tr(`${truncate(I(v), 40)} を再送出`, `re-raise ${truncate(I(v), 40)}`) };
          this.raise(v as ObjO, info);
          return;
        }
        const td = this.throwStart(f, state, flag, v);
        info.desc = this.tr(`${TAG_NAME[td.state]} (値 ${truncate(I(v), 24)}) でフレームをまたいで脱出する`, `Escape across frames with ${TAG_NAME[td.state]} (value ${truncate(I(v), 24)})`);
        this.handleThrow(td, info);
        return;
      }

      // ── Branches ──
      case "jump": {
        const dst = (ops[0] as any).pc as number;
        jump(dst);
        info.desc = this.tr(`${pad4(dst)} へジャンプ`, `Jump to ${pad4(dst)}`);
        return;
      }
      case "branchif":
      case "branchunless":
      case "branchnil": {
        const dst = (ops[0] as any).pc as number;
        const v = pop();
        const go = name === "branchif" ? truthy(v) : name === "branchunless" ? !truthy(v) : v.t === "nil";
        if (go) jump(dst);
        const cond = name === "branchif" ? this.tr("真", "truthy") : name === "branchunless" ? this.tr("偽", "falsy") : "nil";
        info.desc = this.tr(`${truncate(I(v), 24)} を取り出す → ${cond}${go ? "なので" : "ではないので"} ${go ? `${pad4(dst)} へジャンプ` : "次の命令へ"}`, `Pop ${truncate(I(v), 24)} → it is ${go ? "" : "not "}${cond}, so ${go ? `jump to ${pad4(dst)}` : "go to the next instruction"}`);
        return;
      }
      case "opt_case_dispatch": {
        const table = (ops[0] as any).v as [Operand, number][];
        const elseDst = (ops[1] as any).pc as number;
        const key = pop();
        const ok = ["int", "float", "sym", "str", "nil", "true", "false"].includes(key.t) && !this.hasUserMethod(key, "===");
        if (!ok) {
          info.desc = this.tr(`${truncate(I(key), 24)} は表引きできない型なので、続く when の比較を順に行う`, `${truncate(I(key), 24)} cannot be looked up in the table, so fall through to the when comparisons`);
          return;
        }
        const k = hashKey(key.t === "float" && Number.isInteger(key.v) ? int(key.v) : key);
        const hit = table.find(([lit]) => hashKey(this.literal(lit)) === k);
        const dst = hit ? hit[1] : elseDst;
        jump(dst);
        info.desc = hit ? this.tr(`表を引くと ${I(key)} に一致する when があるので ${pad4(dst)} へジャンプ`, `The table has a when matching ${I(key)}, so jump to ${pad4(dst)}`) : this.tr(`${I(key)} はどの when にも一致しないので ${pad4(dst)} (else) へジャンプ`, `${I(key)} matches no when, so jump to ${pad4(dst)} (else)`);
        return;
      }
      case "once":
        throw new VMError(this.tr("once 命令にはまだ対応していません", "The once instruction is not supported yet"));

      default:
        if (name.startsWith("opt_")) {
          this.optInsn(f, insn, info);
          return;
        }
        throw new VMError(this.tr(`未対応の命令です: ${name}`, `Unsupported instruction: ${name}`));
    }
  }

  /** Specialized instructions such as opt_plus. Compute directly in the VM for builtin types, otherwise make a normal method call */
  private optInsn(f: Frame, insn: Insn, info: StepInfo) {
    const S = this.stack;
    const cd = insn.ops[insn.name === "opt_neq" ? 1 : 0] as CallData;
    const argc = cd.argc;
    const I = (v: Value) => truncate(this.inspect(v), 24);
    const recv = this.val(f.sp - 1 - argc);
    const args: Value[] = [];
    for (let i = 0; i < argc; i++) args.push(this.val(f.sp - argc + i));
    const mid = cd.mid!;
    const fast = this.fastPath(insn.name, mid, recv, args);
    if (fast !== undefined) {
      for (let i = 0; i <= argc; i++) info.pops.push(f.sp - 1 - i);
      f.sp -= argc + 1;
      info.pushes.push(f.sp);
      S[f.sp++] = fast;
      const expr = argc === 0 ? `${I(recv)}.${mid}` : argc === 1 && /^[^a-z]/i.test(mid) && mid !== "[]" ? `${I(recv)} ${mid} ${I(args[0])}` : `${I(recv)}[${args.map(I).join(", ")}]${mid === "[]=" ? "=" : ""}`;
      info.desc = this.tr(`${mid === "!" ? `!${I(recv)}` : expr} = ${I(fast)} (${builtinClassName(recv)} なので、メソッドを呼ばずに VM の中で直接計算)`, `${mid === "!" ? `!${I(recv)}` : expr} = ${I(fast)} (${builtinClassName(recv)}, so it is computed directly in the VM without a method call)`);
      return;
    }
    this.sendCD(f, cd, null, info);
    info.desc = this.tr(`${builtinClassName(recv) === "Object" ? "" : ""}高速パスが使えないので、普通のメソッド呼び出しとして ${I(recv)}.${mid} を呼ぶ`, `The fast path does not apply, so call ${I(recv)}.${mid} as a normal method call`) + (info.desc ? ` → ${info.desc}` : "");
  }

  private fastPath(insn: string, mid: string, recv: Value, args: Value[]): Value | undefined {
    if (this.hasUserMethod(recv, mid)) return undefined;
    if (isHeap(recv) && (recv as any).cls && !(recv as any).cls.attached) return undefined;
    const [a] = args;
    const numeric = (v: Value | undefined) => !!v && (v.t === "int" || v.t === "float");
    switch (insn) {
      case "opt_plus":
      case "opt_minus":
      case "opt_mult":
      case "opt_div":
      case "opt_mod":
      case "opt_lt":
      case "opt_le":
      case "opt_gt":
      case "opt_ge":
        if (numeric(recv) && numeric(a)) {
          if (recv.t === "int" && a.t === "int") return intBinop(this, mid, recv.v, a.v);
          return floatBinop(mid, Number((recv as any).v), Number((a as any).v));
        }
        if (insn === "opt_plus" && recv.t === "str" && a?.t === "str") return this.str(recv.s + a.s);
        if (insn === "opt_plus" && recv.t === "array" && a?.t === "array") return this.ary([...recv.items, ...a.items]);
        return undefined;
      case "opt_eq":
      case "opt_neq": {
        let r: boolean | undefined;
        if (numeric(recv) && numeric(a)) r = Number((recv as any).v) === Number((a as any).v) && (recv.t !== "int" || a.t !== "int" || recv.v === (a as any).v);
        else if (recv.t === "str" && a?.t === "str") r = recv.s === a.s;
        else if (recv.t === "sym" || recv.t === "nil" || recv.t === "true" || recv.t === "false") r = recv === a;
        if (r === undefined) return undefined;
        return bool(insn === "opt_eq" ? r : !r);
      }
      case "opt_ltlt":
        if (recv.t === "array") {
          this.checkFrozen(recv);
          recv.items.push(a);
          return recv;
        }
        if (recv.t === "str" && a?.t === "str") {
          this.checkFrozen(recv);
          recv.s += a.s;
          return recv;
        }
        return undefined;
      case "opt_and":
      case "opt_or":
        if (recv.t === "int" && a?.t === "int") return int(insn === "opt_and" ? recv.v & a.v : recv.v | a.v);
        return undefined;
      case "opt_aref":
        if (recv.t === "array" && a?.t === "int") {
          let i = Number(a.v);
          if (i < 0) i += recv.items.length;
          return recv.items[i] ?? NIL;
        }
        if (recv.t === "hash" && recv.default.t === "nil" && !(recv as any).defaultProc) return this.hashGet(recv, a) ?? NIL;
        return undefined;
      case "opt_aset":
        if (recv.t === "array" && a?.t === "int" && Number(a.v) >= 0) {
          this.checkFrozen(recv);
          const i = Number(a.v);
          while (recv.items.length < i) recv.items.push(NIL);
          recv.items[i] = args[1];
          return args[1];
        }
        if (recv.t === "hash") {
          this.checkFrozen(recv);
          this.hashSet(recv, a, args[1]);
          return args[1];
        }
        return undefined;
      case "opt_length":
      case "opt_size":
        if (recv.t === "str") return int([...recv.s].length);
        if (recv.t === "array") return int(recv.items.length);
        if (recv.t === "hash") return int(recv.map.size);
        return undefined;
      case "opt_empty_p":
        if (recv.t === "str") return bool(recv.s.length === 0);
        if (recv.t === "array") return bool(recv.items.length === 0);
        if (recv.t === "hash") return bool(recv.map.size === 0);
        return undefined;
      case "opt_succ":
        if (recv.t === "int") return int(recv.v + 1n);
        if (recv.t === "str") return this.str(strSucc(recv.s));
        return undefined;
      case "opt_not":
        return bool(!truthy(recv));
      case "opt_nil_p":
        return bool(recv.t === "nil");
    }
    return undefined;
  }

  /** Takes the arguments off the stack (including splats and keyword arguments) */
  private popArgs(f: Frame, cd: CallData, info: StepInfo): { args: Value[]; kw: HashO | null; argv: number } {
    const flag = cd.flag;
    // orig_argc does not include the number of keyword argument values
    const argc = cd.argc + (cd.kw?.length ?? 0);
    const argv = f.sp - argc;
    const raw: Value[] = [];
    for (let i = 0; i < argc; i++) {
      raw.push(this.val(argv + i));
      info.pops.push(argv + i);
    }
    let kw: HashO | null = null;
    let positional = raw;
    if (flag & VM_CALL.KWARG && cd.kw) {
      const n = cd.kw.length;
      const vals = raw.slice(raw.length - n);
      positional = raw.slice(0, raw.length - n);
      kw = this.hash(cd.kw.map((k, i) => [sym(k), vals[i]]));
    } else if (flag & VM_CALL.KW_SPLAT) {
      const h = positional[positional.length - 1];
      positional = positional.slice(0, -1);
      if (h && h.t === "hash") {
        kw = this.hash();
        for (const [k, v] of h.map.values()) this.hashSet(kw, k, v);
      }
    }
    if (flag & VM_CALL.ARGS_SPLAT) {
      const last = positional[positional.length - 1];
      positional = [...positional.slice(0, -1), ...this.splat(last ?? NIL)];
    }
    return { args: positional, kw, argv };
  }

  /** Common handling for send / opt_send_without_block / invokesuper */
  private sendCD(f: Frame, cd: CallData, blockIseq: Iseq | null, info: StepInfo, isSuper = false) {
    const S = this.stack;
    const flag = cd.flag;
    const I = (v: Value) => truncate(this.inspect(v), 24);
    let blk: Value = NIL;
    if (flag & VM_CALL.ARGS_BLOCKARG) {
      const i = --f.sp;
      info.pops.push(i);
      blk = this.toBlock(this.val(i));
    } else if (blockIseq) {
      blk = this.captureBlock(f, blockIseq);
    }
    const { args, kw, argv } = this.popArgs(f, cd, info);
    const recvSlot = argv - 1;
    let recv = this.val(recvSlot);
    info.pops.push(recvSlot);
    let mid = cd.mid ?? "";
    let superFrom: ClassO | null | undefined;
    if (isSuper) {
      const me = f.env!.me ?? this.localEnv(f.env!).me;
      if (!me) this.error("RuntimeError", "super called outside of method");
      mid = me.name;
      superFrom = me.owner;
      recv = f.self;
      if (blk.t === "nil" && !blockIseq && !(flag & VM_CALL.ARGS_BLOCKARG)) blk = this.localEnv(f.env!).block;
    }
    const callText = this.tr(`${isSuper ? "super" : `${I(recv)}.${mid}`}(${args.map(I).join(", ")}${kw && kw.map.size ? (args.length ? ", " : "") + [...kw.map.values()].map(([k, v]) => `${this.toS(k)}: ${I(v)}`).join(", ") : ""})${blk.t === "proc" ? (blockIseq ? " { ブロック }" : " &blk") : ""}`, " { block }");
    const r = this.invoke(f, recvSlot, recv, mid, args, kw, blk, { fcall: !!(flag & VM_CALL.FCALL) || isSuper, vcall: !!(flag & VM_CALL.VCALL), superFrom });
    if (r) {
      f.sp = recvSlot;
      S[f.sp++] = r.value;
      info.pushes.push(recvSlot);
      info.desc = this.tr(`${callText} を呼ぶ (組み込みメソッドなのでその場で実行) → 戻り値 ${I(r.value)} を積む`, `Call ${callText} (a builtin method, so it runs right here) → push the return value ${I(r.value)}`);
      return;
    }
    const callee = this.top();
    if (callee.kind === "cfunc") {
      info.desc = this.tr(`${callText} を呼ぶ (組み込みメソッド。ブロックを呼ぶので CFUNC フレームを積む)`, `Call ${callText} (a builtin method that calls a block, so push a CFUNC frame)`);
      info.event = { type: "call", text: this.tr(`${callee.label} を呼び出し`, `call ${callee.label}`) };
      return;
    }
    const nargs = args.length;
    info.desc = this.tr(`${callText} を呼ぶ: 新しいフレームを積み、${nargs ? `積まれていた引数 ${nargs} 個がそのまま呼び出し先のローカル変数になる` : "呼び出し先の命令列へ移る"}`, `Call ${callText}: push a new frame; ${nargs ? `the ${nargs} pushed argument(s) become the callee's local variables as is` : "move to the callee's instructions"}`);
    info.event = { type: "call", text: this.tr(`${callee.label} を呼び出し`, `call ${callee.label}`) };
  }

  private plainAllocatable(c: ClassO): boolean {
    const anc = this.ancestors(c);
    const C = this.classes;
    return ![C.String, C.Array, C.Hash, C.Proc, C.Integer, C.Float, C.Symbol, C.Range, C.NilClass, C.TrueClass, C.FalseClass, C.Class, C.Module].some((b) => anc.includes(b));
  }

  private realSuper(c: ClassO): ClassO | null {
    let s = c.superclass;
    while (s && s.attached) s = s.superclass;
    return s;
  }

  private lookupLexicalOnly(c: ClassO, name: string): Value | undefined {
    void c;
    void name;
    return undefined;
  }

  builtinCaseEq(pattern: Value, target: Value): boolean {
    if (pattern.t === "class") return this.isKindOf(target, pattern);
    if (pattern.t === "range") {
      const lo = pattern.first;
      const hi = pattern.last;
      const cmp = (a: Value, b: Value) => {
        if ((a.t === "int" || a.t === "float") && (b.t === "int" || b.t === "float")) return Number((a as any).v) - Number((b as any).v);
        if (a.t === "str" && b.t === "str") return a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
        return NaN;
      };
      if (lo.t !== "nil" && !(cmp(lo, target) <= 0)) return false;
      if (hi.t !== "nil") {
        const c = cmp(target, hi);
        if (!(pattern.excl ? c < 0 : c <= 0)) return false;
      }
      return true;
    }
    if (pattern.t === "proc") return false;
    if ((pattern.t === "int" || pattern.t === "float") && (target.t === "int" || target.t === "float")) return Number(pattern.v) === Number((target as any).v);
    if (pattern.t === "str") return target.t === "str" && target.s === pattern.s;
    if (pattern.t === "array" && target.t === "array") return hashKey(pattern) === hashKey(target);
    if (isHeap(pattern)) return pattern === target;
    return pattern === target;
  }

  // ───────────────────────── Helpers ─────────────────────────

  splat(v: Value): Value[] {
    if (v.t === "array") return [...v.items];
    if (v.t === "nil") return [];
    if (v.t === "hash") return [...v.map.values()].map(([k, val]) => this.ary([k, val]));
    if (v.t === "range") return this.rangeToArray(v);
    return [v];
  }

  rangeToArray(r: RangeO): Value[] {
    if (r.first.t === "int" && (r.last.t === "int" || r.last.t === "float")) {
      const out: Value[] = [];
      const last = r.last.t === "int" ? r.last.v : BigInt(Math.floor(r.last.v));
      const end = r.excl && r.last.t === "int" ? last - 1n : last;
      if (end - r.first.v > 1000000n) this.error("RangeError", "range too large");
      for (let i = r.first.v; i <= end; i++) out.push(int(i));
      return out;
    }
    if (r.first.t === "str" && r.last.t === "str") {
      const out: Value[] = [];
      let s = r.first.s;
      for (let i = 0; i < 100000; i++) {
        if (r.excl && s === r.last.s) break;
        out.push(this.str(s));
        if (s === r.last.s || s.length > r.last.s.length) break;
        s = strSucc(s);
      }
      return out;
    }
    this.error("TypeError", `can't iterate from ${builtinClassName(r.first)}`);
  }

  ivars(v: Value): Map<string, Value> {
    if (v.t === "object" || v.t === "class") return v.ivars;
    if (isHeap(v)) {
      const h = v as any;
      if (!h.ivars) h.ivars = new Map();
      return h.ivars;
    }
    return new Map();
  }

  checkFrozen(v: Value) {
    if (isHeap(v) && v.frozen) this.error("FrozenError", `can't modify frozen ${builtinClassName(v)}: ${this.inspect(v)}`);
  }

  /** Where class variable lookup starts (cref; for a singleton class, the original class) */
  private cvarBase(f: Frame): ClassO {
    const c = f.env!.cref;
    return c.attached && c.attached.t === "class" ? c.attached : c;
  }

  cvarGet(cls: ClassO, name: string): Value {
    for (let c: ClassO | null = cls; c; c = c.superclass) {
      const v = c.cvars.get(name);
      if (v) return v;
    }
    this.error("NameError", `uninitialized class variable ${name} in ${cls.name}`);
  }
  cvarDefined(cls: ClassO, name: string): boolean {
    for (let c: ClassO | null = cls; c; c = c.superclass) if (c.cvars.has(name)) return true;
    return false;
  }
  cvarSet(cls: ClassO, name: string, v: Value) {
    for (let c: ClassO | null = cls; c; c = c.superclass) {
      if (c.cvars.has(name)) {
        c.cvars.set(name, v);
        return;
      }
    }
    cls.cvars.set(name, v);
  }

  constGet(cls: ClassO, name: string, scoped = false): Value {
    const v = this.constFind(cls, name, scoped);
    if (v) return v;
    this.error("NameError", `uninitialized constant ${scoped && cls !== this.object ? cls.name + "::" : ""}${name}`);
  }
  constDefined(cls: ClassO, name: string): boolean {
    return !!this.constFind(cls, name, false);
  }
  private constFind(cls: ClassO, name: string, scoped: boolean): Value | undefined {
    const start = cls.attached && cls.attached.t === "class" ? cls.attached : cls;
    if (!scoped) {
      for (let c: ClassO | undefined = start; c; c = c.outer) {
        const v = c.consts.get(name);
        if (v) return v;
      }
    }
    for (const c of this.ancestors(start)) {
      const v = c.consts.get(name);
      if (v) return v;
    }
    return this.object.consts.get(name);
  }
  constSet(cls: ClassO, name: string, v: Value) {
    const target = cls.attached && cls.attached.t === "class" ? cls.attached : cls;
    target.consts.set(name, v);
    if (v.t === "class" && v.name.startsWith("#<")) v.name = target === this.object ? name : `${target.name}::${name}`;
  }

  hasUserMethod(v: Value, mid: string): boolean {
    const m = this.findMethod(this.classOf(v), mid);
    return !!m && !m.native;
  }
}

// ───────────────────────── General functions ─────────────────────────

export function intBinop(vm: VM, op: string, a: bigint, b: bigint): Value {
  switch (op) {
    case "+":
      return int(a + b);
    case "-":
      return int(a - b);
    case "*":
      return int(a * b);
    case "/":
      if (b === 0n) vm.error("ZeroDivisionError", "divided by 0");
      return int(floorDiv(a, b));
    case "%":
      if (b === 0n) vm.error("ZeroDivisionError", "divided by 0");
      return int(floorMod(a, b));
    case "==":
      return bool(a === b);
    case "<":
      return bool(a < b);
    case "<=":
      return bool(a <= b);
    case ">":
      return bool(a > b);
    case ">=":
      return bool(a >= b);
  }
  throw new VMError(`unknown op ${op}`);
}

export function floatBinop(op: string, a: number, b: number): Value {
  switch (op) {
    case "+":
      return flo(a + b);
    case "-":
      return flo(a - b);
    case "*":
      return flo(a * b);
    case "/":
      return flo(a / b);
    case "%": {
      const m = a % b;
      return flo(m !== 0 && m < 0 !== b < 0 ? m + b : m);
    }
    case "==":
      return bool(a === b);
    case "<":
      return bool(a < b);
    case "<=":
      return bool(a <= b);
    case ">":
      return bool(a > b);
    case ">=":
      return bool(a >= b);
  }
  throw new VMError(`unknown op ${op}`);
}

export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}
export function floorMod(a: bigint, b: bigint): bigint {
  const m = a % b;
  return m !== 0n && m < 0n !== b < 0n ? m + b : m;
}

export function isGenerator(v: any): v is Generator<CallRequest, Value, Value> {
  return v && typeof v === "object" && typeof v.next === "function" && typeof v.throw === "function" && !("t" in v);
}

export function pad4(n: number) {
  return String(n).padStart(4, "0");
}

export function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function strSucc(s: string): string {
  if (s === "") return "";
  const chars = s.split("");
  let i = chars.length - 1;
  for (;;) {
    const ch = chars[i];
    if (ch === "z") chars[i] = "a";
    else if (ch === "Z") chars[i] = "A";
    else if (ch === "9") chars[i] = "0";
    else {
      chars[i] = String.fromCharCode(ch.charCodeAt(0) + 1);
      return chars.join("");
    }
    if (i === 0) {
      const first = ch === "z" ? "a" : ch === "Z" ? "A" : "1";
      return first + chars.join("");
    }
    i--;
  }
}
