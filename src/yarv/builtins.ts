// Builtin classes and methods: the parts CRuby writes in C (functions registered with rb_define_method).
// Methods that call blocks are written as generators; the VM runs each call request they yield as a frame.
// That way the body of a block passed to each or times can also be watched one instruction at a time.
import type { CallRequest, VM } from "./vm";
import { RubyError, floorDiv, floorMod, intBinop, floatBinop, isGenerator, strSucc } from "./vm";
import {
  AryO,
  ClassO,
  FALSE,
  HashO,
  NIL,
  ObjO,
  ProcO,
  RangeO,
  StrO,
  TRUE,
  Value,
  bool,
  flo,
  formatFloat,
  hashKey,
  inspectString,
  int,
  sym,
  truthy,
} from "./values";

type G<T = Value> = Generator<CallRequest, T, any>;
type Native = (vm: VM, self: any, args: Value[], blk: Value, kw: HashO | null) => any;

// ───────────────────────── Helpers ─────────────────────────

function* send(vm: VM, recv: Value, mid: string, args: Value[] = [], blk: Value = NIL): G {
  const m = vm.findMethod(vm.classOf(recv), mid);
  if (m && m.native && !(m as any).procCall) {
    const r = m.native(vm, recv, args, blk, null);
    if (isGenerator(r)) return yield* r as G;
    return r ?? NIL;
  }
  return yield { type: "send", recv, mid, args, blk };
}

function* callBlock(vm: VM, blk: Value, args: Value[]): G {
  if (blk.t !== "proc") vm.error("LocalJumpError", "no block given (yield)");
  const p = blk as ProcO;
  if (p.native) {
    const r = p.native(vm, p.self, args, NIL);
    if (isGenerator(r)) return yield* r as G;
    return r ?? NIL;
  }
  return yield { type: "proc", proc: p, args };
}

function* toS(vm: VM, v: Value): G<string> {
  if (v.t === "str") return v.s;
  if (vm.hasUserMethod(v, "to_s")) {
    const r = yield* send(vm, v, "to_s");
    return r.t === "str" ? r.s : vm.inspect(r);
  }
  return vm.toS(v);
}

function* inspect(vm: VM, v: Value, depth = 0): G<string> {
  if (vm.hasUserMethod(v, "inspect")) {
    const r = yield* send(vm, v, "inspect");
    return r.t === "str" ? r.s : vm.inspect(r);
  }
  if (depth < 4 && v.t === "array") {
    const parts: string[] = [];
    for (const x of v.items) parts.push(yield* inspect(vm, x, depth + 1));
    return "[" + parts.join(", ") + "]";
  }
  if (depth < 4 && v.t === "hash") {
    if (v.map.size === 0) return "{}";
    const parts: string[] = [];
    for (const [k, val] of v.map.values()) {
      const vs = yield* inspect(vm, val, depth + 1);
      if (k.t === "sym" && /^[A-Za-z_][A-Za-z0-9_]*[?!]?$/.test(k.name)) parts.push(`${k.name}: ${vs}`);
      else parts.push(`${yield* inspect(vm, k, depth + 1)} => ${vs}`);
    }
    return "{" + parts.join(", ") + "}";
  }
  return vm.inspect(v);
}

function eqSync(a: Value, b: Value): boolean | undefined {
  if ((a.t === "int" || a.t === "float") && (b.t === "int" || b.t === "float")) return Number((a as any).v) === Number((b as any).v) && (a.t === b.t || Number((a as any).v) === Number((b as any).v));
  if (a.t === "str" && b.t === "str") return a.s === b.s;
  if (a.t === "sym" || b.t === "sym" || a.t === "nil" || b.t === "nil" || a.t === "true" || a.t === "false") return a === b;
  if (a.t === "array" && b.t === "array") {
    if (a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) {
      const r = eqSync(a.items[i], b.items[i]);
      if (r === undefined) return undefined;
      if (!r) return false;
    }
    return true;
  }
  if (a.t === "hash" && b.t === "hash") return hashKeyed(a) === hashKeyed(b);
  if (a.t === "range" && b.t === "range") return a.excl === b.excl && eqSync(a.first, b.first) === true && eqSync(a.last, b.last) === true;
  if (a.t === "object" || b.t === "object") return undefined;
  return a === b;
}
function hashKeyed(h: HashO) {
  return [...h.map.entries()].map(([k, [, v]]) => k + "=" + hashKey(v)).sort().join(";");
}

function* eq(vm: VM, a: Value, b: Value): G<boolean> {
  if (!vm.hasUserMethod(a, "==")) {
    const r = eqSync(a, b);
    if (r !== undefined) return r;
    if (a.t !== "object") return a === b;
    if (!vm.findMethod(vm.classOf(a), "<=>")?.proc) return a === b;
  }
  return truthy(yield* send(vm, a, "==", [b]));
}

function cmpSync(a: Value, b: Value): number | undefined {
  if ((a.t === "int" || a.t === "float") && (b.t === "int" || b.t === "float")) {
    if (a.t === "int" && b.t === "int") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    const x = Number((a as any).v);
    const y = Number((b as any).v);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (a.t === "str" && b.t === "str") return a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
  if (a.t === "sym" && b.t === "sym") return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  if (a.t === "array" && b.t === "array") {
    for (let i = 0; i < Math.min(a.items.length, b.items.length); i++) {
      const r = cmpSync(a.items[i], b.items[i]);
      if (r === undefined) return undefined;
      if (r !== 0) return r;
    }
    return a.items.length - b.items.length;
  }
  return undefined;
}

function* cmp(vm: VM, a: Value, b: Value): G<number> {
  if (!vm.hasUserMethod(a, "<=>")) {
    const r = cmpSync(a, b);
    if (r !== undefined) return r;
  }
  const r = yield* send(vm, a, "<=>", [b]);
  if (r.t !== "int") vm.error("ArgumentError", `comparison of ${vm.realClassOf(a).name} with ${vm.inspect(b)} failed`);
  return Number(r.v);
}

function* mergeSort(vm: VM, items: Value[], compare: (a: Value, b: Value) => G<number>): G<Value[]> {
  if (items.length <= 1) return items;
  const mid = items.length >> 1;
  const l = yield* mergeSort(vm, items.slice(0, mid), compare);
  const r = yield* mergeSort(vm, items.slice(mid), compare);
  const out: Value[] = [];
  let i = 0;
  let j = 0;
  while (i < l.length && j < r.length) {
    if ((yield* compare(l[i], r[j])) <= 0) out.push(l[i++]);
    else out.push(r[j++]);
  }
  return out.concat(l.slice(i), r.slice(j));
}

function num(vm: VM, v: Value): number {
  if (v.t === "int") return Number(v.v);
  if (v.t === "float") return v.v;
  vm.error("TypeError", `${vm.realClassOf(v).name} can't be coerced into Float`);
}
function toInt(vm: VM, v: Value): bigint {
  if (v.t === "int") return v.v;
  if (v.t === "float") return BigInt(Math.trunc(v.v));
  if (v.t === "nil") vm.error("TypeError", "no implicit conversion from nil to integer");
  vm.error("TypeError", `no implicit conversion of ${vm.realClassOf(v).name} into Integer`);
}
function idx(vm: VM, v: Value): number {
  return Number(toInt(vm, v));
}
function str(vm: VM, v: Value): string {
  if (v.t === "str") return v.s;
  vm.error("TypeError", `no implicit conversion of ${vm.realClassOf(v).name} into String`);
}
/** Collects the elements of an Enumerable. For user-defined classes, calls each to gather them */
function* items(vm: VM, self: Value): G<Value[]> {
  if (self.t === "array") return [...self.items];
  if (self.t === "hash") return [...self.map.values()].map(([k, v]) => vm.ary([k, v]));
  if (self.t === "range") return vm.rangeToArray(self);
  const out: Value[] = [];
  const collector = vm.newProc(null, null, NIL, null, false);
  collector.native = (_vm: VM, _s: Value, args: Value[]) => {
    out.push(args.length === 1 ? args[0] : vm.ary(args));
    return NIL;
  };
  yield* send(vm, self, "each", [], collector);
  return out;
}

function enumFor(vm: VM, list: Value[]): AryO {
  // Calls without a block return an array instead of an Enumerator (a simplification)
  return vm.ary(list);
}

// ───────────────────────── printf ─────────────────────────

function* format(vm: VM, fmt: string, args: Value[]): G<string> {
  let out = "";
  let ai = 0;
  const re = /%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([sdifgeExXobpc%])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fmt))) {
    out += fmt.slice(last, m.index);
    last = re.lastIndex;
    const [, flags, widthS, precS, conv] = m;
    if (conv === "%") {
      out += "%";
      continue;
    }
    let width = widthS === "*" ? idx(vm, args[ai++]) : widthS ? parseInt(widthS) : 0;
    const prec = precS !== undefined ? parseInt(precS) : undefined;
    const arg = args[ai++] ?? vm.error("ArgumentError", "too few arguments");
    let s: string;
    switch (conv) {
      case "s":
        s = yield* toS(vm, arg);
        if (prec !== undefined) s = s.slice(0, prec);
        break;
      case "p":
        s = yield* inspect(vm, arg);
        break;
      case "d":
      case "i": {
        const n = arg.t === "float" ? BigInt(Math.floor(arg.v)) : arg.t === "str" ? BigInt(parseInt(arg.s)) : toInt(vm, arg);
        s = (n < 0n ? -n : n).toString();
        s = (n < 0n ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : "") + s;
        break;
      }
      case "f": {
        const n = num(vm, arg);
        s = n.toFixed(prec ?? 6);
        if (n >= 0 && flags.includes("+")) s = "+" + s;
        break;
      }
      case "e":
      case "E": {
        const n = num(vm, arg);
        s = n.toExponential(prec ?? 6).replace(/e([+-])(\d)$/, "e$10$2");
        if (conv === "E") s = s.toUpperCase();
        break;
      }
      case "g": {
        const n = num(vm, arg);
        s = String(Number(n.toPrecision(prec ?? 6)));
        break;
      }
      case "x":
      case "X":
      case "o":
      case "b": {
        const n = toInt(vm, arg);
        const base = conv === "o" ? 8 : conv === "b" ? 2 : 16;
        s = (n < 0n ? "-" : "") + (n < 0n ? -n : n).toString(base);
        if (conv === "X") s = s.toUpperCase();
        if (flags.includes("#")) s = (conv === "o" ? "0" : conv === "b" ? "0b" : "0x") + s;
        break;
      }
      case "c":
        s = arg.t === "int" ? String.fromCodePoint(Number(arg.v)) : (yield* toS(vm, arg)).slice(0, 1);
        break;
      default:
        s = "";
    }
    if (s.length < width) {
      if (flags.includes("-")) s = s.padEnd(width);
      else if (flags.includes("0") && "difeExXob".includes(conv)) {
        const sign = /^[+\- ]/.test(s) ? s[0] : "";
        s = sign + s.slice(sign.length).padStart(width - sign.length, "0");
      } else s = s.padStart(width);
    }
    out += s;
  }
  return out + fmt.slice(last);
}

// ───────────────────────── Installation ─────────────────────────

export function installBuiltins(vm: VM) {
  const C = vm.classes;
  const mk = (name: string, sup: ClassO | null, isModule = false) => {
    const c = vm.newClass(name, sup, isModule);
    C[name] = c;
    return c;
  };
  const BasicObject = mk("BasicObject", null);
  const Object = mk("Object", BasicObject);
  const Module = mk("Module", Object);
  const Class = mk("Class", Module);
  const Kernel = mk("Kernel", null, true);
  const Comparable = mk("Comparable", null, true);
  const Enumerable = mk("Enumerable", null, true);
  Object.includes.push(Kernel);
  const NilClass = mk("NilClass", Object);
  const TrueClass = mk("TrueClass", Object);
  const FalseClass = mk("FalseClass", Object);
  const Numeric = mk("Numeric", Object);
  Numeric.includes.push(Comparable);
  const Integer = mk("Integer", Numeric);
  const Float = mk("Float", Numeric);
  const Symbol = mk("Symbol", Object);
  const String = mk("String", Object);
  String.includes.push(Comparable);
  const Array = mk("Array", Object);
  Array.includes.push(Enumerable);
  const Hash = mk("Hash", Object);
  Hash.includes.push(Enumerable);
  const Range = mk("Range", Object);
  Range.includes.push(Enumerable);
  const Proc = mk("Proc", Object);
  const MathM = mk("Math", null, true);
  const Exception = mk("Exception", Object);
  const StandardError = mk("StandardError", Exception);
  const exc = (name: string, sup: ClassO) => mk(name, sup);
  const RuntimeError = exc("RuntimeError", StandardError);
  exc("ArgumentError", StandardError);
  exc("TypeError", StandardError);
  const NameError = exc("NameError", StandardError);
  exc("NoMethodError", NameError);
  exc("ZeroDivisionError", StandardError);
  const IndexError = exc("IndexError", StandardError);
  exc("KeyError", IndexError);
  exc("StopIteration", IndexError);
  const RangeError = exc("RangeError", StandardError);
  exc("FloatDomainError", RangeError);
  exc("LocalJumpError", StandardError);
  exc("FrozenError", RuntimeError);
  exc("NotImplementedError", StandardError);
  exc("NoMatchingPatternError", StandardError);
  exc("SystemStackError", Exception);
  exc("ScriptError", Exception);
  // Internal classes (not registered as constants): throw data, and the VM core pushed by putspecialobject 1
  C.__Throw = vm.newClass("THROW_DATA", BasicObject);
  const Core = vm.newClass("FrozenCore", BasicObject);
  C.__Core = Core;
  for (const c of globalThis.Object.values(C)) if (!c.name.match(/^(THROW_DATA|FrozenCore)$/)) Object.consts.set(c.name, c);
  MathM.consts.set("PI", flo(Math.PI));
  MathM.consts.set("E", flo(Math.E));
  Float.consts.set("INFINITY", flo(Infinity));
  Float.consts.set("NAN", flo(NaN));
  Float.consts.set("EPSILON", flo(Number.EPSILON));
  Integer.consts.set("MAX", int(2n ** 63n - 1n));
  Object.consts.set("RUBY_VERSION", vm.str(vm.program.ruby));
  Object.consts.set("RUBY_ENGINE", vm.str("ruby"));

  const def = (cls: ClassO, names: string | string[], fn: Native) => {
    for (const n of typeof names === "string" ? [names] : names) vm.defineNative(cls, n, fn);
  };
  const sdef = (cls: ClassO, names: string | string[], fn: Native) => {
    const s = vm.singletonClass(cls);
    for (const n of typeof names === "string" ? [names] : names) vm.defineNative(s, n, fn);
  };
  const out = (text: string) => {
    const last = vm.output[vm.output.length - 1];
    if (last && last.kind === "out") last.text += text;
    else vm.output.push({ text, kind: "out" });
  };

  // ── BasicObject / Kernel ──
  def(BasicObject, "initialize", () => NIL);
  def(BasicObject, ["==", "equal?"], (_vm, self, [o]) => bool(self === o || eqSync(self, o) === true && self.t !== "object"));
  def(BasicObject, "!", (_vm, self) => bool(!truthy(self)));
  def(BasicObject, "!=", function* (vm, self, [o]) {
    return bool(!(yield* eq(vm, self, o)));
  });
  def(BasicObject, "__id__", (_vm, self) => int(self.id ?? 0));
  def(BasicObject, "instance_eval", function* (vm, self, _args, blk) {
    if (blk.t !== "proc") vm.error("ArgumentError", "no block given");
    return (yield { type: "proc", proc: blk as ProcO, args: [self], self }) as Value;
  });

  def(Kernel, "puts", function* (vm, _self, args) {
    if (args.length === 0) out("\n");
    const emit = function* (v: Value, depth: number): G<void> {
      if (v.t === "array" && depth < 10) {
        if (v.items.length === 0 && depth === 0) out("\n");
        for (const x of v.items) yield* emit(x, depth + 1);
        return;
      }
      const s = yield* toS(vm, v);
      out(s.endsWith("\n") ? s : s + "\n");
    };
    for (const a of args) yield* emit(a, 0);
    return NIL;
  });
  def(Kernel, "print", function* (vm, _self, args) {
    for (const a of args) out(yield* toS(vm, a));
    return NIL;
  });
  def(Kernel, ["p", "pp"], function* (vm, _self, args) {
    for (const a of args) out((yield* inspect(vm, a)) + "\n");
    return args.length === 0 ? NIL : args.length === 1 ? args[0] : vm.ary(args);
  });
  def(Kernel, ["raise", "fail"], function* (vm, _self, args) {
    let e: Value;
    if (args.length === 0) {
      e = vm.errinfo.t !== "nil" ? vm.errinfo : vm.makeError("RuntimeError", "unhandled exception");
    } else if (args[0].t === "str") {
      e = vm.makeError("RuntimeError", args[0].s);
    } else if (args[0].t === "class") {
      e = yield* send(vm, args[0], "new", args.slice(1, 2));
    } else {
      e = args[0];
      if (args[1]) (e as ObjO).ivars.set("__mesg", args[1]);
    }
    if (!vm.isException(e)) vm.error("TypeError", "exception class/object expected");
    throw new RubyError(e as ObjO);
  });
  def(Kernel, "loop", function* (vm, self, _args, blk) {
    if (blk.t !== "proc") return enumFor(vm, []);
    try {
      for (;;) yield* callBlock(vm, blk, []);
    } catch (e) {
      if (e instanceof RubyError && vm.isKindOf(e.exc, C.StopIteration)) return e.exc.ivars.get("result") ?? NIL;
      throw e;
    }
    return self;
  });
  def(Kernel, ["lambda"], (vm, _self, _args, blk) => {
    if (blk.t !== "proc") vm.error("ArgumentError", "tried to create Proc object without a block");
    const p = vm.toProcObject(blk) as ProcO;
    return p.iseq ? { ...p, lambda: true, isBlock: false, id: vm.id() } : p;
  });
  def(Kernel, "proc", (vm, _self, _args, blk) => {
    if (blk.t !== "proc") vm.error("ArgumentError", "tried to create Proc object without a block");
    return vm.toProcObject(blk);
  });
  def(Kernel, ["block_given?", "iterator?"], (vm) => bool(vm.blockGiven()));
  def(Kernel, "__method__", (vm) => {
    const f = vm.rubyTop();
    const me = f?.env ? vm.localEnv(f.env).me ?? f.env.me : null;
    return me ? sym(me.name) : NIL;
  });
  def(Kernel, "rand", (vm, _self, [max]) => {
    const r = vm.random();
    if (!max || max.t === "nil") return flo(r);
    if (max.t === "range") {
      const lo = num(vm, max.first);
      const hi = num(vm, max.last) - (max.excl ? 1 : 0);
      return int(Math.floor(lo + r * (hi - lo + 1)));
    }
    if (max.t === "float") return flo(r * max.v);
    return int(Math.floor(r * Number(toInt(vm, max))));
  });
  def(Kernel, "srand", () => int(0));
  def(Kernel, "sleep", (_vm, _self, [n]) => (n && n.t === "int" ? n : int(0)));
  def(Kernel, ["require", "require_relative"], () => TRUE);
  def(Kernel, "gets", () => NIL);
  def(Kernel, ["format", "sprintf"], function* (vm, _self, args) {
    return vm.str(yield* format(vm, str(vm, args[0]), args.slice(1)));
  });
  def(Kernel, "printf", function* (vm, _self, args) {
    out(yield* format(vm, str(vm, args[0]), args.slice(1)));
    return NIL;
  });
  def(Kernel, "Integer", (vm, _self, [v]) => {
    if (v.t === "str") {
      const s = v.s.trim().replace(/_/g, "");
      if (!/^[+-]?(\d+|0x[0-9a-f]+|0b[01]+|0o?[0-7]+)$/i.test(s)) vm.error("ArgumentError", `invalid value for Integer(): ${inspectString(v.s)}`);
      return int(BigInt(s.replace(/^([+-]?)0o/i, "$10o")));
    }
    if (v.t === "float") return int(Math.trunc(v.v));
    return int(toInt(vm, v));
  });
  def(Kernel, "Float", (vm, _self, [v]) => {
    if (v.t === "str") {
      const n = Number(v.s);
      if (Number.isNaN(n)) vm.error("ArgumentError", `invalid value for Float(): ${inspectString(v.s)}`);
      return flo(n);
    }
    return flo(num(vm, v));
  });
  def(Kernel, "String", function* (vm, _self, [v]) {
    return vm.str(yield* toS(vm, v));
  });
  def(Kernel, "Array", (vm, _self, [v]) => (v.t === "array" ? v : vm.ary(vm.splat(v))));
  def(Kernel, "class", (vm, self) => vm.realClassOf(self));
  def(Kernel, "singleton_class", (vm, self) => vm.singletonClass(self));
  def(Kernel, "inspect", function* (vm, self) {
    return vm.str(yield* inspect(vm, self));
  });
  def(Kernel, "to_s", (vm, self) => vm.str(vm.toS(self)));
  def(Kernel, "nil?", () => FALSE);
  def(Kernel, ["is_a?", "kind_of?"], (vm, self, [c]) => {
    if (c.t !== "class") vm.error("TypeError", "class or module required");
    return bool(vm.isKindOf(self, c as ClassO));
  });
  def(Kernel, "instance_of?", (vm, self, [c]) => bool(vm.realClassOf(self) === c));
  def(Kernel, "respond_to?", (vm, self, [m]) => bool(vm.respondTo(self, m.t === "sym" ? m.name : vm.toS(m))));
  def(Kernel, ["send", "__send__", "public_send"], function* (vm, self, args, blk) {
    const m = args[0];
    return yield* send(vm, self, m.t === "sym" ? m.name : vm.toS(m), args.slice(1), blk);
  });
  def(Kernel, "method", (vm, self, [m]) => {
    const name = m.t === "sym" ? m.name : vm.toS(m);
    if (!vm.respondTo(self, name)) vm.error("NameError", `undefined method '${name}' for ${vm.describeRecv(self)}`);
    const p = vm.newProc(null, null, self, null, true);
    p.native = function* (vm2: VM, s: Value, args: Value[], b: Value) {
      return yield* send(vm2, s, name, args, b);
    } as any;
    return p;
  });
  def(Kernel, ["object_id", "hash"], (_vm, self) => int(self.id ?? hashKey(self).length));
  def(Kernel, "eql?", (_vm, self, [o]) => bool(hashKey(self) === hashKey(o)));
  def(Kernel, "===", function* (vm, self, [o]) {
    return bool(yield* eq(vm, self, o));
  });
  def(Kernel, "=~", () => NIL);
  def(Kernel, "freeze", (_vm, self) => {
    if ("id" in self) (self as any).frozen = true;
    return self;
  });
  def(Kernel, "frozen?", (_vm, self) => bool(!("id" in self) || !!(self as any).frozen || self.t === "sym"));
  def(Kernel, ["dup", "clone"], (vm, self) => {
    switch (self.t) {
      case "str":
        return vm.str(self.s);
      case "array":
        return vm.ary([...self.items]);
      case "hash": {
        const h = vm.hash([...self.map.values()]);
        h.default = self.default;
        return h;
      }
      case "object": {
        const o = vm.newObject(self.cls);
        for (const [k, v] of self.ivars) o.ivars.set(k, v);
        return o;
      }
      default:
        return self;
    }
  });
  def(Kernel, "tap", function* (vm, self, _a, blk) {
    yield* callBlock(vm, blk, [self]);
    return self;
  });
  def(Kernel, ["then", "yield_self"], function* (vm, self, _a, blk) {
    return yield* callBlock(vm, blk, [self]);
  });
  def(Kernel, "itself", (_vm, self) => self);
  def(Kernel, "instance_variable_get", (vm, self, [n]) => vm.ivars(self).get(vm.toS(n)) ?? NIL);
  def(Kernel, "instance_variable_set", (vm, self, [n, v]) => {
    vm.ivars(self).set(vm.toS(n), v);
    return v;
  });
  def(Kernel, "instance_variables", (vm, self) => vm.ary([...vm.ivars(self).keys()].filter((k) => k.startsWith("@")).map((k) => sym(k))));
  def(Kernel, "extend", (vm, self, mods) => {
    const s = vm.singletonClass(self);
    for (const m of mods) if (m.t === "class") s.includes.push(m);
    return self;
  });
  def(Kernel, "define_singleton_method", (vm, self, [n], blk) => {
    const s = vm.singletonClass(self);
    s.methods.set(vm.toS(n), { owner: s, name: vm.toS(n), proc: { ...(vm.toProcObject(blk) as ProcO), lambda: true } });
    return n;
  });
  def(Kernel, "methods", (vm, self) => {
    const names = new Set<string>();
    for (const c of vm.ancestors(vm.classOf(self))) for (const k of c.methods.keys()) names.add(k);
    return vm.ary([...names].map((n) => sym(n)));
  });
  def(Kernel, "catch", function* (vm, _self, [tag], blk) {
    const t = tag ?? vm.newObject(Object);
    try {
      return yield* callBlock(vm, blk, [t]);
    } catch (e) {
      if (e instanceof RubyError && e.exc.ivars.get("__tag") === t) return e.exc.ivars.get("__val") ?? NIL;
      throw e;
    }
  });
  def(Kernel, "throw", (vm, _self, [tag, val]) => {
    const e = vm.makeError("ArgumentError", `uncaught throw ${vm.inspect(tag)}`);
    e.ivars.set("__tag", tag);
    e.ivars.set("__val", val ?? NIL);
    throw new RubyError(e);
  });

  // ── Module / Class ──
  def(Module, ["name", "to_s", "inspect"], (vm, self: ClassO) => vm.str(self.name));
  def(Module, "===", (vm, self: ClassO, [o]) => bool(vm.isKindOf(o, self)));
  def(Module, "==", (_vm, self, [o]) => bool(self === o));
  def(Module, "<", (vm, self: ClassO, [o]) => bool(self !== o && vm.ancestors(self).includes(o as ClassO)));
  def(Module, "<=", (vm, self: ClassO, [o]) => bool(vm.ancestors(self).includes(o as ClassO)));
  def(Module, "ancestors", (vm, self: ClassO) => vm.ary(vm.ancestors(self)));
  def(Module, ["include", "prepend"], (_vm, self: ClassO, mods) => {
    for (const m of mods) if (m.t === "class" && !self.includes.includes(m)) self.includes.push(m);
    return self;
  });
  def(Module, "include?", (vm, self: ClassO, [m]) => bool(self !== m && vm.ancestors(self).includes(m as ClassO)));
  def(Module, "extend", (vm, self: ClassO, mods) => {
    const s = vm.singletonClass(self);
    for (const m of mods) if (m.t === "class") s.includes.push(m);
    return self;
  });
  const attr = (reader: boolean, writer: boolean): Native => (vm, self: ClassO, names) => {
    for (const n of names) {
      const name = vm.toS(n);
      if (reader) vm.defineNative(self, name, (_vm, obj) => vm.ivars(obj).get("@" + name) ?? NIL);
      if (writer)
        vm.defineNative(self, name + "=", (_vm, obj, [v]) => {
          vm.checkFrozen(obj);
          vm.ivars(obj).set("@" + name, v);
          return v;
        });
    }
    return NIL;
  };
  def(Module, ["attr_reader", "attr"], attr(true, false));
  def(Module, "attr_writer", attr(false, true));
  def(Module, "attr_accessor", attr(true, true));
  def(Module, ["private", "public", "protected", "module_function", "private_constant", "private_class_method", "public_class_method"], (_vm, _self, args) =>
    args.length === 1 ? args[0] : NIL,
  );
  def(Module, "define_method", (vm, self: ClassO, [n], blk) => {
    if (blk.t !== "proc") vm.error("ArgumentError", "no block given");
    const name = vm.toS(n);
    self.methods.set(name, { owner: self, name, proc: { ...(vm.toProcObject(blk) as ProcO), lambda: true, id: vm.id() } });
    return sym(name);
  });
  def(Module, ["instance_methods", "public_instance_methods"], (vm, self: ClassO, [inherit]) => {
    const names = new Set<string>();
    const list = inherit && inherit.t === "false" ? [self] : vm.ancestors(self);
    for (const c of list) if (c !== BasicObject && c !== Object && c !== Kernel) for (const k of c.methods.keys()) names.add(k);
    return vm.ary([...names].map((x) => sym(x)));
  });
  def(Module, ["method_defined?", "public_method_defined?"], (vm, self: ClassO, [n]) => bool(!!vm.findMethod(self, vm.toS(n))));
  def(Module, "instance_method", (vm, self: ClassO, [n]) => sym(vm.toS(n)));
  def(Module, "const_get", (vm, self: ClassO, [n]) => vm.constGet(self, vm.toS(n)));
  def(Module, "const_set", (vm, self: ClassO, [n, v]) => {
    vm.constSet(self, vm.toS(n), v);
    return v;
  });
  def(Module, "constants", (vm, self: ClassO) => vm.ary([...self.consts.keys()].map((k) => sym(k))));
  def(Module, ["class_eval", "module_eval", "class_exec"], function* (vm, self, _args, blk) {
    return (yield { type: "proc", proc: { ...(blk as ProcO), targetClass: self }, args: [self], self }) as Value;
  });
  def(Module, "alias_method", (vm, self: ClassO, [a, b]) => {
    const m = vm.findMethod(self, vm.toS(b));
    if (m) self.methods.set(vm.toS(a), { ...m, name: vm.toS(a) });
    return self;
  });
  def(Module, "remove_method", (vm, self: ClassO, names) => {
    for (const n of names) self.methods.delete(vm.toS(n));
    return self;
  });
  def(Class, "superclass", (vm, self: ClassO) => {
    let s = self.superclass;
    while (s && s.attached) s = s.superclass;
    return s ?? NIL;
  });
  def(Class, "allocate", (vm, self: ClassO) => vm.newObject(self));
  def(Class, "new", function* (vm, self: ClassO, args, blk) {
    if (self === Class) {
      // Class.new(superclass) { ... }
      const sup = (args[0] as ClassO) ?? Object;
      const c = vm.newClass(`#<Class:0x${vm.id().toString(16)}>`, sup);
      if (blk.t === "proc") yield { type: "proc", proc: { ...(blk as ProcO), targetClass: c }, args: [c], self: c };
      return c;
    }
    if (self === Module) {
      return vm.newClass(`#<Module:0x${vm.id().toString(16)}>`, null, true);
    }
    const anc = vm.ancestors(self);
    let obj: Value = NIL;
    if (anc.includes(Proc)) return vm.toProcObject(blk);
    if (anc.includes(String)) obj = { ...vm.str(""), cls: self === String ? undefined : self };
    else if (anc.includes(Array)) obj = { ...vm.ary([]), cls: self === Array ? undefined : self };
    else if (anc.includes(Hash)) obj = { ...vm.hash(), cls: self === Hash ? undefined : self };
    else if ([Integer, Float, Symbol, NilClass, TrueClass, FalseClass, Range].some((c) => anc.includes(c)))
      vm.error("NoMethodError", `undefined method 'new' for class ${self.name}`);
    else obj = vm.newObject(self);
    yield* send(vm, obj, "initialize", args, blk);
    return obj;
  });

  // ── Comparable ──
  const cmpOp = (test: (n: number) => boolean): Native =>
    function* (vm, self, [o]) {
      return bool(test(yield* cmp(vm, self, o)));
    };
  def(Comparable, "<", cmpOp((n) => n < 0));
  def(Comparable, "<=", cmpOp((n) => n <= 0));
  def(Comparable, ">", cmpOp((n) => n > 0));
  def(Comparable, ">=", cmpOp((n) => n >= 0));
  def(Comparable, "==", function* (vm, self, [o]) {
    if (self === o) return TRUE;
    const s = eqSync(self, o);
    if (s !== undefined) return bool(s);
    return bool((yield* cmp(vm, self, o)) === 0);
  });
  def(Comparable, "between?", function* (vm, self, [lo, hi]) {
    return bool((yield* cmp(vm, self, lo)) >= 0 && (yield* cmp(vm, self, hi)) <= 0);
  });
  def(Comparable, "clamp", function* (vm, self, [lo, hi]) {
    if (lo.t === "range") [lo, hi] = [lo.first, lo.last];
    if ((yield* cmp(vm, self, lo)) < 0) return lo;
    if ((yield* cmp(vm, self, hi)) > 0) return hi;
    return self;
  });

  // ── nil / true / false ──
  def(NilClass, "to_s", (vm) => vm.str(""));
  def(NilClass, "to_a", (vm) => vm.ary([]));
  def(NilClass, "to_h", (vm) => vm.hash());
  def(NilClass, "to_i", () => int(0));
  def(NilClass, "to_f", () => flo(0));
  def(NilClass, "inspect", (vm) => vm.str("nil"));
  def(NilClass, "nil?", () => TRUE);
  def(NilClass, "&", () => FALSE);
  def(NilClass, "|", (_vm, _s, [o]) => bool(truthy(o)));
  def(TrueClass, ["to_s", "inspect"], (vm) => vm.str("true"));
  def(TrueClass, "&", (_vm, _s, [o]) => bool(truthy(o)));
  def(TrueClass, "|", () => TRUE);
  def(TrueClass, "^", (_vm, _s, [o]) => bool(!truthy(o)));
  def(FalseClass, ["to_s", "inspect"], (vm) => vm.str("false"));
  def(FalseClass, "&", () => FALSE);
  def(FalseClass, "|", (_vm, _s, [o]) => bool(truthy(o)));
  def(FalseClass, "^", (_vm, _s, [o]) => bool(truthy(o)));

  // ── Numbers ──
  const arith = (op: string): Native => (vm, self, [o]) => {
    if (o === undefined) vm.error("ArgumentError", "wrong number of arguments (given 0, expected 1)");
    if (self.t === "int" && o.t === "int") return intBinop(vm, op, self.v, o.v);
    if (o.t !== "int" && o.t !== "float") {
      if (op === "==") return FALSE;
      if (["<", "<=", ">", ">="].includes(op)) vm.error("ArgumentError", `comparison of ${vm.realClassOf(self).name} with ${vm.inspect(o)} failed`);
      vm.error("TypeError", `${o.t === "nil" ? "nil" : vm.realClassOf(o).name} can't be coerced into ${vm.realClassOf(self).name}`);
    }
    return floatBinop(op, num(vm, self), num(vm, o));
  };
  for (const op of ["+", "-", "*", "/", "%", "==", "<", "<=", ">", ">="]) def(Numeric, op, arith(op));
  def(Numeric, "modulo", arith("%"));
  def(Numeric, "<=>", (vm, self, [o]) => {
    const r = cmpSync(self, o);
    return r === undefined ? NIL : int(r);
  });
  def(Numeric, "**", (vm, self, [o]) => {
    if (self.t === "int" && o.t === "int" && o.v >= 0n) {
      if (o.v > 100000n) vm.error("ArgumentError", "exponent too large");
      return int(self.v ** o.v);
    }
    return flo(Math.pow(num(vm, self), num(vm, o)));
  });
  def(Numeric, "pow", (vm, self, [o, m]) => {
    if (m && self.t === "int" && o.t === "int" && m.t === "int") {
      let r = 1n;
      let b = floorMod(self.v, m.v);
      let e = o.v;
      while (e > 0n) {
        if (e & 1n) r = (r * b) % m.v;
        b = (b * b) % m.v;
        e >>= 1n;
      }
      return int(r);
    }
    return self.t === "int" && o.t === "int" && o.v >= 0n ? int(self.v ** o.v) : flo(Math.pow(num(vm, self), num(vm, o)));
  });
  def(Numeric, "-@", (_vm, self) => (self.t === "int" ? int(-self.v) : flo(-self.v)));
  def(Numeric, "+@", (_vm, self) => self);
  def(Numeric, ["abs", "magnitude"], (_vm, self) => (self.t === "int" ? int(self.v < 0n ? -self.v : self.v) : flo(Math.abs(self.v))));
  def(Numeric, "zero?", (vm, self) => bool(num(vm, self) === 0));
  def(Numeric, "nonzero?", (vm, self) => (num(vm, self) === 0 ? NIL : self));
  def(Numeric, "positive?", (vm, self) => bool(num(vm, self) > 0));
  def(Numeric, "negative?", (vm, self) => bool(num(vm, self) < 0));
  def(Numeric, "to_f", (vm, self) => flo(num(vm, self)));
  def(Numeric, "fdiv", (vm, self, [o]) => flo(num(vm, self) / num(vm, o)));
  def(Numeric, "quo", (vm, self, [o]) => flo(num(vm, self) / num(vm, o)));
  def(Numeric, "integer?", (_vm, self) => bool(self.t === "int"));
  def(Numeric, "divmod", (vm, self, [o]) => {
    if (self.t === "int" && o.t === "int") {
      if (o.v === 0n) vm.error("ZeroDivisionError", "divided by 0");
      return vm.ary([int(floorDiv(self.v, o.v)), int(floorMod(self.v, o.v))]);
    }
    const a = num(vm, self);
    const b = num(vm, o);
    return vm.ary([flo(Math.floor(a / b)), floatBinop("%", a, b)]);
  });
  def(Numeric, "div", (vm, self, [o]) => int(self.t === "int" && o.t === "int" ? floorDiv(self.v, o.v) : Math.floor(num(vm, self) / num(vm, o))));
  def(Numeric, "step", function* (vm, self, [limit, step], blk) {
    const st = step ?? int(1);
    const list: Value[] = [];
    if (self.t === "int" && limit.t === "int" && st.t === "int") {
      if (st.v === 0n) vm.error("ArgumentError", "step can't be 0");
      for (let i = self.v; st.v > 0n ? i <= limit.v : i >= limit.v; i += st.v) {
        if (blk.t === "proc") yield* callBlock(vm, blk, [int(i)]);
        else list.push(int(i));
      }
    } else {
      const a = num(vm, self);
      const l = num(vm, limit);
      const s = num(vm, st);
      const n = Math.floor((l - a) / s + 1e-9);
      for (let i = 0; i <= n; i++) {
        if (blk.t === "proc") yield* callBlock(vm, blk, [flo(a + i * s)]);
        else list.push(flo(a + i * s));
      }
    }
    return blk.t === "proc" ? self : enumFor(vm, list);
  });

  def(Integer, ["to_s", "inspect"], (vm, self, [base]) => vm.str(self.v.toString(base ? Number(toInt(vm, base)) : 10)));
  def(Integer, ["to_i", "to_int", "floor", "ceil", "truncate", "ord"], (_vm, self) => self);
  def(Integer, "round", (vm, self, [d]) => {
    if (!d || toInt(vm, d) >= 0n) return self;
    const p = 10n ** -toInt(vm, d);
    return int(((self.v + p / 2n) / p) * p);
  });
  def(Integer, "chr", (vm, self) => vm.str(globalThis.String.fromCharCode(Number(self.v))));
  def(Integer, ["succ", "next"], (_vm, self) => int(self.v + 1n));
  def(Integer, "pred", (_vm, self) => int(self.v - 1n));
  def(Integer, "even?", (_vm, self) => bool(self.v % 2n === 0n));
  def(Integer, "odd?", (_vm, self) => bool(self.v % 2n !== 0n));
  def(Integer, "&", (vm, self, [o]) => int(self.v & toInt(vm, o)));
  def(Integer, "|", (vm, self, [o]) => int(self.v | toInt(vm, o)));
  def(Integer, "^", (vm, self, [o]) => int(self.v ^ toInt(vm, o)));
  def(Integer, "~", (_vm, self) => int(~self.v));
  def(Integer, "<<", (vm, self, [o]) => int(self.v << toInt(vm, o)));
  def(Integer, ">>", (vm, self, [o]) => int(self.v >> toInt(vm, o)));
  def(Integer, "[]", (vm, self, [o]) => int((self.v >> toInt(vm, o)) & 1n));
  def(Integer, "gcd", (vm, self, [o]) => {
    let a = self.v < 0n ? -self.v : self.v;
    let b = toInt(vm, o);
    if (b < 0n) b = -b;
    while (b) [a, b] = [b, a % b];
    return int(a);
  });
  def(Integer, "lcm", (vm, self, [o]) => {
    let a = self.v < 0n ? -self.v : self.v;
    let b = toInt(vm, o);
    if (b < 0n) b = -b;
    const p = a * b;
    while (b) [a, b] = [b, a % b];
    return int(a === 0n ? 0n : p / a);
  });
  def(Integer, "digits", (vm, self) => {
    const out: Value[] = [];
    let n = self.v;
    if (n < 0n) vm.error("Math::DomainError", "out of domain");
    do {
      out.push(int(n % 10n));
      n /= 10n;
    } while (n > 0n);
    return vm.ary(out);
  });
  def(Integer, "bit_length", (_vm, self) => int((self.v < 0n ? ~self.v : self.v).toString(2).replace(/^0$/, "").length));
  def(Integer, "size", () => int(8));
  def(Integer, "times", function* (vm, self, _a, blk) {
    if (blk.t !== "proc") {
      const list: Value[] = [];
      for (let i = 0n; i < self.v; i++) list.push(int(i));
      return enumFor(vm, list);
    }
    for (let i = 0n; i < self.v; i++) yield* callBlock(vm, blk, [int(i)]);
    return self;
  });
  def(Integer, "upto", function* (vm, self, [lim], blk) {
    const list: Value[] = [];
    for (let i = self.v; i <= toInt(vm, lim); i++) {
      if (blk.t === "proc") yield* callBlock(vm, blk, [int(i)]);
      else list.push(int(i));
    }
    return blk.t === "proc" ? self : enumFor(vm, list);
  });
  def(Integer, "downto", function* (vm, self, [lim], blk) {
    const list: Value[] = [];
    for (let i = self.v; i >= toInt(vm, lim); i--) {
      if (blk.t === "proc") yield* callBlock(vm, blk, [int(i)]);
      else list.push(int(i));
    }
    return blk.t === "proc" ? self : enumFor(vm, list);
  });

  def(Float, ["to_s", "inspect"], (vm, self) => vm.str(formatFloat(self.v)));
  def(Float, ["to_i", "to_int", "truncate"], (vm, self) => {
    if (!Number.isFinite(self.v)) vm.error("FloatDomainError", formatFloat(self.v));
    return int(Math.trunc(self.v));
  });
  def(Float, "floor", (vm, self, [d]) => {
    if (d && toInt(vm, d) > 0n) {
      const p = 10 ** Number(toInt(vm, d));
      return flo(Math.floor(self.v * p) / p);
    }
    return int(Math.floor(self.v));
  });
  def(Float, "ceil", (vm, self, [d]) => {
    if (d && toInt(vm, d) > 0n) {
      const p = 10 ** Number(toInt(vm, d));
      return flo(Math.ceil(self.v * p) / p);
    }
    return int(Math.ceil(self.v));
  });
  def(Float, "round", (vm, self, [d]) => {
    const r = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));
    if (d && toInt(vm, d) > 0n) {
      const p = 10 ** Number(toInt(vm, d));
      return flo(r(self.v * p) / p);
    }
    if (!Number.isFinite(self.v)) vm.error("FloatDomainError", formatFloat(self.v));
    return int(r(self.v));
  });
  def(Float, "nan?", (_vm, self) => bool(Number.isNaN(self.v)));
  def(Float, "infinite?", (_vm, self) => (self.v === Infinity ? int(1) : self.v === -Infinity ? int(-1) : NIL));
  def(Float, "finite?", (_vm, self) => bool(Number.isFinite(self.v)));

  const math1 = (f: (x: number) => number): Native => (vm, _self, [x]) => flo(f(num(vm, x)));
  const ms = vm.singletonClass(MathM);
  for (const [n, f] of [
    ["sqrt", Math.sqrt],
    ["cbrt", Math.cbrt],
    ["sin", Math.sin],
    ["cos", Math.cos],
    ["tan", Math.tan],
    ["asin", Math.asin],
    ["acos", Math.acos],
    ["atan", Math.atan],
    ["exp", Math.exp],
    ["log2", Math.log2],
    ["log10", Math.log10],
  ] as const)
    vm.defineNative(ms, n, math1(f));
  vm.defineNative(ms, "log", (vm2: VM, _s: Value, [x, b]: Value[]) => flo(b ? Math.log(num(vm2, x)) / Math.log(num(vm2, b)) : Math.log(num(vm2, x))));
  vm.defineNative(ms, "atan2", (vm2: VM, _s: Value, [y, x]: Value[]) => flo(Math.atan2(num(vm2, y), num(vm2, x))));
  vm.defineNative(ms, "hypot", (vm2: VM, _s: Value, [y, x]: Value[]) => flo(Math.hypot(num(vm2, y), num(vm2, x))));
  vm.defineNative(ms, "pow", (vm2: VM, _s: Value, [y, x]: Value[]) => flo(Math.pow(num(vm2, y), num(vm2, x))));

  // ── Symbol ──
  def(Symbol, ["to_s", "id2name", "name"], (vm, self) => vm.str(self.name));
  def(Symbol, "to_sym", (_vm, self) => self);
  def(Symbol, "inspect", (vm, self) => vm.str(vm.inspect(self)));
  def(Symbol, "to_proc", (vm, self) => vm.toBlock(self));
  def(Symbol, ["length", "size"], (_vm, self) => int([...self.name].length));
  def(Symbol, "upcase", (_vm, self) => sym(self.name.toUpperCase()));
  def(Symbol, "downcase", (_vm, self) => sym(self.name.toLowerCase()));
  def(Symbol, "<=>", (_vm, self, [o]) => (o.t === "sym" ? int(self.name < o.name ? -1 : self.name > o.name ? 1 : 0) : NIL));
  def(Symbol, "[]", (vm, self, args) => strIndex(vm, vm.str(self.name), args));

  installString(vm, String, out);
  installEnumerable(vm, Enumerable);
  installArray(vm, Array);
  installHash(vm, Hash);
  installRange(vm, Range);

  // ── Proc ──
  for (const n of ["call", "()", "yield", "[]", "==="]) {
    Proc.methods.set(n, { owner: Proc, name: n, native: () => NIL, procCall: true } as any);
  }
  def(Proc, "to_proc", (_vm, self) => self);
  def(Proc, "lambda?", (_vm, self: ProcO) => bool(self.lambda));
  def(Proc, "arity", (_vm, self: ProcO) => {
    const P = self.iseq?.params;
    if (!P) return int(self.lambda ? 1 : -1);
    const req = (P.lead_num ?? 0) + (P.post_num ?? 0);
    const opt = P.opt ? P.opt.length - 1 : 0;
    const reqKw = (P.keyword ?? []).some((k) => k.required);
    const r = P.rest_start !== undefined || (opt > 0 && self.lambda);
    return int(r || (!self.lambda && opt > 0) ? -(req + (reqKw ? 1 : 0)) - 1 : req + (reqKw ? 1 : 0));
  });
  def(Proc, "curry", (vm, self: ProcO) => self);
  def(Proc, ">>", (vm, self: ProcO, [g]) => {
    const p = vm.newProc(null, null, NIL, null, true);
    p.native = function* (vm2: VM, _s: Value, args: Value[]) {
      const r = yield* callBlock(vm2, self, args);
      return yield* callBlock(vm2, g, [r]);
    } as any;
    return p;
  });
  def(Proc, "<<", (vm, self: ProcO, [g]) => {
    const p = vm.newProc(null, null, NIL, null, true);
    p.native = function* (vm2: VM, _s: Value, args: Value[]) {
      const r = yield* callBlock(vm2, g, args);
      return yield* callBlock(vm2, self, [r]);
    } as any;
    return p;
  });

  // ── Exception ──
  def(Exception, "initialize", (_vm, self: ObjO, [msg]) => {
    self.ivars.set("__mesg", msg ?? NIL);
    return NIL;
  });
  sdef(Exception, "exception", function* (vm, self, args) {
    return yield* send(vm, self, "new", args);
  });
  def(Exception, ["message", "to_s"], function* (vm, self: ObjO) {
    const m = self.ivars.get("__mesg");
    if (!m || m.t === "nil") return vm.str(self.cls.name);
    return vm.str(yield* toS(vm, m));
  });
  def(Exception, "full_message", (vm, self: ObjO) => vm.str(`${vm.excMessage(self)} (${self.cls.name})`));
  def(Exception, "inspect", (vm, self: ObjO) => vm.str(vm.inspect(self)));
  def(Exception, "backtrace", () => NIL);
  def(Exception, "exception", (_vm, self) => self);
  def(C.StopIteration, "result", (_vm, self: ObjO) => self.ivars.get("result") ?? NIL);

  // ── VM core (FrozenCore): internal methods the compiler calls after putspecialobject 1 ──
  def(Core, "core#hash_merge_ptr", (vm, _self, [h, ...kv]) => {
    for (let i = 0; i < kv.length; i += 2) vm.hashSet(h as HashO, kv[i], kv[i + 1]);
    return h;
  });
  def(Core, "core#hash_merge_kwd", (vm, _self, [h, h2]) => {
    if (h2 && h2.t === "hash") for (const [k, v] of h2.map.values()) vm.hashSet(h as HashO, k, v);
    else if (h2 && h2.t !== "nil") vm.error("TypeError", `no implicit conversion of ${vm.realClassOf(h2).name} into Hash`);
    return h;
  });
  def(Core, "core#set_method_alias", (vm, _self, [cls, a, b]) => {
    const c = cls as ClassO;
    const m = vm.findMethod(c, vm.toS(b));
    if (!m) vm.error("NameError", `undefined method '${vm.toS(b)}' for class '${c.name}'`);
    c.methods.set(vm.toS(a), { ...m!, name: vm.toS(a) });
    return NIL;
  });
  def(Core, "core#set_variable_alias", (vm, _self, [a, b]) => {
    vm.globals.set(vm.toS(a), vm.globals.get(vm.toS(b)) ?? NIL);
    return NIL;
  });
  def(Core, "core#undef_method", (vm, _self, [cls, n]) => {
    (cls as ClassO).methods.set(vm.toS(n), { owner: cls as ClassO, name: vm.toS(n) });
    return NIL;
  });
  def(Core, "lambda", (vm, _self, _args, blk) => {
    if (blk.t !== "proc") vm.error("ArgumentError", "tried to create Proc object without a block");
    const p = vm.toProcObject(blk) as ProcO;
    return p.iseq ? { ...p, lambda: true, isBlock: false, id: vm.id() } : p;
  });
}

// ───────────────────────── String ─────────────────────────

function strIndex(vm: VM, self: StrO, args: Value[]): Value {
  const chars = [...self.s];
  const [a, b] = args;
  if (a.t === "int" && b === undefined) {
    let i = Number(a.v);
    if (i < 0) i += chars.length;
    return i >= 0 && i < chars.length ? vm.str(chars[i]) : NIL;
  }
  if (a.t === "int" && b) {
    let i = Number(a.v);
    if (i < 0) i += chars.length;
    if (i < 0 || i > chars.length) return NIL;
    return vm.str(chars.slice(i, i + Math.max(0, Number(toInt(vm, b)))).join(""));
  }
  if (a.t === "range") {
    const r = rangeBounds(vm, a, chars.length);
    if (!r) return NIL;
    return vm.str(chars.slice(r[0], r[0] + r[1]).join(""));
  }
  if (a.t === "str") return self.s.includes(a.s) ? vm.str(a.s) : NIL;
  vm.error("TypeError", "no implicit conversion into Integer");
}

/** Converts a Range to [start, length] */
function rangeBounds(vm: VM, r: RangeO, len: number): [number, number] | null {
  let s = r.first.t === "nil" ? 0 : idx(vm, r.first);
  let e = r.last.t === "nil" ? -1 : idx(vm, r.last);
  if (s < 0) s += len;
  if (s < 0 || s > len) return null;
  if (e < 0) e += len;
  if (r.excl && r.last.t !== "nil") e -= 1;
  return [s, Math.max(0, Math.min(e, len - 1) - s + 1)];
}

function installString(vm: VM, S: ClassO, out: (s: string) => void) {
  void out;
  const def = (names: string | string[], fn: Native) => {
    for (const n of typeof names === "string" ? [names] : names) vm.defineNative(S, n, fn);
  };
  const mut = (self: StrO) => vm.checkFrozen(self);
  def("initialize", (vm2, self: StrO, [s]) => {
    self.s = s ? str(vm2, s) : "";
    return NIL;
  });
  def(["to_s", "to_str"], (_vm, self) => self);
  def("+@", (vm2, self: StrO) => (self.frozen ? vm2.str(self.s) : self));
  def("-@", (_vm, self: StrO) => {
    self.frozen = true;
    return self;
  });
  def("inspect", (vm2, self: StrO) => vm2.str(inspectString(self.s)));
  def(["length", "size"], (_vm, self: StrO) => int([...self.s].length));
  def("bytesize", (_vm, self: StrO) => int(new TextEncoder().encode(self.s).length));
  def("+", (vm2, self: StrO, [o]) => vm2.str(self.s + str(vm2, o)));
  def("*", (vm2, self: StrO, [o]) => vm2.str(self.s.repeat(idx(vm2, o))));
  def("%", function* (vm2, self: StrO, [o]) {
    return vm2.str(yield* format(vm2, self.s, o.t === "array" ? o.items : [o]));
  });
  def(["==", "eql?", "==="], (_vm, self: StrO, [o]) => bool(o.t === "str" && o.s === self.s));
  def("<=>", (_vm, self: StrO, [o]) => (o.t === "str" ? int(self.s < o.s ? -1 : self.s > o.s ? 1 : 0) : NIL));
  def(["<<", "concat"], function* (vm2, self: StrO, args) {
    mut(self);
    for (const o of args) self.s += o.t === "int" ? globalThis.String.fromCodePoint(Number(o.v)) : str(vm2, o);
    return self;
  });
  def("replace", (vm2, self: StrO, [o]) => {
    mut(self);
    self.s = str(vm2, o);
    return self;
  });
  def("upcase", (vm2, self: StrO) => vm2.str(self.s.toUpperCase()));
  def("downcase", (vm2, self: StrO) => vm2.str(self.s.toLowerCase()));
  def("capitalize", (vm2, self: StrO) => vm2.str(self.s.charAt(0).toUpperCase() + self.s.slice(1).toLowerCase()));
  def("swapcase", (vm2, self: StrO) => vm2.str([...self.s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("")));
  def("upcase!", (_vm, self: StrO) => {
    mut(self);
    self.s = self.s.toUpperCase();
    return self;
  });
  def("downcase!", (_vm, self: StrO) => {
    mut(self);
    self.s = self.s.toLowerCase();
    return self;
  });
  def("reverse", (vm2, self: StrO) => vm2.str([...self.s].reverse().join("")));
  def(["to_sym", "intern"], (_vm, self: StrO) => sym(self.s));
  def("to_i", (vm2, self: StrO, [base]) => {
    const b = base ? idx(vm2, base) : 10;
    const m = self.s.trim().replace(/_/g, "").match(b === 16 ? /^[+-]?[0-9a-f]+/i : b === 2 ? /^[+-]?[01]+/ : b === 8 ? /^[+-]?[0-7]+/ : /^[+-]?\d+/);
    if (!m) return int(0);
    const neg = m[0].startsWith("-");
    const digits = m[0].replace(/^[+-]/, "");
    let v = 0n;
    for (const ch of digits) v = v * BigInt(b) + BigInt(parseInt(ch, b));
    return int(neg ? -v : v);
  });
  def("to_f", (_vm, self: StrO) => {
    const m = self.s.trim().match(/^[+-]?(\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+)/);
    return flo(m ? parseFloat(m[0]) : 0);
  });
  def("include?", (vm2, self: StrO, [o]) => bool(self.s.includes(str(vm2, o))));
  def("start_with?", (vm2, self: StrO, args) => bool(args.some((o) => self.s.startsWith(str(vm2, o)))));
  def("end_with?", (vm2, self: StrO, args) => bool(args.some((o) => self.s.endsWith(str(vm2, o)))));
  def("index", (vm2, self: StrO, [o, from]) => {
    const i = self.s.indexOf(str(vm2, o), from ? idx(vm2, from) : 0);
    return i < 0 ? NIL : int(i);
  });
  def(["[]", "slice"], (vm2, self: StrO, args) => strIndex(vm2, self, args));
  def("[]=", (vm2, self: StrO, args) => {
    mut(self);
    const chars = [...self.s];
    const v = args[args.length - 1];
    if (args.length === 2 && args[0].t === "int") {
      let i = idx(vm2, args[0]);
      if (i < 0) i += chars.length;
      chars.splice(i, 1, str(vm2, v));
    } else if (args.length === 2 && args[0].t === "str") {
      self.s = self.s.replace(args[0].s, str(vm2, v));
      return v;
    } else if (args.length === 3) {
      chars.splice(idx(vm2, args[0]), idx(vm2, args[1]), str(vm2, v));
    }
    self.s = chars.join("");
    return v;
  });
  def("chars", (vm2, self: StrO) => vm2.ary([...self.s].map((c) => vm2.str(c))));
  def("bytes", (vm2, self: StrO) => vm2.ary([...new TextEncoder().encode(self.s)].map((b) => int(b))));
  def("ord", (vm2, self: StrO) => {
    if (!self.s) vm2.error("ArgumentError", "empty string");
    return int(self.s.codePointAt(0)!);
  });
  def("lines", (vm2, self: StrO) => vm2.ary((self.s.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((l) => vm2.str(l))));
  def("each_char", function* (vm2, self: StrO, _a, blk) {
    if (blk.t !== "proc") return enumFor(vm2, [...self.s].map((c) => vm2.str(c)));
    for (const c of [...self.s]) yield* callBlock(vm2, blk, [vm2.str(c)]);
    return self;
  });
  def("each_line", function* (vm2, self: StrO, _a, blk) {
    if (blk.t !== "proc") return enumFor(vm2, (self.s.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((l) => vm2.str(l)));
    for (const l of self.s.match(/[^\n]*\n|[^\n]+$/g) ?? []) yield* callBlock(vm2, blk, [vm2.str(l)]);
    return self;
  });
  def("split", (vm2, self: StrO, [sep, lim]) => {
    let parts: string[];
    if (!sep || sep.t === "nil" || (sep.t === "str" && sep.s === " ")) parts = self.s.trim().split(/\s+/).filter((x) => x !== "");
    else parts = self.s.split(str(vm2, sep));
    if (lim && lim.t === "int" && lim.v > 0n) {
      const n = Number(lim.v);
      if (parts.length > n) parts = [...parts.slice(0, n - 1), parts.slice(n - 1).join(sep && sep.t === "str" ? sep.s : " ")];
    } else while (parts.length && parts[parts.length - 1] === "") parts.pop();
    return vm2.ary(parts.map((p) => vm2.str(p)));
  });
  def("strip", (vm2, self: StrO) => vm2.str(self.s.trim()));
  def("lstrip", (vm2, self: StrO) => vm2.str(self.s.trimStart()));
  def("rstrip", (vm2, self: StrO) => vm2.str(self.s.trimEnd()));
  def("chomp", (vm2, self: StrO, [s]) => vm2.str(s ? (self.s.endsWith(str(vm2, s)) ? self.s.slice(0, -str(vm2, s).length) : self.s) : self.s.replace(/\r?\n$/, "")));
  def("chop", (vm2, self: StrO) => vm2.str(self.s.slice(0, -1)));
  def("chr", (vm2, self: StrO) => vm2.str(self.s.slice(0, 1)));
  def("center", (vm2, self: StrO, [w, p]) => {
    const width = idx(vm2, w);
    const pad = p ? str(vm2, p) : " ";
    const len = [...self.s].length;
    if (width <= len) return vm2.str(self.s);
    const total = width - len;
    const left = Math.floor(total / 2);
    const mk = (n: number) => pad.repeat(Math.ceil(n / pad.length)).slice(0, n);
    return vm2.str(mk(left) + self.s + mk(total - left));
  });
  def("ljust", (vm2, self: StrO, [w, p]) => vm2.str(self.s.padEnd(idx(vm2, w), p ? str(vm2, p) : " ")));
  def("rjust", (vm2, self: StrO, [w, p]) => vm2.str(self.s.padStart(idx(vm2, w), p ? str(vm2, p) : " ")));
  def("empty?", (_vm, self: StrO) => bool(self.s.length === 0));
  def("sub", (vm2, self: StrO, [pat, rep]) => vm2.str(self.s.replace(str(vm2, pat), () => str(vm2, rep))));
  def("gsub", (vm2, self: StrO, [pat, rep]) => vm2.str(self.s.split(str(vm2, pat)).join(str(vm2, rep))));
  def("tr", (vm2, self: StrO, [from, to]) => {
    const expand = (s: string) => s.replace(/(.)-(.)/g, (_m, a: string, b: string) => {
      let r = "";
      for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) r += globalThis.String.fromCharCode(c);
      return r;
    });
    const f = expand(str(vm2, from));
    const t = expand(str(vm2, to));
    return vm2.str([...self.s].map((c) => (f.includes(c) ? (t[f.indexOf(c)] ?? t[t.length - 1] ?? "") : c)).join(""));
  });
  def("delete", (vm2, self: StrO, [s]) => vm2.str([...self.s].filter((c) => !str(vm2, s).includes(c)).join("")));
  def("count", (vm2, self: StrO, [s]) => int([...self.s].filter((c) => str(vm2, s).includes(c)).length));
  def("squeeze", (vm2, self: StrO) => vm2.str(self.s.replace(/(.)\1+/g, "$1")));
  def(["succ", "next"], (vm2, self: StrO) => vm2.str(strSucc(self.s)));
  def("hash", (_vm, self: StrO) => int(hashKey(self).length));
  def("prepend", (vm2, self: StrO, [o]) => {
    mut(self);
    self.s = str(vm2, o) + self.s;
    return self;
  });
  def("insert", (vm2, self: StrO, [i, o]) => {
    mut(self);
    const chars = [...self.s];
    let n = idx(vm2, i);
    if (n < 0) n += chars.length + 1;
    chars.splice(n, 0, str(vm2, o));
    self.s = chars.join("");
    return self;
  });
  def("upto", function* (vm2, self: StrO, [last], blk) {
    for (const s of vm2.rangeToArray(vm2.range(self, last, false))) yield* callBlock(vm2, blk, [s]);
    return self;
  });
  def("=~", () => NIL);
  def("freeze", (_vm, self: StrO) => {
    self.frozen = true;
    return self;
  });
}

// ───────────────────────── Enumerable (shared by Array / Hash / Range) ─────────────────────────

function installEnumerable(vm: VM, E: ClassO) {
  const def = (names: string | string[], fn: Native) => {
    for (const n of typeof names === "string" ? [names] : names) vm.defineNative(E, n, fn);
  };
  def(["to_a", "entries"], function* (vm2, self) {
    return vm2.ary(yield* items(vm2, self));
  });
  def(["map", "collect"], function* (vm2, self, _a, blk) {
    const list = yield* items(vm2, self);
    if (blk.t !== "proc") return enumFor(vm2, list);
    const outl: Value[] = [];
    for (const x of list) outl.push(yield* callBlock(vm2, blk, [x]));
    return vm2.ary(outl);
  });
  def("flat_map", function* (vm2, self, _a, blk) {
    const outl: Value[] = [];
    for (const x of yield* items(vm2, self)) {
      const r = yield* callBlock(vm2, blk, [x]);
      if (r.t === "array") outl.push(...r.items);
      else outl.push(r);
    }
    return vm2.ary(outl);
  });
  def(["select", "filter"], function* (vm2, self, _a, blk) {
    const outl: Value[] = [];
    for (const x of yield* items(vm2, self)) if (truthy(yield* callBlock(vm2, blk, [x]))) outl.push(x);
    return vm2.ary(outl);
  });
  def("filter_map", function* (vm2, self, _a, blk) {
    const outl: Value[] = [];
    for (const x of yield* items(vm2, self)) {
      const r = yield* callBlock(vm2, blk, [x]);
      if (truthy(r)) outl.push(r);
    }
    return vm2.ary(outl);
  });
  def("reject", function* (vm2, self, _a, blk) {
    const outl: Value[] = [];
    for (const x of yield* items(vm2, self)) if (!truthy(yield* callBlock(vm2, blk, [x]))) outl.push(x);
    return vm2.ary(outl);
  });
  def("partition", function* (vm2, self, _a, blk) {
    const t: Value[] = [];
    const f: Value[] = [];
    for (const x of yield* items(vm2, self)) (truthy(yield* callBlock(vm2, blk, [x])) ? t : f).push(x);
    return vm2.ary([vm2.ary(t), vm2.ary(f)]);
  });
  def(["find", "detect"], function* (vm2, self, _a, blk) {
    for (const x of yield* items(vm2, self)) if (truthy(yield* callBlock(vm2, blk, [x]))) return x;
    return NIL;
  });
  def(["find_index"], function* (vm2, self, [v], blk) {
    let i = 0;
    for (const x of yield* items(vm2, self)) {
      if (blk.t === "proc" ? truthy(yield* callBlock(vm2, blk, [x])) : yield* eq(vm2, x, v)) return int(i);
      i++;
    }
    return NIL;
  });
  def("each_with_index", function* (vm2, self, _a, blk) {
    const list = yield* items(vm2, self);
    if (blk.t !== "proc") return enumFor(vm2, list.map((x, i) => vm2.ary([x, int(i)])));
    let i = 0;
    for (const x of list) yield* callBlock(vm2, blk, [x, int(i++)]);
    return self;
  });
  def("each_with_object", function* (vm2, self, [memo], blk) {
    for (const x of yield* items(vm2, self)) yield* callBlock(vm2, blk, [x, memo]);
    return memo;
  });
  def(["inject", "reduce"], function* (vm2, self, args, blk) {
    const list = yield* items(vm2, self);
    let acc: Value | undefined;
    let op: string | undefined;
    if (args.length === 2) {
      acc = args[0];
      op = vm2.toS(args[1]);
    } else if (args.length === 1 && blk.t !== "proc") op = vm2.toS(args[0]);
    else if (args.length === 1) acc = args[0];
    for (const x of list) {
      if (acc === undefined) {
        acc = x;
        continue;
      }
      acc = op ? yield* send(vm2, acc, op, [x]) : yield* callBlock(vm2, blk, [acc, x]);
    }
    return acc ?? NIL;
  });
  def("sum", function* (vm2, self, [init], blk) {
    let acc: Value = init ?? int(0);
    for (const x of yield* items(vm2, self)) {
      const v = blk.t === "proc" ? yield* callBlock(vm2, blk, [x]) : x;
      acc = yield* send(vm2, acc, "+", [v]);
    }
    return acc;
  });
  def("count", function* (vm2, self, [v], blk) {
    let n = 0;
    for (const x of yield* items(vm2, self)) {
      if (blk.t === "proc") {
        if (truthy(yield* callBlock(vm2, blk, [x]))) n++;
      } else if (v !== undefined) {
        if (yield* eq(vm2, x, v)) n++;
      } else n++;
    }
    return int(n);
  });
  def("any?", function* (vm2, self, [pat], blk) {
    for (const x of yield* items(vm2, self)) {
      const r = blk.t === "proc" ? truthy(yield* callBlock(vm2, blk, [x])) : pat ? truthy(yield* send(vm2, pat, "===", [x])) : truthy(x);
      if (r) return TRUE;
    }
    return FALSE;
  });
  def("all?", function* (vm2, self, [pat], blk) {
    for (const x of yield* items(vm2, self)) {
      const r = blk.t === "proc" ? truthy(yield* callBlock(vm2, blk, [x])) : pat ? truthy(yield* send(vm2, pat, "===", [x])) : truthy(x);
      if (!r) return FALSE;
    }
    return TRUE;
  });
  def("none?", function* (vm2, self, _a, blk) {
    for (const x of yield* items(vm2, self)) if (blk.t === "proc" ? truthy(yield* callBlock(vm2, blk, [x])) : truthy(x)) return FALSE;
    return TRUE;
  });
  def(["include?", "member?"], function* (vm2, self, [v]) {
    for (const x of yield* items(vm2, self)) if (yield* eq(vm2, x, v)) return TRUE;
    return FALSE;
  });
  def("first", function* (vm2, self, [n]) {
    const list = yield* items(vm2, self);
    return n ? vm2.ary(list.slice(0, idx(vm2, n))) : (list[0] ?? NIL);
  });
  const minmax = (dir: number): Native =>
    function* (vm2, self, [n], blk) {
      const list = yield* items(vm2, self);
      const compare = function* (a: Value, b: Value): G<number> {
        if (blk.t === "proc") {
          const r = yield* callBlock(vm2, blk, [a, b]);
          return Number(toInt(vm2, r));
        }
        return yield* cmp(vm2, a, b);
      };
      if (n) {
        const sorted = yield* mergeSort(vm2, list, function* (a, b) {
          return dir * (yield* compare(a, b));
        });
        return vm2.ary(sorted.slice(0, idx(vm2, n)));
      }
      let best: Value | undefined;
      for (const x of list) if (best === undefined || dir * (yield* compare(x, best)) < 0) best = x;
      return best ?? NIL;
    };
  def("min", minmax(1));
  def("max", minmax(-1));
  const byKey = (dir: number): Native =>
    function* (vm2, self, _a, blk) {
      let best: Value | undefined;
      let bestKey: Value | undefined;
      for (const x of yield* items(vm2, self)) {
        const k = yield* callBlock(vm2, blk, [x]);
        if (bestKey === undefined || dir * (yield* cmp(vm2, k, bestKey)) < 0) {
          best = x;
          bestKey = k;
        }
      }
      return best ?? NIL;
    };
  def("min_by", byKey(1));
  def("max_by", byKey(-1));
  def("minmax", function* (vm2, self) {
    const list = yield* items(vm2, self);
    const sorted = yield* mergeSort(vm2, list, (a, b) => cmp(vm2, a, b));
    return vm2.ary([sorted[0] ?? NIL, sorted[sorted.length - 1] ?? NIL]);
  });
  def("sort", function* (vm2, self, _a, blk) {
    const list = yield* items(vm2, self);
    const sorted = yield* mergeSort(vm2, list, function* (a, b) {
      if (blk.t === "proc") return Number(toInt(vm2, yield* callBlock(vm2, blk, [a, b])));
      return yield* cmp(vm2, a, b);
    });
    return vm2.ary(sorted);
  });
  def("sort_by", function* (vm2, self, _a, blk) {
    const list = yield* items(vm2, self);
    const keyed: Value[] = [];
    for (const x of list) keyed.push(vm2.ary([yield* callBlock(vm2, blk, [x]), x]));
    const sorted = yield* mergeSort(vm2, keyed, (a, b) => cmp(vm2, (a as AryO).items[0], (b as AryO).items[0]));
    return vm2.ary(sorted.map((p) => (p as AryO).items[1]));
  });
  def("group_by", function* (vm2, self, _a, blk) {
    const h = vm2.hash();
    for (const x of yield* items(vm2, self)) {
      const k = yield* callBlock(vm2, blk, [x]);
      const cur = vm2.hashGet(h, k);
      if (cur && cur.t === "array") cur.items.push(x);
      else vm2.hashSet(h, k, vm2.ary([x]));
    }
    return h;
  });
  def("tally", function* (vm2, self) {
    const h = vm2.hash();
    for (const x of yield* items(vm2, self)) {
      const cur = vm2.hashGet(h, x);
      vm2.hashSet(h, x, int(cur && cur.t === "int" ? cur.v + 1n : 1n));
    }
    return h;
  });
  def("each_slice", function* (vm2, self, [n], blk) {
    const list = yield* items(vm2, self);
    const size = idx(vm2, n);
    const slices: Value[] = [];
    for (let i = 0; i < list.length; i += size) slices.push(vm2.ary(list.slice(i, i + size)));
    if (blk.t !== "proc") return enumFor(vm2, slices);
    for (const s of slices) yield* callBlock(vm2, blk, [s]);
    return NIL;
  });
  def("each_cons", function* (vm2, self, [n], blk) {
    const list = yield* items(vm2, self);
    const size = idx(vm2, n);
    const conses: Value[] = [];
    for (let i = 0; i + size <= list.length; i++) conses.push(vm2.ary(list.slice(i, i + size)));
    if (blk.t !== "proc") return enumFor(vm2, conses);
    for (const s of conses) yield* callBlock(vm2, blk, [s]);
    return self;
  });
  def("zip", function* (vm2, self, others) {
    const list = yield* items(vm2, self);
    const os: Value[][] = [];
    for (const o of others) os.push(yield* items(vm2, o));
    return vm2.ary(list.map((x, i) => vm2.ary([x, ...os.map((o) => o[i] ?? NIL)])));
  });
  def("take", function* (vm2, self, [n]) {
    return vm2.ary((yield* items(vm2, self)).slice(0, idx(vm2, n)));
  });
  def("drop", function* (vm2, self, [n]) {
    return vm2.ary((yield* items(vm2, self)).slice(idx(vm2, n)));
  });
  def("take_while", function* (vm2, self, _a, blk) {
    const outl: Value[] = [];
    for (const x of yield* items(vm2, self)) {
      if (!truthy(yield* callBlock(vm2, blk, [x]))) break;
      outl.push(x);
    }
    return vm2.ary(outl);
  });
  def("drop_while", function* (vm2, self, _a, blk) {
    const list = yield* items(vm2, self);
    let i = 0;
    while (i < list.length && truthy(yield* callBlock(vm2, blk, [list[i]]))) i++;
    return vm2.ary(list.slice(i));
  });
  def("uniq", function* (vm2, self, _a, blk) {
    const seen = new Set<string>();
    const outl: Value[] = [];
    for (const x of yield* items(vm2, self)) {
      const k = hashKey(blk.t === "proc" ? yield* callBlock(vm2, blk, [x]) : x);
      if (!seen.has(k)) {
        seen.add(k);
        outl.push(x);
      }
    }
    return vm2.ary(outl);
  });
  def("to_h", function* (vm2, self, _a, blk) {
    const h = vm2.hash();
    for (const x of yield* items(vm2, self)) {
      const p = blk.t === "proc" ? yield* callBlock(vm2, blk, [x]) : x;
      if (p.t !== "array" || p.items.length !== 2) vm2.error("TypeError", "wrong element type (expected array of 2 elements)");
      vm2.hashSet(h, (p as AryO).items[0], (p as AryO).items[1]);
    }
    return h;
  });
  def("each_entry", function* (vm2, self, _a, blk) {
    for (const x of yield* items(vm2, self)) yield* callBlock(vm2, blk, [x]);
    return self;
  });
  def("cycle", function* (vm2, self, [n], blk) {
    const list = yield* items(vm2, self);
    const times = n ? idx(vm2, n) : Infinity;
    for (let i = 0; i < times; i++) for (const x of list) yield* callBlock(vm2, blk, [x]);
    return NIL;
  });
  def("lazy", (_vm, self) => self);
}

// ───────────────────────── Array ─────────────────────────

function installArray(vm: VM, A: ClassO) {
  const def = (names: string | string[], fn: Native) => {
    for (const n of typeof names === "string" ? [names] : names) vm.defineNative(A, n, fn);
  };
  const mut = (self: AryO) => vm.checkFrozen(self);
  const norm = (self: AryO, i: number) => (i < 0 ? i + self.items.length : i);
  def("initialize", function* (vm2, self: AryO, [n, v], blk) {
    self.items = [];
    if (n && n.t === "array") {
      self.items = [...n.items];
      return NIL;
    }
    const size = n ? idx(vm2, n) : 0;
    for (let i = 0; i < size; i++) self.items.push(blk.t === "proc" ? yield* callBlock(vm2, blk, [int(i)]) : (v ?? NIL));
    return NIL;
  });
  def("each", function* (vm2, self: AryO, _a, blk) {
    if (blk.t !== "proc") return enumFor(vm2, [...self.items]);
    for (let i = 0; i < self.items.length; i++) yield* callBlock(vm2, blk, [self.items[i]]);
    return self;
  });
  // each / map without a block return an array (a simplification), so a following .with_index behaves like map
  def(["with_index", "each_with_index_map"], function* (vm2, self: AryO, [off], blk) {
    const base = off ? idx(vm2, off) : 0;
    const outl: Value[] = [];
    for (let i = 0; i < self.items.length; i++) outl.push(yield* callBlock(vm2, blk, [self.items[i], int(i + base)]));
    return vm2.ary(outl);
  });
  def("each_index", function* (vm2, self: AryO, _a, blk) {
    for (let i = 0; i < self.items.length; i++) yield* callBlock(vm2, blk, [int(i)]);
    return self;
  });
  def("reverse_each", function* (vm2, self: AryO, _a, blk) {
    for (let i = self.items.length - 1; i >= 0; i--) yield* callBlock(vm2, blk, [self.items[i]]);
    return self;
  });
  def(["map!", "collect!"], function* (vm2, self: AryO, _a, blk) {
    mut(self);
    for (let i = 0; i < self.items.length; i++) self.items[i] = yield* callBlock(vm2, blk, [self.items[i]]);
    return self;
  });
  def(["select!", "filter!", "keep_if"], function* (vm2, self: AryO, _a, blk) {
    mut(self);
    const keep: Value[] = [];
    for (const x of self.items) if (truthy(yield* callBlock(vm2, blk, [x]))) keep.push(x);
    self.items = keep;
    return self;
  });
  def(["reject!", "delete_if"], function* (vm2, self: AryO, _a, blk) {
    mut(self);
    const keep: Value[] = [];
    for (const x of self.items) if (!truthy(yield* callBlock(vm2, blk, [x]))) keep.push(x);
    self.items = keep;
    return self;
  });
  def(["sort!"], function* (vm2, self: AryO, _a, blk) {
    mut(self);
    self.items = yield* mergeSort(vm2, self.items, function* (a, b) {
      if (blk.t === "proc") return Number(toInt(vm2, yield* callBlock(vm2, blk, [a, b])));
      return yield* cmp(vm2, a, b);
    });
    return self;
  });
  def(["sort_by!"], function* (vm2, self: AryO, _a, blk) {
    mut(self);
    const keyed: [Value, Value][] = [];
    for (const x of self.items) keyed.push([yield* callBlock(vm2, blk, [x]), x]);
    const sorted = yield* mergeSort(vm2, keyed.map(([k, x]) => vm2.ary([k, x])), (a, b) => cmp(vm2, (a as AryO).items[0], (b as AryO).items[0]));
    self.items = sorted.map((p) => (p as AryO).items[1]);
    return self;
  });
  def(["length", "size"], (_vm, self: AryO) => int(self.items.length));
  def("empty?", (_vm, self: AryO) => bool(self.items.length === 0));
  def(["to_a", "entries", "to_ary"], (_vm, self) => self);
  def(["inspect", "to_s"], function* (vm2, self) {
    return vm2.str(yield* inspect(vm2, self));
  });
  def("==", function* (vm2, self: AryO, [o]) {
    if (o.t !== "array" || o.items.length !== self.items.length) return FALSE;
    for (let i = 0; i < self.items.length; i++) if (!(yield* eq(vm2, self.items[i], o.items[i]))) return FALSE;
    return TRUE;
  });
  def("<=>", function* (vm2, self: AryO, [o]) {
    if (o.t !== "array") return NIL;
    for (let i = 0; i < Math.min(self.items.length, o.items.length); i++) {
      const r = yield* cmp(vm2, self.items[i], o.items[i]);
      if (r !== 0) return int(r);
    }
    return int(Math.sign(self.items.length - o.items.length));
  });
  def("hash", (_vm, self) => int(hashKey(self).length));
  def(["push", "append"], (_vm, self: AryO, args) => {
    mut(self);
    self.items.push(...args);
    return self;
  });
  def("<<", (_vm, self: AryO, [v]) => {
    mut(self);
    self.items.push(v);
    return self;
  });
  def("pop", (vm2, self: AryO, [n]) => {
    mut(self);
    if (n) return vm2.ary(self.items.splice(Math.max(0, self.items.length - idx(vm2, n))));
    return self.items.pop() ?? NIL;
  });
  def("shift", (vm2, self: AryO, [n]) => {
    mut(self);
    if (n) return vm2.ary(self.items.splice(0, idx(vm2, n)));
    return self.items.shift() ?? NIL;
  });
  def(["unshift", "prepend"], (_vm, self: AryO, args) => {
    mut(self);
    self.items.unshift(...args);
    return self;
  });
  def("insert", (vm2, self: AryO, [i, ...vs]) => {
    mut(self);
    let n = idx(vm2, i);
    if (n < 0) n += self.items.length + 1;
    self.items.splice(n, 0, ...vs);
    return self;
  });
  def("concat", (vm2, self: AryO, args) => {
    mut(self);
    for (const a of args) self.items.push(...vm2.splat(a));
    return self;
  });
  def("+", (vm2, self: AryO, [o]) => {
    if (o.t !== "array") vm2.error("TypeError", `no implicit conversion of ${vm2.realClassOf(o).name} into Array`);
    return vm2.ary([...self.items, ...(o as AryO).items]);
  });
  def("-", (vm2, self: AryO, [o]) => {
    const keys = new Set((o as AryO).items.map(hashKey));
    return vm2.ary(self.items.filter((x) => !keys.has(hashKey(x))));
  });
  def("*", (vm2, self: AryO, [o]) => {
    if (o.t === "str") return vm2.str(self.items.map((x) => vm2.toS(x)).join(o.s));
    const outl: Value[] = [];
    for (let i = 0; i < idx(vm2, o); i++) outl.push(...self.items);
    return vm2.ary(outl);
  });
  def("&", (vm2, self: AryO, [o]) => {
    const keys = new Set((o as AryO).items.map(hashKey));
    const seen = new Set<string>();
    return vm2.ary(self.items.filter((x) => keys.has(hashKey(x)) && !seen.has(hashKey(x)) && seen.add(hashKey(x))));
  });
  def("|", (vm2, self: AryO, [o]) => {
    const seen = new Set<string>();
    return vm2.ary([...self.items, ...(o as AryO).items].filter((x) => !seen.has(hashKey(x)) && seen.add(hashKey(x))));
  });
  def(["[]", "slice"], (vm2, self: AryO, [a, b]) => {
    if (a.t === "int" && b === undefined) return self.items[norm(self, Number(a.v))] ?? NIL;
    if (a.t === "int" && b) {
      const s = norm(self, Number(a.v));
      if (s < 0 || s > self.items.length) return NIL;
      return vm2.ary(self.items.slice(s, s + Math.max(0, idx(vm2, b))));
    }
    if (a.t === "range") {
      const r = rangeBounds(vm2, a, self.items.length);
      return r ? vm2.ary(self.items.slice(r[0], r[0] + r[1])) : NIL;
    }
    vm2.error("TypeError", `no implicit conversion of ${vm2.realClassOf(a).name} into Integer`);
  });
  def("[]=", (vm2, self: AryO, args) => {
    mut(self);
    const v = args[args.length - 1];
    if (args.length === 2 && args[0].t === "int") {
      const i = norm(self, Number(args[0].v));
      if (i < 0) vm2.error("IndexError", `index ${args[0].v} too small for array`);
      while (self.items.length < i) self.items.push(NIL);
      self.items[i] = v;
    } else if (args.length === 3) {
      self.items.splice(norm(self, idx(vm2, args[0])), idx(vm2, args[1]), ...vm2.splat(v));
    } else if (args[0].t === "range") {
      const r = rangeBounds(vm2, args[0], self.items.length);
      if (r) self.items.splice(r[0], r[1], ...vm2.splat(v));
    }
    return v;
  });
  def("at", (_vm, self: AryO, [i]) => self.items[norm(self, Number((i as any).v))] ?? NIL);
  def("dig", function* (vm2, self: AryO, keys) {
    let cur: Value = self;
    for (const k of keys) {
      if (cur.t === "nil") return NIL;
      cur = yield* send(vm2, cur, "[]", [k]);
    }
    return cur;
  });
  def("fetch", function* (vm2, self: AryO, [i, d], blk) {
    const n = norm(self, idx(vm2, i));
    if (n >= 0 && n < self.items.length) return self.items[n];
    if (blk.t === "proc") return yield* callBlock(vm2, blk, [i]);
    if (d) return d;
    vm2.error("IndexError", `index ${idx(vm2, i)} outside of array bounds: ${-self.items.length}...${self.items.length}`);
  });
  def("first", (vm2, self: AryO, [n]) => (n ? vm2.ary(self.items.slice(0, idx(vm2, n))) : (self.items[0] ?? NIL)));
  def("last", (vm2, self: AryO, [n]) => (n ? vm2.ary(self.items.slice(-idx(vm2, n) || self.items.length)) : (self.items[self.items.length - 1] ?? NIL)));
  def("index", function* (vm2, self: AryO, [v], blk) {
    for (let i = 0; i < self.items.length; i++) {
      if (blk.t === "proc" ? truthy(yield* callBlock(vm2, blk, [self.items[i]])) : yield* eq(vm2, self.items[i], v)) return int(i);
    }
    return NIL;
  });
  def("join", function* (vm2, self: AryO, [sep]) {
    const parts: string[] = [];
    const walk = function* (a: AryO): G<void> {
      for (const x of a.items) {
        if (x.t === "array") yield* walk(x);
        else parts.push(yield* toS(vm2, x));
      }
    };
    yield* walk(self);
    return vm2.str(parts.join(sep && sep.t === "str" ? sep.s : ""));
  });
  def("reverse", (vm2, self: AryO) => vm2.ary([...self.items].reverse()));
  def("reverse!", (_vm, self: AryO) => {
    self.items.reverse();
    return self;
  });
  def("rotate", (vm2, self: AryO, [n]) => {
    const len = self.items.length;
    if (!len) return vm2.ary([]);
    const k = (((n ? idx(vm2, n) : 1) % len) + len) % len;
    return vm2.ary([...self.items.slice(k), ...self.items.slice(0, k)]);
  });
  def("uniq!", (_vm, self: AryO) => {
    const seen = new Set<string>();
    const before = self.items.length;
    self.items = self.items.filter((x) => !seen.has(hashKey(x)) && seen.add(hashKey(x)));
    return self.items.length === before ? NIL : self;
  });
  def("compact", (vm2, self: AryO) => vm2.ary(self.items.filter((x) => x.t !== "nil")));
  def("compact!", (_vm, self: AryO) => {
    self.items = self.items.filter((x) => x.t !== "nil");
    return self;
  });
  def("flatten", (vm2, self: AryO, [d]) => {
    const depth = d ? idx(vm2, d) : Infinity;
    const flat = (xs: Value[], dd: number): Value[] => xs.flatMap((x) => (x.t === "array" && dd > 0 ? flat(x.items, dd - 1) : [x]));
    return vm2.ary(flat(self.items, depth));
  });
  def("delete", function* (vm2, self: AryO, [v]) {
    mut(self);
    let found: Value = NIL;
    const keep: Value[] = [];
    for (const x of self.items) {
      if (yield* eq(vm2, x, v)) found = x;
      else keep.push(x);
    }
    self.items = keep;
    return found;
  });
  def("delete_at", (vm2, self: AryO, [i]) => {
    mut(self);
    const n = norm(self, idx(vm2, i));
    if (n < 0 || n >= self.items.length) return NIL;
    return self.items.splice(n, 1)[0];
  });
  def("clear", (_vm, self: AryO) => {
    mut(self);
    self.items = [];
    return self;
  });
  def("replace", (_vm, self: AryO, [o]) => {
    mut(self);
    self.items = [...(o as AryO).items];
    return self;
  });
  def("fill", function* (vm2, self: AryO, [v], blk) {
    mut(self);
    for (let i = 0; i < self.items.length; i++) self.items[i] = blk.t === "proc" ? yield* callBlock(vm2, blk, [int(i)]) : v;
    return self;
  });
  def("sample", (vm2, self: AryO) => self.items[Math.floor(vm2.random() * self.items.length)] ?? NIL);
  def("shuffle", (vm2, self: AryO) => {
    const a = [...self.items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(vm2.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return vm2.ary(a);
  });
  def("transpose", (vm2, self: AryO) => {
    const rows = self.items as AryO[];
    if (!rows.length) return vm2.ary([]);
    return vm2.ary(rows[0].items.map((_, i) => vm2.ary(rows.map((r) => r.items[i]))));
  });
  def("product", (vm2, self: AryO, others) => {
    let acc: Value[][] = self.items.map((x) => [x]);
    for (const o of others) acc = acc.flatMap((p) => (o as AryO).items.map((x) => [...p, x]));
    return vm2.ary(acc.map((p) => vm2.ary(p)));
  });
  def("combination", function* (vm2, self: AryO, [n], blk) {
    const k = idx(vm2, n);
    const res: Value[] = [];
    const rec = (start: number, cur: Value[]) => {
      if (cur.length === k) {
        res.push(vm2.ary(cur));
        return;
      }
      for (let i = start; i < self.items.length; i++) rec(i + 1, [...cur, self.items[i]]);
    };
    rec(0, []);
    if (blk.t !== "proc") return vm2.ary(res);
    for (const c of res) yield* callBlock(vm2, blk, [c]);
    return self;
  });
  def("pack", (vm2) => vm2.str(""));
}

// ───────────────────────── Hash ─────────────────────────

function installHash(vm: VM, H: ClassO) {
  const def = (names: string | string[], fn: Native) => {
    for (const n of typeof names === "string" ? [names] : names) vm.defineNative(H, n, fn);
  };
  const mut = (self: HashO) => vm.checkFrozen(self);
  const pairs = (self: HashO) => [...self.map.values()];
  def("initialize", (_vm, self: HashO, [d], blk) => {
    self.default = d ?? NIL;
    if (blk.t === "proc") (self as any).defaultProc = blk;
    return NIL;
  });
  def("[]", function* (vm2, self: HashO, [k]) {
    const v = vm2.hashGet(self, k);
    if (v !== undefined) return v;
    const dp = (self as any).defaultProc;
    if (dp) return yield* callBlock(vm2, dp, [self, k]);
    return self.default;
  });
  def(["[]=", "store"], (vm2, self: HashO, [k, v]) => {
    mut(self);
    vm2.hashSet(self, k, v);
    return v;
  });
  def("fetch", function* (vm2, self: HashO, [k, d], blk) {
    const v = vm2.hashGet(self, k);
    if (v !== undefined) return v;
    if (blk.t === "proc") return yield* callBlock(vm2, blk, [k]);
    if (d) return d;
    vm2.error("KeyError", `key not found: ${vm2.inspect(k)}`);
  });
  def("dig", function* (vm2, self: HashO, keys) {
    let cur: Value = self;
    for (const k of keys) {
      if (cur.t === "nil") return NIL;
      cur = yield* send(vm2, cur, "[]", [k]);
    }
    return cur;
  });
  def(["key?", "has_key?", "include?", "member?"], (vm2, self: HashO, [k]) => bool(vm2.hashGet(self, k) !== undefined));
  def(["value?", "has_value?"], (_vm, self: HashO, [v]) => bool(pairs(self).some(([, x]) => eqSync(x, v) === true)));
  def("key", (_vm, self: HashO, [v]) => pairs(self).find(([, x]) => eqSync(x, v) === true)?.[0] ?? NIL);
  def("keys", (vm2, self: HashO) => vm2.ary(pairs(self).map(([k]) => k)));
  def("values", (vm2, self: HashO) => vm2.ary(pairs(self).map(([, v]) => v)));
  def("values_at", (vm2, self: HashO, ks) => vm2.ary(ks.map((k) => vm2.hashGet(self, k) ?? self.default)));
  def(["size", "length", "count"], function* (vm2, self: HashO, _a, blk) {
    if (blk.t !== "proc") return int(self.map.size);
    let n = 0;
    for (const [k, v] of pairs(self)) if (truthy(yield* callBlock(vm2, blk, [k, v]))) n++;
    return int(n);
  });
  def("empty?", (_vm, self: HashO) => bool(self.map.size === 0));
  def(["each", "each_pair"], function* (vm2, self: HashO, _a, blk) {
    if (blk.t !== "proc") return enumFor(vm2, pairs(self).map(([k, v]) => vm2.ary([k, v])));
    for (const [k, v] of pairs(self)) yield* callBlock(vm2, blk, [vm2.ary([k, v])]);
    return self;
  });
  def("each_key", function* (vm2, self: HashO, _a, blk) {
    for (const [k] of pairs(self)) yield* callBlock(vm2, blk, [k]);
    return self;
  });
  def("each_value", function* (vm2, self: HashO, _a, blk) {
    for (const [, v] of pairs(self)) yield* callBlock(vm2, blk, [v]);
    return self;
  });
  const filt = (keep: boolean): Native =>
    function* (vm2, self: HashO, _a, blk) {
      const h = vm2.hash();
      for (const [k, v] of pairs(self)) if (truthy(yield* callBlock(vm2, blk, [k, v])) === keep) vm2.hashSet(h, k, v);
      return h;
    };
  def(["select", "filter"], filt(true));
  def("reject", filt(false));
  def("filter_map", function* (vm2, self: HashO, _a, blk) {
    const outl: Value[] = [];
    for (const [k, v] of pairs(self)) {
      const r = yield* callBlock(vm2, blk, [k, v]);
      if (truthy(r)) outl.push(r);
    }
    return vm2.ary(outl);
  });
  def(["delete_if", "reject!"], function* (vm2, self: HashO, _a, blk) {
    mut(self);
    for (const [k, v] of pairs(self)) if (truthy(yield* callBlock(vm2, blk, [k, v]))) self.map.delete(hashKey(k));
    return self;
  });
  def(["keep_if", "select!"], function* (vm2, self: HashO, _a, blk) {
    mut(self);
    for (const [k, v] of pairs(self)) if (!truthy(yield* callBlock(vm2, blk, [k, v]))) self.map.delete(hashKey(k));
    return self;
  });
  def("delete", function* (vm2, self: HashO, [k], blk) {
    mut(self);
    const v = vm2.hashGet(self, k);
    if (v === undefined) return blk.t === "proc" ? yield* callBlock(vm2, blk, [k]) : NIL;
    self.map.delete(hashKey(k));
    return v;
  });
  const merge = (inPlace: boolean): Native =>
    function* (vm2, self: HashO, others, blk) {
      if (inPlace) mut(self);
      const h = inPlace ? self : vm2.hash(pairs(self));
      if (!inPlace) h.default = self.default;
      for (const o of others) {
        if (o.t !== "hash") vm2.error("TypeError", "no implicit conversion into Hash");
        for (const [k, v] of pairs(o as HashO)) {
          const cur = vm2.hashGet(h, k);
          vm2.hashSet(h, k, cur !== undefined && blk.t === "proc" ? yield* callBlock(vm2, blk, [k, cur, v]) : v);
        }
      }
      return h;
    };
  def("merge", merge(false));
  def(["update", "merge!"], merge(true));
  def("to_h", function* (vm2, self: HashO, _a, blk) {
    if (blk.t !== "proc") return self;
    const h = vm2.hash();
    for (const [k, v] of pairs(self)) {
      const p = yield* callBlock(vm2, blk, [k, v]);
      if (p.t === "array") vm2.hashSet(h, p.items[0], p.items[1]);
    }
    return h;
  });
  def("to_a", (vm2, self: HashO) => vm2.ary(pairs(self).map(([k, v]) => vm2.ary([k, v]))));
  def("invert", (vm2, self: HashO) => vm2.hash(pairs(self).map(([k, v]) => [v, k])));
  def("transform_values", function* (vm2, self: HashO, _a, blk) {
    const h = vm2.hash();
    for (const [k, v] of pairs(self)) vm2.hashSet(h, k, yield* callBlock(vm2, blk, [v]));
    return h;
  });
  def("transform_keys", function* (vm2, self: HashO, _a, blk) {
    const h = vm2.hash();
    for (const [k, v] of pairs(self)) vm2.hashSet(h, yield* callBlock(vm2, blk, [k]), v);
    return h;
  });
  def("sort", function* (vm2, self: HashO) {
    const list = pairs(self).map(([k, v]) => vm2.ary([k, v]));
    return vm2.ary(yield* mergeSort(vm2, list, (a, b) => cmp(vm2, a, b)));
  });
  def("default", (_vm, self: HashO) => self.default);
  def("default=", (_vm, self: HashO, [v]) => {
    self.default = v;
    return v;
  });
  def("clear", (_vm, self: HashO) => {
    mut(self);
    self.map.clear();
    return self;
  });
  def(["inspect", "to_s"], function* (vm2, self) {
    return vm2.str(yield* inspect(vm2, self));
  });
  def("==", function* (vm2, self: HashO, [o]) {
    if (o.t !== "hash" || o.map.size !== self.map.size) return FALSE;
    for (const [key, [, v]] of self.map) {
      const ov = o.map.get(key);
      if (!ov || !(yield* eq(vm2, v, ov[1]))) return FALSE;
    }
    return TRUE;
  });
  def("hash", (_vm, self) => int(hashKey(self).length));
  def("first", (vm2, self: HashO, [n]) => {
    const list = pairs(self).map(([k, v]) => vm2.ary([k, v]));
    return n ? vm2.ary(list.slice(0, idx(vm2, n))) : (list[0] ?? NIL);
  });
  def(["any?"], function* (vm2, self: HashO, _a, blk) {
    if (blk.t !== "proc") return bool(self.map.size > 0);
    for (const [k, v] of pairs(self)) if (truthy(yield* callBlock(vm2, blk, [k, v]))) return TRUE;
    return FALSE;
  });
  def("sum", function* (vm2, self: HashO, [init], blk) {
    let acc: Value = init ?? int(0);
    for (const [k, v] of pairs(self)) acc = yield* send(vm2, acc, "+", [blk.t === "proc" ? yield* callBlock(vm2, blk, [k, v]) : vm2.ary([k, v])]);
    return acc;
  });
}

// ───────────────────────── Range ─────────────────────────

function installRange(vm: VM, R: ClassO) {
  const def = (names: string | string[], fn: Native) => {
    for (const n of typeof names === "string" ? [names] : names) vm.defineNative(R, n, fn);
  };
  def(["first", "begin"], (vm2, self: RangeO, [n]) => (n ? vm2.ary(vm2.rangeToArray(self).slice(0, idx(vm2, n))) : self.first));
  def(["last", "end"], (vm2, self: RangeO, [n]) => (n ? vm2.ary(vm2.rangeToArray(self).slice(-idx(vm2, n))) : self.last));
  def("min", (vm2, self: RangeO) => (cmpSync(self.first, self.last)! > 0 ? NIL : self.first));
  def("max", (vm2, self: RangeO) => {
    if (cmpSync(self.first, self.last)! > 0) return NIL;
    return self.excl && self.last.t === "int" ? int(self.last.v - 1n) : self.last;
  });
  def(["size", "count", "length"], function* (vm2, self: RangeO, args, blk) {
    if (blk.t === "proc" || args.length) {
      let n = 0;
      for (const x of vm2.rangeToArray(self)) if (blk.t === "proc" ? truthy(yield* callBlock(vm2, blk, [x])) : eqSync(x, args[0])) n++;
      return int(n);
    }
    return int(vm2.rangeToArray(self).length);
  });
  def("exclude_end?", (_vm, self: RangeO) => bool(self.excl));
  def("each", function* (vm2, self: RangeO, _a, blk) {
    if (blk.t !== "proc") return enumFor(vm2, vm2.rangeToArray(self));
    if (self.first.t === "int" && (self.last.t === "int" || self.last.t === "nil")) {
      const end = self.last.t === "nil" ? null : self.excl ? self.last.v - 1n : self.last.v;
      for (let i = self.first.v; end === null || i <= end; i++) yield* callBlock(vm2, blk, [int(i)]);
      return self;
    }
    for (const x of vm2.rangeToArray(self)) yield* callBlock(vm2, blk, [x]);
    return self;
  });
  def("reverse_each", function* (vm2, self: RangeO, _a, blk) {
    for (const x of vm2.rangeToArray(self).reverse()) yield* callBlock(vm2, blk, [x]);
    return self;
  });
  def("step", function* (vm2, self: RangeO, [n], blk) {
    const st = idx(vm2, n);
    const list = vm2.rangeToArray(self).filter((_, i) => i % st === 0);
    if (blk.t !== "proc") return enumFor(vm2, list);
    for (const x of list) yield* callBlock(vm2, blk, [x]);
    return self;
  });
  const cover = (vm2: VM, self: RangeO, v: Value) => {
    const lo = self.first.t === "nil" ? -1 : cmpSync(self.first, v);
    const hi = self.last.t === "nil" ? -1 : cmpSync(v, self.last);
    if (lo === undefined || hi === undefined) return false;
    return lo <= 0 && (self.excl ? hi < 0 : hi <= 0);
  };
  def(["include?", "member?", "cover?", "==="], (vm2, self: RangeO, [v]) => bool(cover(vm2, self, v)));
  def("sum", function* (vm2, self: RangeO, [init], blk) {
    if (blk.t !== "proc" && self.first.t === "int" && self.last.t === "int") {
      const a = self.first.v;
      const b = self.excl ? self.last.v - 1n : self.last.v;
      const base = init && init.t === "int" ? init.v : 0n;
      return int(b < a ? base : base + ((a + b) * (b - a + 1n)) / 2n);
    }
    let acc: Value = init ?? int(0);
    for (const x of vm2.rangeToArray(self)) acc = yield* send(vm2, acc, "+", [blk.t === "proc" ? yield* callBlock(vm2, blk, [x]) : x]);
    return acc;
  });
  def(["inspect", "to_s"], (vm2, self) => vm2.str(vm2.inspect(self)));
  def("to_a", (vm2, self: RangeO) => vm2.ary(vm2.rangeToArray(self)));
  def("==", (_vm, self, [o]) => bool(eqSync(self, o) === true));
  def("hash", (_vm, self) => int(hashKey(self).length));
}

export { send as sendFromNative, callBlock, NIL, TRUE, FALSE };
