import { useMemo, useState } from "react";
import type { Program } from "../yarv/iseq";
import { CATEGORY_LABEL, Category, INSN_LIST } from "../yarv/insns";
import { T, useLang, useT } from "../i18n";

const LESSONS = [
  { id: "overview", title: ["全体像", "Overview"] },
  { id: "stack", title: ["スタックマシン", "Stack machine"] },
  { id: "format", title: ["命令の形", "Instruction format"] },
  { id: "frame", title: ["VM スタックとフレーム", "VM stack & frames"] },
  { id: "call", title: ["メソッド呼び出しとブロック", "Method calls & blocks"] },
  { id: "throw", title: ["例外と脱出", "Exceptions & escapes"] },
  { id: "ops", title: ["命令一覧", "Instruction list"] },
  { id: "howto", title: ["手元で確かめる", "Try it yourself"] },
] as const;

type LessonId = (typeof LESSONS)[number]["id"];

export function Learn({ program }: { program: Program | null }) {
  const [tab, setTab] = useState<LessonId>("overview");
  const t = useT();
  return (
    <section id="learn" className="learn">
      <div className="section-head">
        <span className="eyebrow">{t("しくみ", "How it works")}</span>
        <h2>{t("Ruby VM (YARV) のしくみを学ぶ", "Learn how the Ruby VM (YARV) works")}</h2>
        <p>{t("シミュレーターで見えているものが何なのか、順番に説明します。", "Step by step, here is what you are seeing in the simulator.")}</p>
      </div>
      <div className="lesson-tabs" role="tablist">
        {LESSONS.map((l, i) => (
          <button key={l.id} role="tab" aria-selected={tab === l.id} className={tab === l.id ? "on" : ""} onClick={() => setTab(l.id)}>
            <span className="lesson-no">{i + 1}</span>
            {t(l.title[0], l.title[1])}
          </button>
        ))}
      </div>
      <div className="lesson">
        {tab === "overview" && <Overview />}
        {tab === "stack" && <StackLesson />}
        {tab === "format" && <InsnFormat />}
        {tab === "frame" && <FrameLesson />}
        {tab === "call" && <CallLesson />}
        {tab === "throw" && <ThrowLesson />}
        {tab === "ops" && <OpTable program={program} />}
        {tab === "howto" && <HowTo />}
      </div>
    </section>
  );
}

function Overview() {
  const t = useT();
  return (
    <div className="lesson-body">
      <div className="flow">
        <div className="flow-box">
          <span className="flow-tag">{t("ソース", "Source")}</span>
          <code>hello.rb</code>
          <pre>{`a = 1\nb = 2\nputs a + b`}</pre>
        </div>
        <div className="flow-arrow">
          <span>Prism → compile.c</span>
          <small>{t("構文解析とコンパイル", "parse & compile")}</small>
        </div>
        <div className="flow-box">
          <span className="flow-tag">{t("命令列 (iseq)", "Instructions (iseq)")}</span>
          <code>RubyVM::InstructionSequence</code>
          <pre>{`putobject_INT2FIX_1_\nsetlocal_WC_0 a@0\n…\nopt_plus <:+>\nopt_send_without_block <:puts>`}</pre>
        </div>
        <div className="flow-arrow">
          <span>YARV</span>
          <small>{t("実行", "execute")}</small>
        </div>
        <div className="flow-box vm-loop">
          <span className="flow-tag">{t("VM のループ", "The VM loop")}</span>
          <ol>
            <li>
              <b>{t("フェッチ", "Fetch")}</b> {t("pc の位置から命令を読む", "read the instruction at pc")}
            </li>
            <li>
              <b>{t("デコード", "Decode")}</b> {t("命令の種類とオペランドを取り出す", "get the instruction type and operands")}
            </li>
            <li>
              <b>{t("実行", "Execute")}</b> {t("スタックに積み下ろしし、pc を進める", "push/pop the stack and advance pc")}
            </li>
          </ol>
        </div>
      </div>
      <T
        ja={
          <div className="cols">
            <div>
              <h3>YARV とは</h3>
              <p>
                YARV (Yet Another Ruby VM) は、Ruby 1.9 から CRuby に入っている仮想マシンです。<code>ruby hello.rb</code> を実行すると、CRuby はまずソースを構文解析し (Ruby 3.4
                からは Prism というパーサが標準)、その結果を YARV の命令列 (<b>iseq</b>: instruction sequence) にコンパイルしてから、VM で実行します。ファイルに保存されないだけで、毎回コンパイルしているのです。
              </p>
            </div>
            <div>
              <h3>VM がやっていること</h3>
              <p>
                VM の中心は <code>vm_exec.c</code> のループで、各命令の処理は <code>insns.def</code> に書かれています。<b>pc</b> (プログラムカウンタ) が指す命令を 1
                つ読み、その処理をして、次の命令に進む…を繰り返します。分岐命令は pc を書き換え、メソッド呼び出し命令は新しいフレームを積みます。
              </p>
            </div>
            <div>
              <h3>このサイトのしくみ</h3>
              <p>
                コンパイルは<b>本物の CRuby</b> (ruby.wasm でブラウザの中で動く Ruby 4.0) が行い、<code>RubyVM::InstructionSequence#to_a</code> で命令列を取り出しています。実行は、1
                命令ずつ止めて中身を見せるために YARV を TypeScript で再実装した VM が行います。組み込みメソッド (<code>puts</code> や <code>Array#each</code> など) も TypeScript 製です。
              </p>
            </div>
          </div>
        }
        en={
          <div className="cols">
            <div>
              <h3>What is YARV?</h3>
              <p>
                YARV (Yet Another Ruby VM) is the virtual machine that has been part of CRuby since Ruby 1.9. When you run <code>ruby hello.rb</code>, CRuby first
                parses the source (with the Prism parser by default since Ruby 3.4), compiles the result into a YARV instruction sequence (<b>iseq</b>), and then
                runs it on the VM. It compiles every time; it just does not save the result to a file.
              </p>
            </div>
            <div>
              <h3>What the VM does</h3>
              <p>
                At the heart of the VM is the loop in <code>vm_exec.c</code>, and each instruction's behavior is written in <code>insns.def</code>. It reads the
                instruction that <b>pc</b> (the program counter) points to, does what it says, moves on to the next one, and repeats. Branch instructions rewrite
                pc, and method-call instructions push a new frame.
              </p>
            </div>
            <div>
              <h3>How this site works</h3>
              <p>
                Compilation is done by <b>the real CRuby</b> (Ruby 4.0 running in your browser via ruby.wasm), and the instructions are taken out with{" "}
                <code>RubyVM::InstructionSequence#to_a</code>. Execution is done by a reimplementation of YARV in TypeScript, so that it can stop at every
                instruction and show what is inside. Builtin methods (<code>puts</code>, <code>Array#each</code>, ...) are also written in TypeScript.
              </p>
            </div>
          </div>
        }
      />
    </div>
  );
}

function StackLesson() {
  const t = useT();
  const steps = [
    { insn: "getlocal a", stack: ["1"], note: t("a の値を積む", "push the value of a") },
    { insn: "getlocal b", stack: ["1", "2"], note: t("b の値を積む", "push the value of b") },
    { insn: "opt_plus", stack: ["3"], note: t("上の 2 つを取り出し、足した結果を積む", "pop the top two and push their sum") },
    { insn: "setlocal c", stack: [], note: t("取り出して c に入れる", "pop it into c") },
  ];
  return (
    <div className="lesson-body">
      <T
        ja={
          <p>
            YARV は<b>スタックマシン</b>です。命令は計算に使う値の場所を指定しません。値はいつも<b>オペランドスタック</b>の上に積まれていて、命令はそこから取り出し (pop)、結果を積みます
            (push)。<code>c = a + b</code> は次の 4 命令になります。
          </p>
        }
        en={
          <p>
            YARV is a <b>stack machine</b>. Instructions do not name where their values live. The values are always on top of the <b>operand stack</b>; an
            instruction pops them and pushes its result. <code>c = a + b</code> becomes these four instructions.
          </p>
        }
      />
      <div className="stack-steps">
        {steps.map((s, i) => (
          <div key={i} className="ss">
            <code className="ss-insn">{s.insn}</code>
            <div className="ss-stack">
              {s.stack.length === 0 ? <span className="muted small">{t("(空)", "(empty)")}</span> : s.stack.map((v, j) => <span key={j}>{v}</span>)}
            </div>
            <small>{s.note}</small>
          </div>
        ))}
      </div>
      <div className="cols">
        <div>
          <h3>{t("レジスタマシンとの違い", "Compared with a register machine")}</h3>
          <div className="compare">
            <div>
              <h4>{t("スタックマシン (CRuby の YARV)", "Stack machine (CRuby's YARV)")}</h4>
              <pre>{`getlocal a\ngetlocal b\nopt_plus\nsetlocal c`}</pre>
            </div>
            <div>
              <h4>{t("レジスタマシン (mruby)", "Register machine (mruby)")}</h4>
              <pre>{`MOVE R4 R1   ; a\nMOVE R5 R2   ; b\nADD  R4 R5\nMOVE R3 R4   ; c`}</pre>
            </div>
          </div>
          <T
            ja={
              <p>
                mruby のようなレジスタマシンは、命令が「R4 と R5 を足して R4 に入れる」のように場所を番号で指定します。スタックマシンは場所を書かなくてよいぶん、命令が短く、コンパイラも素直に作れます。その代わり命令の数は多くなりがちです。
              </p>
            }
            en={
              <p>
                In a register machine such as mruby, an instruction names locations by number, like "add R4 and R5 and put the result in R4". A stack machine
                does not need to write locations, so instructions are shorter and the compiler is simpler. In exchange, it tends to need more instructions.
              </p>
            }
          />
        </div>
        <div>
          <h3>{t("式の評価順がそのまま命令になる", "Evaluation order becomes the instruction order")}</h3>
          <T
            ja={
              <p>
                <code>puts(a + b)</code> は、レシーバ (self)、引数、メソッド呼び出し…と、<b>先に評価するものから順に積む</b>だけでコンパイルできます。
              </p>
            }
            en={
              <p>
                <code>puts(a + b)</code> compiles by simply <b>pushing things in the order they are evaluated</b>: the receiver (self), the arguments, then
                the method call.
              </p>
            }
          />
          <pre>
            {t(
              `putself          # レシーバ\ngetlocal a\ngetlocal b\nopt_plus         # a + b を計算 → 引数\nopt_send_without_block :puts`,
              `putself          # receiver\ngetlocal a\ngetlocal b\nopt_plus         # compute a + b → argument\nopt_send_without_block :puts`,
            )}
          </pre>
          <p>
            {t(
              "メソッド呼び出し命令は、積まれているレシーバと引数をまとめて取り出し、戻り値を積みます。",
              "The method-call instruction pops the receiver and arguments together and pushes the return value.",
            )}
          </p>
        </div>
        <div>
          <h3>stack_max</h3>
          <T
            ja={
              <p>
                各 iseq には、オペランドスタックが最大でいくつまで伸びるか (<code>stack_max</code>) がコンパイル時に記録されています。VM はフレームを積むとき、この分の空きがあるかを確かめて、足りなければ{" "}
                <code>SystemStackError</code> にします。
              </p>
            }
            en={
              <p>
                Each iseq records at compile time how high its operand stack can grow (<code>stack_max</code>). When the VM pushes a frame, it checks that
                there is that much room, and raises <code>SystemStackError</code> if not.
              </p>
            }
          />
        </div>
      </div>
    </div>
  );
}

function InsnFormat() {
  const t = useT();
  return (
    <div className="lesson-body">
      <T
        ja={
          <p>
            iseq の命令列は、<b>語 (word)</b> の並びです。1 語目が命令の種類、その後ろにオペランドが 0 個以上続きます。オペランドは数値だけでなく、Ruby のオブジェクトそのもの
            (リテラル)、呼び出し情報 (calldata)、子の iseq など何でも入ります。pc は「何語目か」を表すので、命令の長さはオペランドの数 + 1 です。
          </p>
        }
        en={
          <p>
            An iseq is a sequence of <b>words</b>. The first word is the instruction type, followed by zero or more operands. Operands are not just numbers:
            they can be Ruby objects themselves (literals), call information (calldata), child iseqs, and so on. pc counts words, so an instruction's length
            is the number of operands + 1.
          </p>
        }
      />
      <div className="wordbox big">
        <div className="word w-insn">
          <span className="word-val">putobject</span>
          <span className="word-label">{t("命令", "insn")}</span>
        </div>
        <div className="word w-operand">
          <span className="word-val">2</span>
          <span className="word-label">val</span>
        </div>
        <div className="word w-insn">
          <span className="word-val">opt_send_without_block</span>
          <span className="word-label">{t("命令", "insn")}</span>
        </div>
        <div className="word w-operand">
          <span className="word-val">&lt;calldata!mid:p, argc:1&gt;</span>
          <span className="word-label">cd</span>
        </div>
        <div className="word w-insn">
          <span className="word-val">leave</span>
          <span className="word-label">{t("命令", "insn")}</span>
        </div>
      </div>
      <T
        ja={
          <div className="cols">
            <div>
              <h3>オペランドを埋め込んだ特化命令</h3>
              <p>
                よく使う組み合わせは、オペランドを命令名に埋め込んだ専用命令になっています。<code>putobject_INT2FIX_1_</code> は <code>putobject 1</code>、
                <code>getlocal_WC_0</code> は「今のフレームの (level 0 の) ローカル変数を読む」<code>getlocal</code> です。命令が 1 語短くなり、分岐も減ります。
              </p>
            </div>
            <div>
              <h3>opt_ 命令と高速パス</h3>
              <p>
                <code>a + b</code> は本来 <code>a.+(b)</code> というメソッド呼び出しですが、<code>opt_plus</code> 命令になります。両方が Integer で <code>Integer#+</code>
                が再定義されていなければ、メソッドを呼ばずに VM の中で直接足し算します。それ以外のときは普通のメソッド呼び出しに切り替わります。シミュレーターの説明にはどちらを通ったかが出ます。
              </p>
            </div>
            <div>
              <h3>calldata</h3>
              <p>
                メソッド呼び出し命令のオペランド <code>&lt;calldata!mid:puts, argc:1, FCALL|ARGS_SIMPLE&gt;</code> には、メソッド名・引数の数・呼び出し方のフラグ (レシーバ省略の
                FCALL、<code>*args</code> の ARGS_SPLAT、キーワード引数の KWARG など) が入っています。実際の CRuby では、ここにメソッド探索結果のキャッシュも置かれます。
              </p>
            </div>
          </div>
        }
        en={
          <div className="cols">
            <div>
              <h3>Specialized instructions with embedded operands</h3>
              <p>
                Common combinations get their own instructions with the operand embedded in the name. <code>putobject_INT2FIX_1_</code> is{" "}
                <code>putobject 1</code>, and <code>getlocal_WC_0</code> is a <code>getlocal</code> that reads a local variable of the current frame (level 0).
                The instruction is one word shorter, and there is less branching.
              </p>
            </div>
            <div>
              <h3>opt_ instructions and the fast path</h3>
              <p>
                <code>a + b</code> is really the method call <code>a.+(b)</code>, but it compiles to <code>opt_plus</code>. If both are Integers and{" "}
                <code>Integer#+</code> is not redefined, the VM adds them directly without calling a method. Otherwise it falls back to a normal method call.
                The simulator's description tells you which path was taken.
              </p>
            </div>
            <div>
              <h3>calldata</h3>
              <p>
                The operand of a method-call instruction, <code>&lt;calldata!mid:puts, argc:1, FCALL|ARGS_SIMPLE&gt;</code>, holds the method name, the number
                of arguments, and flags for how it is called (FCALL for an omitted receiver, ARGS_SPLAT for <code>*args</code>, KWARG for keyword arguments,
                ...). In the real CRuby, a cache of the method lookup result also lives here.
              </p>
            </div>
          </div>
        }
      />
    </div>
  );
}

function FrameLesson() {
  const t = useT();
  const rows = [
    { k: "op", label: t("オペランドスタック", "operand stack"), note: t("計算途中の値。sp が次に積む位置を指す", "values in the middle of a computation; sp points to the next free slot") },
    { k: "env", label: "flags", note: t("フレームの種類 (METHOD, BLOCK…)。ep はここを指す", "the frame type (METHOD, BLOCK, ...); ep points here"), ep: true },
    { k: "env", label: "specval", note: t("渡されたブロック、またはブロックの外側の環境 (前の ep)", "the given block, or the block's outer environment (previous ep)") },
    { k: "env", label: "me / cref", note: t("実行中のメソッド、または定義先のクラス", "the running method, or the class to define in") },
    { k: "local", label: t("ローカル変数 …", "local variables ..."), note: t("引数もここに入る", "arguments live here too") },
    { k: "recv", label: t("レシーバ (self)", "receiver (self)"), note: t("メソッド呼び出しのとき", "for method calls") },
  ];
  return (
    <div className="lesson-body">
      <div className="cols">
        <div>
          <h3>{t("1 本の VM スタック", "One VM stack")}</h3>
          <T
            ja={
              <p>
                CRuby は、すべてのフレームの値を <b>1 本の VM スタック</b>に積みます。1 つのフレームは下から順に、ローカル変数、3 つの <b>env データ</b>、オペランドスタックの並びです。
              </p>
            }
            en={
              <p>
                CRuby puts the values of all frames on <b>a single VM stack</b>. From the bottom, a frame consists of its local variables, three slots of{" "}
                <b>env data</b>, and its operand stack.
              </p>
            }
          />
          <div className="framefig">
            {rows.map((r, i) => (
              <div key={i} className={`ff ff-${r.k}`}>
                <b>{r.label}</b>
                <small>{r.note}</small>
                {r.ep && <span className="ptr ptr-ep">← ep</span>}
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3>{t("ep と sp", "ep and sp")}</h3>
          <T
            ja={
              <>
                <p>
                  <b>sp</b> (スタックポインタ) は次に値を積む位置、<b>ep</b> (環境ポインタ) は env データの flags の位置を指します。ローカル変数は ep からの距離で指定されます。
                  <code>getlocal_WC_0 a@0</code> の内部の値は <code>4</code> で、「ep の 4 つ下」を読むという意味です (env データが 3 つあるので、最後のローカル変数が ep-3)。
                </p>
                <p>pop しても値は消えません。sp が下がるだけで、次に積まれたときに上書きされます。シミュレーターでは sp より上の値を薄く表示しています。</p>
              </>
            }
            en={
              <>
                <p>
                  <b>sp</b> (the stack pointer) points to where the next value will be pushed, and <b>ep</b> (the environment pointer) points to the flags
                  slot of the env data. Local variables are addressed by their distance from ep. The raw operand of <code>getlocal_WC_0 a@0</code> is{" "}
                  <code>4</code>, meaning "read 4 slots below ep" (there are three env data slots, so the last local variable is at ep-3).
                </p>
                <p>
                  Popping does not erase a value. sp just moves down, and the slot is overwritten by the next push. The simulator shows values above sp in a
                  faded style.
                </p>
              </>
            }
          />
        </div>
        <div>
          <h3>{t("制御フレーム (cfp)", "Control frames (cfp)")}</h3>
          <T
            ja={
              <p>
                VM スタックとは別に、<b>制御フレーム</b> (<code>rb_control_frame_t</code>) の列があります。それぞれが pc・sp・ep・self・iseq を持ち、「今どの iseq のどこを実行していて、値はスタックのどこにあるか」を表します。
                右側の「制御フレーム」パネルがこれです。組み込みメソッド (C 関数) も CFUNC フレームを積みます。
              </p>
            }
            en={
              <p>
                Separately from the VM stack, there is a list of <b>control frames</b> (<code>rb_control_frame_t</code>). Each has a pc, sp, ep, self, and
                iseq, describing which iseq is running where and where its values are on the stack. This is the "Control frames" panel on the right. Builtin
                methods (C functions) also push CFUNC frames.
              </p>
            }
          />
        </div>
      </div>
    </div>
  );
}

function CallLesson() {
  return (
    <div className="lesson-body">
      <CallFigure />
      <T
        ja={
          <div className="cols">
            <div>
              <h3>引数はコピーされない</h3>
              <p>
                <code>add(1, 2)</code> を呼ぶとき、呼び出し元はレシーバと引数をオペランドスタックに積みます。新しいフレームは<b>その引数の位置から</b>始まるので、積まれた引数がそのまま呼び出し先のローカル変数
                <code>a</code>・<code>b</code> になります。その上に env データが置かれ、呼び出し先のオペランドスタックが続きます。
              </p>
            </div>
            <div>
              <h3>leave で戻る</h3>
              <p>
                <code>leave</code> はフレームを外し、戻り値をレシーバがあった位置に書き込みます。呼び出し元から見ると「レシーバと引数を取り出して、戻り値を 1 つ積んだ」ことになり、スタックマシンの命令として辻褄が合います。
              </p>
            </div>
            <div>
              <h3>ブロックと外側の変数</h3>
              <p>
                ブロックのフレームの specval には、ブロックを作ったフレームの ep (<b>前の ep</b>) が入ります。<code>getlocal_WC_1</code> は ep を 1 回たどった先、つまりブロックの外側のローカル変数を読みます。
              </p>
              <p>
                ブロックが <code>lambda</code> や <code>proc</code> で Proc オブジェクトになると、外側のフレームが終わっても変数を使えるよう、環境は<b>スタックからヒープへ移されます</b>
                (サンプル「クロージャ」で確認できます)。
              </p>
            </div>
          </div>
        }
        en={
          <div className="cols">
            <div>
              <h3>Arguments are not copied</h3>
              <p>
                To call <code>add(1, 2)</code>, the caller pushes the receiver and the arguments onto its operand stack. The new frame starts{" "}
                <b>right at those arguments</b>, so the pushed arguments become the callee's local variables <code>a</code> and <code>b</code> as is. The
                env data goes on top of them, followed by the callee's operand stack.
              </p>
            </div>
            <div>
              <h3>Returning with leave</h3>
              <p>
                <code>leave</code> removes the frame and writes the return value where the receiver was. From the caller's point of view, it "popped the
                receiver and arguments and pushed one return value", which is exactly how a stack-machine instruction should behave.
              </p>
            </div>
            <div>
              <h3>Blocks and outer variables</h3>
              <p>
                The specval of a block's frame holds the ep of the frame that created the block (the <b>previous ep</b>). <code>getlocal_WC_1</code> follows
                ep once, so it reads a local variable outside the block.
              </p>
              <p>
                When a block becomes a Proc object through <code>lambda</code> or <code>proc</code>, its environment is <b>moved from the stack to the heap</b>,
                so the variables survive after the outer frame ends (see the "Closures" sample).
              </p>
            </div>
          </div>
        }
      />
    </div>
  );
}

/** The VM stack before and after calling add(1, 2). Each row is the same slot */
const CALL_ROWS: [string, string, string, string, string][] = [
  // [before (Japanese), before (English), before kind, after, after kind]
  ["", "", "free", "flags ← ep", "env2"],
  ["", "", "free", "specval", "env2"],
  ["", "", "free", "me: Object#add", "env2"],
  ["2 (引数)", "2 (argument)", "op", "b = 2", "local"],
  ["1 (引数)", "1 (argument)", "op", "a = 1", "local"],
  ["main (レシーバ)", "main (receiver)", "op", "main (self)", "recv"],
  ["flags ← ep", "flags ← ep", "env", "flags", "env"],
  ["specval", "specval", "env", "specval", "env"],
  ["me / cref", "me / cref", "env", "me / cref", "env"],
  ["main (self)", "main (self)", "env", "main (self)", "env"],
];

function CallFigure() {
  const t = useT();
  return (
    <div className="callgrid" aria-label={t("引数がそのままローカル変数になる図", "Diagram: arguments become local variables as is")}>
      <div className="cg-head">{t("スロット", "slot")}</div>
      <div className="cg-head">{t("呼び出す直前 (main が積んだ値)", "Just before the call (pushed by main)")}</div>
      <div className="cg-head">{t("呼び出した直後 (add のフレーム)", "Just after the call (add's frame)")}</div>
      {CALL_ROWS.map(([ja, en, ak, b, bk], i) => (
        <div key={i} className="cg-row">
          <span className="cg-idx">{CALL_ROWS.length - 1 - i}</span>
          <span className={`cg-cell cg-${ak}`}>{ak === "free" ? t("空き", "free") : t(ja, en)}</span>
          <span className={`cg-cell cg-${bk}`}>{bk === "local" ? `${b} ${t("(ローカル変数)", "(local variable)")}` : b}</span>
        </div>
      ))}
    </div>
  );
}

function ThrowLesson() {
  return (
    <div className="lesson-body">
      <T
        ja={
          <div className="cols">
            <div>
              <h3>例外ハンドラ表 (catch table)</h3>
              <p>
                <code>begin ... rescue ... end</code> の rescue 節は、本体とは別の iseq にコンパイルされます。本体の iseq には「この範囲 (start〜end) で例外が起きたら、この iseq を実行して、終わったら cont から続ける」という表
                (<b>catch table</b>) が付いています。
              </p>
              <p>
                例外が起きると VM は、今のフレームの表に当てはまる行がないか探し、なければフレームを 1 つ外して呼び出し元の表を探す…を繰り返します。見つかったら rescue 節を新しいフレーム (RESCUE)
                として積みます。このとき例外オブジェクトが rescue 節のローカル変数 <code>$!</code> になります。
              </p>
            </div>
            <div>
              <h3>ensure</h3>
              <p>
                ensure 節は 2 か所にコンパイルされます。何事もなく終わったときのために本体の最後に<b>そのまま埋め込まれ</b>、例外や break で抜けるときのために別の iseq にもなって catch table に登録されます。
                ensure の iseq は最後に <code>throw 0</code> で、中断していた例外や脱出を再開します。
              </p>
            </div>
            <div>
              <h3>throw 命令と break / return</h3>
              <p>
                ブロックの中の <code>break</code> や、ブロックの中からメソッドを抜ける <code>return</code> は、フレームをまたぐので単純なジャンプでは済みません。<code>throw</code>
                命令が脱出先のフレームを決め、例外と同じようにフレームを外していきます (途中に ensure があれば実行します)。break の行き先は、ブロックを渡した <code>send</code> の直後です。
              </p>
              <p>
                <code>retry</code> は rescue 節から本体の先頭へ、<code>next</code> はブロックの終わりへ戻る脱出で、それぞれ catch table の retry / next の行が行き先を表します。
              </p>
            </div>
          </div>
        }
        en={
          <div className="cols">
            <div>
              <h3>The catch table</h3>
              <p>
                The rescue clause of <code>begin ... rescue ... end</code> is compiled into an iseq separate from the body. The body's iseq carries a table (the{" "}
                <b>catch table</b>) saying "if an exception happens in this range (start to end), run this iseq, and when it finishes, continue from cont".
              </p>
              <p>
                When an exception happens, the VM looks for a matching row in the current frame's table; if there is none, it removes the frame and looks in
                the caller's table, and so on. When it finds one, it pushes the rescue clause as a new frame (RESCUE), and the exception object becomes the
                rescue clause's local variable <code>$!</code>.
              </p>
            </div>
            <div>
              <h3>ensure</h3>
              <p>
                An ensure clause is compiled in two places. It is <b>inlined at the end of the body</b> for the normal path, and also compiled into a separate
                iseq registered in the catch table for leaving by an exception or break. The ensure iseq ends with <code>throw 0</code>, which resumes the
                interrupted exception or escape.
              </p>
            </div>
            <div>
              <h3>The throw instruction, break, and return</h3>
              <p>
                <code>break</code> inside a block, or <code>return</code> from a method inside a block, crosses frames, so a plain jump is not enough. The{" "}
                <code>throw</code> instruction decides the target frame and removes frames just like an exception does (running any ensure on the way). A
                break lands right after the <code>send</code> that passed the block.
              </p>
              <p>
                <code>retry</code> escapes from a rescue clause back to the start of the body, and <code>next</code> to the end of a block; the retry / next
                rows of the catch table tell where to go.
              </p>
            </div>
          </div>
        }
      />
    </div>
  );
}

function OpTable({ program }: { program: Program | null }) {
  const t = useT();
  const lang = useLang();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category | "all">("all");
  const [onlyUsed, setOnlyUsed] = useState(false);
  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of program?.iseqs ?? []) for (const i of s.insns) m.set(i.name, (m.get(i.name) ?? 0) + 1);
    return m;
  }, [program]);
  const list = useMemo(
    () =>
      INSN_LIST.filter(
        (o) =>
          (cat === "all" || o.category === cat) &&
          (!onlyUsed || used.has(o.name)) &&
          (q === "" || (o.name + o.doc + o.docEn).toLowerCase().includes(q.toLowerCase())),
      ),
    [q, cat, onlyUsed, used],
  );
  return (
    <div className="lesson-body">
      <div className="op-filter">
        <input
          type="search"
          placeholder={t("命令名や説明で検索 (例: send, ジャンプ)", "Search by name or description (e.g. send, jump)")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="toggle">
          <input type="checkbox" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} />
          {t("いまのプログラムで使われている命令だけ", "Only instructions used by the current program")}
        </label>
        <div className="cat-chips">
          <button className={cat === "all" ? "on" : ""} onClick={() => setCat("all")}>
            {t("すべて", "All")}
          </button>
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
            <button key={c} className={`cat-${c} ${cat === c ? "on" : ""}`} onClick={() => setCat(c)}>
              {t(...CATEGORY_LABEL[c])}
            </button>
          ))}
        </div>
      </div>
      <div className="optable-wrap">
        <table className="optable">
          <thead>
            <tr>
              <th>{t("命令", "Instruction")}</th>
              <th>{t("オペランド", "Operands")}</th>
              <th>{t("スタック (pop ⇒ push)", "Stack (pop ⇒ push)")}</th>
              <th>{t("説明", "Description")}</th>
              <th>{t("使用数", "Uses")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.name}>
                <td>
                  <span className={`opname cat-${o.category}`}>{o.name}</span>
                </td>
                <td className="mono">{o.operands.join(" ") || "—"}</td>
                <td className="mono sem">
                  {o.pop.join(" ") || "—"} ⇒ {o.push.join(" ") || "—"}
                </td>
                <td>{lang === "en" ? o.docEn : o.doc}</td>
                <td className="mono">{used.get(o.name) ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        {t(
          `${list.length} / ${INSN_LIST.length} 命令 (CRuby 4.0 の insns.def と特化命令。trace_ で始まる計測用の命令は除いています)`,
          `${list.length} / ${INSN_LIST.length} instructions (CRuby 4.0's insns.def plus specialized instructions; the trace_ instrumentation instructions are omitted)`,
        )}
      </p>
    </div>
  );
}

function HowTo() {
  return (
    <div className="lesson-body">
      <T
        ja={
          <div className="cols">
            <div>
              <h3>命令列を見る</h3>
              <pre className="cmd">{`ruby --dump=insns hello.rb`}</pre>
              <p>
                手元の Ruby で、このサイトと同じ命令列を逆アセンブルして表示できます。<code>RubyVM::InstructionSequence.compile("a + b").disasm</code> のように、Ruby の中からも見られます。
              </p>
            </div>
            <div>
              <h3>このサイトで動かす</h3>
              <p>
                シミュレーターの Ruby ソースの「書き換える」を押して、コードを書いて「コンパイルして実行」を押します。<code>.rb</code> ファイルをドロップしても読み込めます。
              </p>
              <p className="muted small">
                コードはブラウザの中だけで処理され、どこにも送信されません。組み込みメソッドは主要なものだけを実装しているため、Regexp・Struct・Fiber・ファイル入出力など一部の機能は動きません。
              </p>
            </div>
            <div>
              <h3>本物の VM のソースを読む</h3>
              <p>
                命令ごとの処理は <code>insns.def</code>、メソッド呼び出しや引数の受け取りは <code>vm_insnhelper.c</code> と <code>vm_args.c</code>、例外の処理は <code>vm.c</code> の{" "}
                <code>vm_exec_handle_exception</code> にあります。シミュレーターの説明文と見比べながら読むと、追いやすくなります。
              </p>
            </div>
          </div>
        }
        en={
          <div className="cols">
            <div>
              <h3>See the instructions</h3>
              <pre className="cmd">{`ruby --dump=insns hello.rb`}</pre>
              <p>
                Your local Ruby can disassemble the same instructions this site shows. You can also look at them from inside Ruby, as in{" "}
                <code>RubyVM::InstructionSequence.compile("a + b").disasm</code>.
              </p>
            </div>
            <div>
              <h3>Run it on this site</h3>
              <p>
                Press "Edit" on the Ruby source in the simulator, write your code, and press "Compile &amp; run". You can also drop a <code>.rb</code> file.
              </p>
              <p className="muted small">
                Your code is processed only in your browser and is never sent anywhere. Only the main builtin methods are implemented, so some features such as
                Regexp, Struct, Fiber, and file I/O do not work.
              </p>
            </div>
            <div>
              <h3>Read the real VM's source</h3>
              <p>
                Each instruction's behavior is in <code>insns.def</code>, method calls and argument handling are in <code>vm_insnhelper.c</code> and{" "}
                <code>vm_args.c</code>, and exception handling is in <code>vm_exec_handle_exception</code> in <code>vm.c</code>. Reading them side by side with
                the simulator's descriptions makes them easier to follow.
              </p>
            </div>
          </div>
        }
      />
    </div>
  );
}
