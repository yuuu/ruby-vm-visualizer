import { useCallback, useEffect, useRef, useState } from "react";
import { compileRuby } from "./compiler";
import { CompileError, loadDump, Program } from "./yarv/iseq";
import { StepInfo, VM } from "./yarv/vm";
import { pick, type Lang } from "./i18n";

export interface Loaded {
  name: string;
  program: Program;
  source: string;
}

export type CompileState = { status: "idle" } | { status: "loading"; loaded: number; total: number } | { status: "compiling" };

const RUN_LIMIT = 1_000_000;

export function useSimulator(lang: Lang) {
  const langRef = useRef(lang);
  langRef.current = lang;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compileState, setCompileState] = useState<CompileState>({ status: "idle" });
  const vmRef = useRef<VM | null>(null);
  const [last, setLast] = useState<StepInfo | null>(null);
  const [version, setVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Steps per second */
  const [speed, setSpeed] = useState(2);
  const [breakpoints, setBreakpoints] = useState<Set<string>>(new Set());
  const bpRef = useRef(breakpoints);
  bpRef.current = breakpoints;

  const bump = () => setVersion((v) => v + 1);

  const load = useCallback((name: string, json: string, source: string): boolean => {
    try {
      const program = loadDump(json);
      vmRef.current = new VM(program, langRef.current);
      setLoaded({ name, program, source });
      setLast(null);
      setError(null);
      setPlaying(false);
      setBreakpoints(new Set());
      bump();
      return true;
    } catch (e) {
      setError(e instanceof CompileError ? `${pick(langRef.current, "コンパイルエラー", "Compile error")}:\n${e.message}` : (e as Error).message);
      return false;
    }
  }, []);

  /** Compiles the source with ruby.wasm and loads it */
  const compile = useCallback(
    async (source: string, name = "main.rb") => {
      setError(null);
      setPlaying(false);
      try {
        setCompileState({ status: "loading", loaded: 0, total: 0 });
        const json = await compileRuby(source, (l, t) => setCompileState({ status: "loading", loaded: l, total: t }));
        setCompileState({ status: "compiling" });
        return load(name, json, source);
      } catch (e) {
        setError(`${pick(langRef.current, "ruby.wasm でのコンパイルに失敗しました", "Compiling with ruby.wasm failed")}: ${(e as Error).message}`);
        return false;
      } finally {
        setCompileState({ status: "idle" });
      }
    },
    [load],
  );

  const reset = useCallback(() => {
    if (!loaded) return;
    vmRef.current = new VM(loaded.program, langRef.current);
    setLast(null);
    setPlaying(false);
    bump();
  }, [loaded]);

  const step = useCallback(() => {
    const vm = vmRef.current;
    if (!vm || vm.halted) {
      setPlaying(false);
      return;
    }
    try {
      const info = vm.step();
      setLast(info);
    } catch (e) {
      vm.halted = true;
      vm.output.push({ text: `${pick(langRef.current, "VM の内部エラー", "VM internal error")}: ${(e as Error).message}\n`, kind: "err" });
    }
    if (vm.halted) setPlaying(false);
    bump();
  }, []);

  /** Steps back one step. The VM is deterministic, so re-run n-1 steps from the start */
  const back = useCallback(() => {
    const vm = vmRef.current;
    if (!vm || !loaded || vm.steps === 0) return;
    const target = vm.steps - 1;
    const fresh = new VM(loaded.program, langRef.current);
    let info: StepInfo | null = null;
    while (fresh.steps < target && !fresh.halted) info = fresh.step();
    vmRef.current = fresh;
    setLast(info);
    setPlaying(false);
    bump();
  }, [loaded]);

  // When the language changes, re-run to the same step count to rebuild the descriptions (the VM is deterministic)
  useEffect(() => {
    const vm = vmRef.current;
    if (!vm || !loaded || vm.lang === lang) return;
    const fresh = new VM(loaded.program, lang);
    let info: StepInfo | null = null;
    while (fresh.steps < vm.steps && !fresh.halted) info = fresh.step();
    vmRef.current = fresh;
    setLast(info);
    bump();
  }, [lang, loaded]);

  const atBreakpoint = (vm: VM) => {
    const f = vm.top();
    return !!f && !!f.iseq && bpRef.current.has(`${f.iseq.index}:${f.pc}`);
  };

  /** Runs until a breakpoint or the end */
  const runToEnd = useCallback(() => {
    const vm = vmRef.current;
    if (!vm) return;
    let info: StepInfo | null = null;
    const start = vm.steps;
    try {
      while (!vm.halted && vm.steps - start < RUN_LIMIT) {
        info = vm.step();
        if (atBreakpoint(vm)) break;
      }
      if (!vm.halted && vm.steps - start >= RUN_LIMIT) {
        vm.output.push({ text: pick(langRef.current, `${RUN_LIMIT.toLocaleString()} ステップで一時停止しました (無限ループの可能性)\n`, `Paused after ${RUN_LIMIT.toLocaleString()} steps (possibly an infinite loop)\n`), kind: "err" });
      }
    } catch (e) {
      vm.halted = true;
      vm.output.push({ text: `${pick(langRef.current, "VM の内部エラー", "VM internal error")}: ${(e as Error).message}\n`, kind: "err" });
    }
    setLast(info);
    setPlaying(false);
    bump();
  }, []);

  // Auto-run
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      step();
      const vm = vmRef.current;
      if (vm && atBreakpoint(vm)) setPlaying(false);
    }, 1000 / speed);
    return () => clearTimeout(t);
  }, [playing, version, speed, step]);

  const toggleBreakpoint = useCallback((iseq: number, pc: number) => {
    setBreakpoints((s) => {
      const n = new Set(s);
      const k = `${iseq}:${pc}`;
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }, []);

  return {
    loaded,
    error,
    setError,
    compileState,
    vm: vmRef.current,
    last,
    version,
    playing,
    setPlaying,
    speed,
    setSpeed,
    breakpoints,
    toggleBreakpoint,
    load,
    compile,
    reset,
    step,
    back,
    runToEnd,
  };
}

export type Simulator = ReturnType<typeof useSimulator>;
