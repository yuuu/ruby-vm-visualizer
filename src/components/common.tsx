import type { ReactNode } from "react";
import type { Value } from "../yarv/values";
import type { VM } from "../yarv/vm";
import { truncate } from "../yarv/vm";
import { pick, useLang, type Lang } from "../i18n";

export function Panel(props: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`panel ${props.className ?? ""}`}>
      <header className="panel-head">
        <h3>{props.title}</h3>
        {props.sub && <span className="panel-sub">{props.sub}</span>}
        {props.actions && <div className="panel-actions">{props.actions}</div>}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

export function typeInfo(vm: VM, v: Value): { label: string; cls: string } {
  switch (v.t) {
    case "nil":
      return { label: "nil", cls: "t-nil" };
    case "true":
    case "false":
      return { label: "bool", cls: "t-bool" };
    case "int":
      return { label: "Integer", cls: "t-int" };
    case "float":
      return { label: "Float", cls: "t-int" };
    case "sym":
      return { label: "Symbol", cls: "t-sym" };
    case "str":
      return { label: "String", cls: "t-str" };
    case "array":
      return { label: "Array", cls: "t-ary" };
    case "hash":
      return { label: "Hash", cls: "t-ary" };
    case "range":
      return { label: "Range", cls: "t-ary" };
    case "proc":
      return { label: v.lambda ? "Lambda" : "Proc", cls: "t-proc" };
    case "class":
      return { label: v.isModule ? "Module" : "Class", cls: "t-class" };
    case "object":
      if ((v as any).td) return { label: "THROW_DATA", cls: "t-proc" };
      if (v.ivars.has("__core")) return { label: "VM core", cls: "t-obj" };
      return { label: vm.realClassOf(v).name, cls: vm.isException(v) ? "t-exc" : "t-obj" };
  }
}

export function displayValue(vm: VM, v: Value, max = 48, lang: Lang = "ja"): string {
  if (v.t === "object" && (v as any).td) return vm.inspect(v);
  if (v.t === "proc") {
    const kind = v.isBlock ? pick(lang, "ブロック", "block") : v.lambda ? "lambda" : "Proc";
    return v.iseq ? `${kind} → ${v.iseq.label}` : v.symbol ? `&:${v.symbol}` : `${kind} ${pick(lang, "(組み込み)", "(builtin)")}`;
  }
  return truncate(vm.inspect(v), max);
}

export function ValueChip({ vm, v, max }: { vm: VM; v: Value; max?: number }) {
  const t = typeInfo(vm, v);
  const lang = useLang();
  return (
    <span className={`value ${t.cls}`} title={vm.inspect(v)}>
      {displayValue(vm, v, max, lang)}
    </span>
  );
}

export function Icon({ name }: { name: "reset" | "back" | "step" | "play" | "pause" | "end" | "upload" | "file" | "run" | "edit" }) {
  const paths: Record<string, ReactNode> = {
    reset: <path d="M4 4v6h6M4.5 10A8 8 0 1 0 6 5.3" />,
    back: <path d="M15 5l-7 7 7 7" />,
    step: <path d="M9 5l7 7-7 7" />,
    play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" />,
    pause: <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />,
    end: <path d="M5 5l7 7-7 7M13 5l7 7-7 7" />,
    upload: <path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4" />,
    file: <path d="M6 3h8l4 4v14H6zM14 3v4h4" />,
    run: <path d="M4 17l6-5-6-5M12 19h8" />,
    edit: <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />,
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[name]}
    </svg>
  );
}
