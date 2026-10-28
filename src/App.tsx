import { useEffect, useState } from "react";
import { Learn } from "./components/Learn";
import { Simulator } from "./components/Simulator";
import { useSimulator } from "./useSimulator";
import { initialLang, LangContext, type Lang, useT } from "./i18n";

type Theme = "light" | "dark" | "auto";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("theme") as Theme) || "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* failing to save does not affect anything */
    }
  }, [theme]);
  return [theme, setTheme];
}

function useLangState(): [Lang, (l: Lang) => void] {
  const [lang, setLang] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = lang === "en" ? "Ruby VM Visualizer" : "Ruby VM ビジュアライザ";
    try {
      localStorage.setItem("lang", lang);
    } catch {
      /* failing to save does not affect anything */
    }
  }, [lang]);
  return [lang, setLang];
}

export function App() {
  const [lang, setLang] = useLangState();
  return (
    <LangContext.Provider value={lang}>
      <Page lang={lang} setLang={setLang} />
    </LangContext.Provider>
  );
}

function Page({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const sim = useSimulator(lang);
  const [theme, setTheme] = useTheme();
  const t = useT();
  return (
    <>
      <header className="site-header">
        <a className="brand" href="#top">
          <svg viewBox="0 0 32 32" className="logo" aria-hidden>
            <path d="M8 4h16l6 8-14 17L2 12z" fill="var(--accent)" />
            <path d="M2 12h28M8 4l8 25M24 4l-8 25M8 4l3 8M24 4l-3 8" stroke="#fff" strokeOpacity=".45" fill="none" />
          </svg>
          <span>
            Ruby VM <b>{t("ビジュアライザ", "Visualizer")}</b>
          </span>
        </a>
        <nav>
          <a href="#simulator">{t("シミュレーター", "Simulator")}</a>
          <a href="#learn">{t("しくみ", "How it works")}</a>
          <div className="lang-switch" role="group" aria-label={t("表示言語", "Language")}>
            <button className={lang === "ja" ? "on" : ""} aria-pressed={lang === "ja"} onClick={() => setLang("ja")} lang="ja">
              日本語
            </button>
            <button className={lang === "en" ? "on" : ""} aria-pressed={lang === "en"} onClick={() => setLang("en")} lang="en">
              English
            </button>
          </div>
          <button
            className="theme-btn"
            onClick={() => setTheme(theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto")}
            title={t("表示テーマを切り替える", "Switch the color theme")}
          >
            {theme === "auto" ? t("自動", "Auto") : theme === "dark" ? t("ダーク", "Dark") : t("ライト", "Light")}
          </button>
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-text">
            <p className="eyebrow">{t("CRuby 4.0 の YARV 入門", "An introduction to YARV in CRuby 4.0")}</p>
            {lang === "en" ? (
              <h1>
                Look inside
                <br />
                the Ruby VM
              </h1>
            ) : (
              <h1>
                Ruby VM の
                <br />
                なかをのぞく
              </h1>
            )}
            <p className="tagline">
              <span>{t("積む", "Push")}</span>
              <i>·</i>
              <span>{t("取り出す", "Pop")}</span>
              <i>·</i>
              <span>{t("計算する", "Compute")}</span>
            </p>
            {lang === "en" ? (
              <p className="lead">
                Before a Ruby program runs, it is compiled into instructions for a VM called YARV. YARV is a <b>stack machine</b>: instructions push values
                onto a stack, pop them to compute, and push the result back. Calling a method pushes a frame, and the arguments become the callee's local
                variables as is. See it for yourself, together with the real Ruby compiler running in your browser.
              </p>
            ) : (
              <p className="lead">
                Ruby のプログラムは、実行の前に YARV という VM の命令列にコンパイルされます。YARV は<b>スタックマシン</b>。
                命令はスタックに値を積み、取り出して計算し、結果をまた積みます。メソッドを呼ぶとフレームが積まれ、引数はそのまま呼び出し先のローカル変数になります。
                その様子を、ブラウザの中で動く本物の Ruby のコンパイラと一緒に確かめてみましょう。
              </p>
            )}
            <div className="hero-cta">
              <a className="btn primary big" href="#simulator">
                {t("サンプルを動かす", "Run a sample")}
              </a>
              <a className="btn ghost big" href="#learn">
                {t("しくみを読む", "Read how it works")}
              </a>
            </div>
          </div>
          <HeroDiagram />
        </section>

        <Simulator sim={sim} />
        <Learn program={sim.loaded?.program ?? null} />
      </main>

      <footer className="site-footer">
        {lang === "en" ? (
          <p>
            Instruction definitions and semantics are based on CRuby's <a href="https://github.com/ruby/ruby/blob/ruby_4_0/insns.def">insns.def</a>,{" "}
            <a href="https://github.com/ruby/ruby/blob/ruby_4_0/vm_insnhelper.c">vm_insnhelper.c</a>, and{" "}
            <a href="https://github.com/ruby/ruby/blob/ruby_4_0/vm.c">vm.c</a>. Compilation uses <a href="https://github.com/ruby/ruby.wasm">ruby.wasm</a>.
          </p>
        ) : (
          <p>
            命令の定義と意味は CRuby の <a href="https://github.com/ruby/ruby/blob/ruby_4_0/insns.def">insns.def</a>、
            <a href="https://github.com/ruby/ruby/blob/ruby_4_0/vm_insnhelper.c">vm_insnhelper.c</a>、
            <a href="https://github.com/ruby/ruby/blob/ruby_4_0/vm.c">vm.c</a> にもとづいています。コンパイルには{" "}
            <a href="https://github.com/ruby/ruby.wasm">ruby.wasm</a> を使っています。
          </p>
        )}
      </footer>
    </>
  );
}

/** Hero diagram: loops over instructions pushing values onto the stack, popping them, and computing */
const HERO = [
  { op: "putobject", args: "1", stack: ["1"], a: "", b: "", out: "" },
  { op: "setlocal", args: "a", stack: [], a: "1", b: "", out: "" },
  { op: "putobject", args: "2", stack: ["2"], a: "1", b: "", out: "" },
  { op: "setlocal", args: "b", stack: [], a: "1", b: "2", out: "" },
  { op: "putself", args: "", stack: ["main"], a: "1", b: "2", out: "" },
  { op: "getlocal", args: "a", stack: ["main", "1"], a: "1", b: "2", out: "" },
  { op: "getlocal", args: "b", stack: ["main", "1", "2"], a: "1", b: "2", out: "" },
  { op: "opt_plus", args: "", stack: ["main", "3"], a: "1", b: "2", out: "" },
  { op: "send", args: ":puts", stack: ["nil"], a: "1", b: "2", out: "3" },
];

function HeroDiagram() {
  const t = useT();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((x) => (x + 1) % (HERO.length + 2)), 1300);
    return () => clearInterval(t);
  }, []);
  const state = i === 0 ? { stack: [], a: "", b: "", out: "" } : HERO[Math.min(i, HERO.length) - 1];
  const prevLen = i >= 2 ? HERO[Math.min(i, HERO.length) - 2].stack.length : 0;
  return (
    <div className="hero-diagram" aria-hidden>
      <div className="hd-iseq">
        <div className="hd-title">
          {t("命令列", "Instructions")} <code>a = 1; b = 2; puts a + b</code>
        </div>
        {HERO.map((x, k) => (
          <div key={k} className={`hd-insn ${k === i - 1 ? "cur" : ""} ${k < i - 1 ? "done" : ""}`}>
            <span className="hd-pc">{k === i - 1 ? "▶" : ""}</span>
            <span className="hd-op">{x.op}</span>
            <span className="hd-args">{x.args}</span>
          </div>
        ))}
      </div>
      <div className="hd-regs">
        <div className="hd-title">{t("ローカル変数", "Local variables")}</div>
        <div className={`hd-reg ${i >= 1 && HERO[i - 1]?.op === "setlocal" && HERO[i - 1]?.args === "a" ? "hit" : ""}`}>
          <span>a</span>
          <b>{state.a}</b>
        </div>
        <div className={`hd-reg ${i >= 1 && HERO[i - 1]?.op === "setlocal" && HERO[i - 1]?.args === "b" ? "hit" : ""}`}>
          <span>b</span>
          <b>{state.b}</b>
        </div>
        <div className="hd-title hd-st">{t("オペランドスタック", "Operand stack")}</div>
        <div className="hd-stack">
          {state.stack.map((v, k) => (
            <div key={`${k}-${v}`} className={`hd-slot ${k >= prevLen || (k === state.stack.length - 1 && i > 0) ? "new" : ""}`}>
              {v}
            </div>
          ))}
          {state.stack.length === 0 && <div className="hd-empty">{t("(空)", "(empty)")}</div>}
        </div>
        <div className="hd-out">
          <span>{t("出力", "Output")}</span>
          <b>{state.out}</b>
        </div>
      </div>
    </div>
  );
}
