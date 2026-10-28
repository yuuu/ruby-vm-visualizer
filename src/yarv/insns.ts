// The YARV instruction table, matching CRuby 4.0's insns.def (plus the specialized instructions with embedded operands).
// pop / push are the "values taken from the stack" and "values pushed onto the stack" columns of insns.def.

export type Category = "local" | "put" | "stack" | "data" | "send" | "opt" | "branch" | "define" | "throw" | "var" | "other";

export const CATEGORY_LABEL: Record<Category, [string, string]> = {
  local: ["ローカル変数", "Local variables"],
  var: ["その他の変数", "Other variables"],
  put: ["値を積む", "Push values"],
  stack: ["スタック操作", "Stack operations"],
  data: ["配列・ハッシュ・文字列", "Arrays, hashes, strings"],
  send: ["メソッド呼び出し", "Method calls"],
  opt: ["最適化された呼び出し", "Optimized calls"],
  branch: ["分岐", "Branches"],
  define: ["定義", "Definitions"],
  throw: ["脱出・例外", "Escapes & exceptions"],
  other: ["その他", "Other"],
};

export interface InsnDef {
  name: string;
  /** Operand names (as written in insns.def) */
  operands: string[];
  /** Values taken from the stack */
  pop: string[];
  /** Values pushed onto the stack */
  push: string[];
  category: Category;
  /** Japanese description */
  doc: string;
  /** English description */
  docEn: string;
}

const T: [string, string, string, string, Category, string, string][] = [
  // name, operands, pop, push, category, doc, docEn
  ["nop", "", "", "", "other", "何もしない。ブロックの先頭などで、イベントの目印として置かれる。", "Do nothing. Placed at the start of blocks etc. as a marker for events."],
  ["getlocal", "idx level", "", "val", "local", "level 個外側の環境 (EP) から、idx 番目のローカル変数を読んで積む。", "Read local variable idx from the environment (EP) level levels out, and push it."],
  ["setlocal", "idx level", "val", "", "local", "スタックトップの値を取り出し、level 個外側の環境のローカル変数 idx に書き込む。", "Pop the top value and write it to local variable idx of the environment level levels out."],
  ["getlocal_WC_0", "idx", "", "val", "local", "getlocal の level=0 版 (今のフレームのローカル変数を読む)。よく使う形をオペランドごと命令に埋め込んだ特化命令。", "getlocal with level=0 (read a local variable of the current frame). A specialized instruction with a common operand embedded in the name."],
  ["getlocal_WC_1", "idx", "", "val", "local", "getlocal の level=1 版 (1 つ外側、たとえばブロックの外のローカル変数を読む)。", "getlocal with level=1 (read a variable one level out, e.g. outside a block)."],
  ["setlocal_WC_0", "idx", "val", "", "local", "setlocal の level=0 版。", "setlocal with level=0."],
  ["setlocal_WC_1", "idx", "val", "", "local", "setlocal の level=1 版。", "setlocal with level=1."],
  ["getblockparam", "idx level", "", "val", "local", "ブロック引数 (&blk) を読む。初回はブロックを Proc オブジェクトに変換してから変数に入れる。", "Read the block parameter (&blk). The first time, the block is turned into a Proc object and stored in the variable."],
  ["setblockparam", "idx level", "val", "", "local", "ブロック引数 (&blk) に代入する。", "Assign to the block parameter (&blk)."],
  ["getblockparamproxy", "idx level", "", "val", "local", "blk.call などのためにブロック引数を読む。Proc を作らずに済むよう、代理オブジェクトを積むことがある。", "Read the block parameter for blk.call etc. May push a proxy so that no Proc needs to be created."],
  ["getspecial", "key type", "", "val", "var", "$~ や $_ などの特殊変数を読む。", "Read a special variable such as $~ or $_."],
  ["setspecial", "key", "obj", "", "var", "特殊変数に書き込む。", "Write a special variable."],
  ["getinstancevariable", "id ic", "", "val", "var", "self のインスタンス変数 id を読んで積む。", "Read instance variable id of self and push it."],
  ["setinstancevariable", "id ic", "val", "", "var", "スタックトップの値を self のインスタンス変数 id に書き込む。", "Write the top value to instance variable id of self."],
  ["getclassvariable", "id ic", "", "val", "var", "クラス変数 id を読んで積む。", "Read class variable id and push it."],
  ["setclassvariable", "id ic", "val", "", "var", "クラス変数 id に書き込む。", "Write class variable id."],
  ["opt_getconstant_path", "ic", "", "val", "var", "A::B のような定数パスを解決して積む。結果はインラインキャッシュ (ic) に覚えておく。", "Resolve a constant path like A::B and push it. The result is cached in an inline cache (ic)."],
  ["getconstant", "id", "klass allow_nil", "val", "var", "klass の下の定数 id を読む。", "Read constant id under klass."],
  ["setconstant", "id", "val cbase", "", "var", "cbase の下に定数 id を定義する。", "Define constant id under cbase."],
  ["getglobal", "gid", "", "val", "var", "グローバル変数を読んで積む。", "Read a global variable and push it."],
  ["setglobal", "gid", "val", "", "var", "グローバル変数に書き込む。", "Write a global variable."],
  ["putnil", "", "", "nil", "put", "nil を積む。", "Push nil."],
  ["putself", "", "", "self", "put", "今のフレームの self を積む。メソッド呼び出しの受け手 (レシーバ) を用意するときによく使う。", "Push self of the current frame. Often used to prepare the receiver of a method call."],
  ["putobject", "val", "", "val", "put", "命令列に埋め込まれた値 (リテラル) をそのまま積む。", "Push a value (literal) embedded in the instruction sequence as is."],
  ["putobject_INT2FIX_0_", "", "", "0", "put", "整数 0 を積む。putobject 0 をオペランドごと埋め込んだ特化命令。", "Push the integer 0. A specialized putobject 0 with the operand embedded."],
  ["putobject_INT2FIX_1_", "", "", "1", "put", "整数 1 を積む。putobject 1 をオペランドごと埋め込んだ特化命令。", "Push the integer 1. A specialized putobject 1 with the operand embedded."],
  ["putspecialobject", "type", "", "val", "put", "VM 内部の特別なオブジェクトを積む (1: VM コア、2: 定義先のクラス、3: 定数の探索起点)。", "Push a special VM-internal object (1: the VM core, 2: the class to define in, 3: the base for constant lookup)."],
  ["putstring", "str", "", "val", "put", "文字列リテラルを複製して積む。", "Duplicate a string literal and push it."],
  ["putchilledstring", "str", "", "val", "put", "文字列リテラルを複製して積む。変更すると警告が出る「冷えた (chilled)」文字列になる。", "Duplicate a string literal and push it as a \"chilled\" string, which warns when modified."],
  ["concatstrings", "num", "...", "val", "data", "スタックの上から num 個の文字列を連結して 1 つにする (式展開 \"#{}\" で使う)。", "Concatenate num strings from the top of the stack into one (used by \"#{}\" interpolation)."],
  ["anytostring", "", "val str", "val", "data", "式展開で to_s の結果が文字列でなかったときの後始末をする。", "Clean up when to_s in an interpolation did not return a string."],
  ["objtostring", "cd", "recv", "val", "data", "式展開のために recv.to_s を呼ぶ (文字列ならそのまま)。", "Call recv.to_s for interpolation (strings are left as is)."],
  ["toregexp", "opt cnt", "...", "val", "data", "cnt 個の文字列から正規表現を作る。", "Build a regular expression from cnt strings."],
  ["intern", "", "str", "sym", "data", "文字列をシンボルにする。", "Turn a string into a symbol."],
  ["newarray", "num", "...", "val", "data", "スタックの上から num 個の値を取り出し、配列にして積む。", "Pop num values and push them as an array."],
  ["pushtoarraykwsplat", "", "ary hash", "ary", "data", "空でなければ hash を配列に追加する。", "Append hash to the array if it is not empty."],
  ["duparray", "ary", "", "val", "data", "配列リテラルを複製して積む。", "Duplicate an array literal and push it."],
  ["duphash", "hash", "", "val", "data", "ハッシュリテラルを複製して積む。", "Duplicate a hash literal and push it."],
  ["expandarray", "num flag", "ary", "...", "data", "配列を num 個の値に分解して積む (多重代入 a, b = ary で使う)。", "Split an array into num values and push them (used by multiple assignment a, b = ary)."],
  ["concatarray", "", "ary1 ary2", "ary", "data", "2 つの配列を連結する。", "Concatenate two arrays."],
  ["concattoarray", "", "ary1 ary2", "ary", "data", "ary1 に ary2 の要素を追加する。", "Append the elements of ary2 to ary1."],
  ["pushtoarray", "num", "...", "val", "data", "num 個の値を配列に追加する。", "Append num values to an array."],
  ["splatarray", "flag", "ary", "obj", "data", "*ary で展開するために、値を配列に変換する。", "Convert a value to an array to expand it with *ary."],
  ["splatkw", "", "hash block", "obj block", "data", "**hash で展開するために、値をハッシュに変換する。", "Convert a value to a hash to expand it with **hash."],
  ["newhash", "num", "...", "val", "data", "スタックの上から num 個 (キーと値の組) を取り出してハッシュを作る。", "Pop num values (key/value pairs) and build a hash."],
  ["newrange", "flag", "low high", "val", "data", "範囲オブジェクトを作る (flag=1 なら終端を含まない ...)。", "Create a range (flag=1 excludes the end, ...)."],
  ["pop", "", "val", "", "stack", "スタックトップの値を捨てる。使われない式の値を片付けるのによく使う。", "Discard the top value. Often used to clean up the value of an unused expression."],
  ["dup", "", "val", "val val", "stack", "スタックトップの値を複製して積む。", "Duplicate the top value."],
  ["dupn", "n", "...", "...", "stack", "上から n 個の値を複製して積む。", "Duplicate the top n values."],
  ["swap", "", "val obj", "obj val", "stack", "上 2 つの値を入れ替える。", "Swap the top two values."],
  ["opt_reverse", "n", "...", "...", "stack", "上から n 個の値の並びを逆にする。", "Reverse the order of the top n values."],
  ["topn", "n", "", "val", "stack", "上から n 番目 (0 始まり) の値を複製して積む。", "Push a copy of the value n below the top (0-based)."],
  ["setn", "n", "val", "val", "stack", "スタックトップの値を、上から n 番目の位置にも書き込む。", "Also write the top value to the slot n below the top."],
  ["adjuststack", "n", "...", "", "stack", "上から n 個の値を捨てる。", "Discard the top n values."],
  ["defined", "op_type obj pushval", "v", "val", "other", "defined? 式を評価する。定義されていれば pushval を、なければ nil を積む。", "Evaluate a defined? expression. Push pushval if defined, otherwise nil."],
  ["definedivar", "id ic pushval", "", "val", "other", "defined?(@x) を評価する。", "Evaluate defined?(@x)."],
  ["checkmatch", "flag", "target pattern", "result", "other", "pattern === target を評価する (case/when や rescue の型チェックで使う)。", "Evaluate pattern === target (used for case/when and rescue type checks)."],
  ["checkkeyword", "kw_bits_index keyword_index", "", "ret", "other", "キーワード引数が渡されたかを調べる。渡されていなければデフォルト値の式を実行する。", "Check whether a keyword argument was given. If not, the default value expression runs."],
  ["checktype", "type", "val", "ret", "other", "値の型 (T_STRING など) を調べる。", "Check the type of a value (T_STRING etc.)."],
  ["defineclass", "id class_iseq flags", "cbase super", "val", "define", "クラス (またはモジュール) を定義・再オープンし、class_iseq (クラス本体) を新しいフレームで実行する。", "Define (or reopen) a class or module and run class_iseq (the class body) in a new frame."],
  ["definemethod", "id iseq", "", "", "define", "iseq を本体とするメソッド id を定義する。", "Define method id whose body is iseq."],
  ["definesmethod", "id iseq", "obj", "", "define", "obj の特異メソッド id を定義する (def self.foo)。", "Define singleton method id on obj (def self.foo)."],
  ["send", "cd blockiseq", "recv args...", "val", "send", "メソッドを呼び出す。スタックにはレシーバと引数が積まれている。blockiseq があればブロック付きで呼ぶ。", "Call a method. The receiver and arguments are on the stack. If blockiseq is given, call it with a block."],
  ["sendforward", "cd blockiseq", "recv args...", "val", "send", "引数をそのまま転送する (...) 形のメソッド呼び出し。", "A method call that forwards its arguments (...)."],
  ["opt_send_without_block", "cd", "recv args...", "val", "send", "ブロックなしのメソッド呼び出し (send の特化版)。", "A method call without a block (specialized send)."],
  ["opt_new", "cd dst", "", "", "send", "Class#new の高速版。new が再定義されていなければ、オブジェクトを確保して続く initialize 呼び出しへ進む。そうでなければ dst へ飛んで普通に new を呼ぶ。", "Fast Class#new. If new is not redefined, allocate the object and go on to the following initialize call; otherwise jump to dst and call new normally."],
  ["opt_ary_freeze", "ary cd", "", "val", "opt", "凍結した配列リテラルを積む ([].freeze)。", "Push a frozen array literal ([].freeze)."],
  ["opt_hash_freeze", "hash cd", "", "val", "opt", "凍結したハッシュリテラルを積む ({}.freeze)。", "Push a frozen hash literal ({}.freeze)."],
  ["opt_str_freeze", "str cd", "", "val", "opt", "凍結した文字列リテラルを積む (\"\".freeze)。", "Push a frozen string literal (\"\".freeze)."],
  ["opt_nil_p", "cd", "recv", "val", "opt", "recv.nil? の高速版。", "Fast recv.nil?."],
  ["opt_str_uminus", "str cd", "", "val", "opt", "-\"str\" の高速版。", "Fast -\"str\"."],
  ["opt_duparray_send", "ary method argc", "...", "val", "opt", "配列リテラルに対するメソッド呼び出し ([...].include?(x) など) の高速版。", "Fast method call on an array literal ([...].include?(x) etc.)."],
  ["opt_newarray_send", "num method", "...", "val", "opt", "配列を作らずに [a, b].max などを計算する高速版。", "Compute [a, b].max etc. without creating the array."],
  ["invokesuper", "cd blockiseq", "recv args...", "val", "send", "super を呼ぶ。今のメソッドが定義されたクラスの、さらに上のクラスからメソッドを探す。", "Call super. Look up the method starting above the class where the current method is defined."],
  ["invokesuperforward", "cd blockiseq", "recv args...", "val", "send", "引数を転送する形の super。", "super that forwards its arguments."],
  ["invokeblock", "cd", "args...", "val", "send", "yield。今のメソッドに渡されたブロックを、新しいフレームで実行する。", "yield. Run the block given to the current method in a new frame."],
  ["leave", "", "val", "val", "send", "今のフレームを終えて呼び出し元に戻る。スタックトップの値が戻り値になり、呼び出し元のスタックに積まれる。", "Finish the current frame and return to the caller. The top value becomes the return value and is pushed onto the caller's stack."],
  ["throw", "throw_state", "throwobj", "val", "throw", "break・next・return・retry や例外の再送出で、フレームをまたいで脱出する。", "Escape across frames for break, next, return, retry, or re-raising an exception."],
  ["jump", "dst", "", "", "branch", "dst へ無条件に飛ぶ。", "Jump to dst unconditionally."],
  ["branchif", "dst", "val", "", "branch", "スタックトップを取り出し、真 (nil と false 以外) なら dst へ飛ぶ。", "Pop the top value; if it is truthy (not nil or false), jump to dst."],
  ["branchunless", "dst", "val", "", "branch", "スタックトップを取り出し、偽 (nil か false) なら dst へ飛ぶ。", "Pop the top value; if it is falsy (nil or false), jump to dst."],
  ["branchnil", "dst", "val", "", "branch", "スタックトップを取り出し、nil なら dst へ飛ぶ (&. 演算子で使う)。", "Pop the top value; if it is nil, jump to dst (used by the &. operator)."],
  ["once", "iseq ise", "", "val", "other", "iseq を一度だけ実行し、結果を覚えておく (/#{x}/o など)。", "Run iseq only once and remember the result (/#{x}/o etc.)."],
  ["opt_case_dispatch", "hash else_offset", "key", "", "branch", "case/when の値がすべてリテラルのとき、表引きで飛び先を一度に決める。", "When all when values of a case are literals, decide the jump target at once with a table lookup."],
  ["opt_plus", "cd", "recv obj", "val", "opt", "recv + obj。Integer 同士などは、メソッドを呼ばずに VM の中で直接計算する。", "recv + obj. For Integers etc., compute directly in the VM without calling a method."],
  ["opt_minus", "cd", "recv obj", "val", "opt", "recv - obj の高速版。", "Fast recv - obj."],
  ["opt_mult", "cd", "recv obj", "val", "opt", "recv * obj の高速版。", "Fast recv * obj."],
  ["opt_div", "cd", "recv obj", "val", "opt", "recv / obj の高速版。", "Fast recv / obj."],
  ["opt_mod", "cd", "recv obj", "val", "opt", "recv % obj の高速版。", "Fast recv % obj."],
  ["opt_eq", "cd", "recv obj", "val", "opt", "recv == obj の高速版。", "Fast recv == obj."],
  ["opt_neq", "cd_eq cd", "recv obj", "val", "opt", "recv != obj の高速版。", "Fast recv != obj."],
  ["opt_lt", "cd", "recv obj", "val", "opt", "recv < obj の高速版。", "Fast recv < obj."],
  ["opt_le", "cd", "recv obj", "val", "opt", "recv <= obj の高速版。", "Fast recv <= obj."],
  ["opt_gt", "cd", "recv obj", "val", "opt", "recv > obj の高速版。", "Fast recv > obj."],
  ["opt_ge", "cd", "recv obj", "val", "opt", "recv >= obj の高速版。", "Fast recv >= obj."],
  ["opt_ltlt", "cd", "recv obj", "val", "opt", "recv << obj の高速版 (配列への追加など)。", "Fast recv << obj (appending to an array etc.)."],
  ["opt_and", "cd", "recv obj", "val", "opt", "recv & obj の高速版。", "Fast recv & obj."],
  ["opt_or", "cd", "recv obj", "val", "opt", "recv | obj の高速版。", "Fast recv | obj."],
  ["opt_aref", "cd", "recv obj", "val", "opt", "recv[obj] の高速版。", "Fast recv[obj]."],
  ["opt_aset", "cd", "recv obj set", "val", "opt", "recv[obj] = set の高速版。", "Fast recv[obj] = set."],
  ["opt_length", "cd", "recv", "val", "opt", "recv.length の高速版。", "Fast recv.length."],
  ["opt_size", "cd", "recv", "val", "opt", "recv.size の高速版。", "Fast recv.size."],
  ["opt_empty_p", "cd", "recv", "val", "opt", "recv.empty? の高速版。", "Fast recv.empty?."],
  ["opt_succ", "cd", "recv", "val", "opt", "recv.succ の高速版。", "Fast recv.succ."],
  ["opt_not", "cd", "recv", "val", "opt", "!recv の高速版。", "Fast !recv."],
  ["opt_regexpmatch2", "cd", "obj2 obj1", "val", "opt", "obj2 =~ obj1 の高速版。", "Fast obj2 =~ obj1."],
  ["invokebuiltin", "bf", "...", "val", "other", "Ruby で書かれた組み込みメソッドから、C の関数を直接呼ぶ。", "Call a C function directly from a builtin method written in Ruby."],
  ["opt_invokebuiltin_delegate", "bf index", "", "val", "other", "引数をそのまま渡して C の関数を呼ぶ。", "Call a C function, passing the arguments as is."],
  ["opt_invokebuiltin_delegate_leave", "bf index", "", "val", "other", "C の関数を呼んで、そのまま戻る。", "Call a C function and return right away."],
];

export const INSNS: Record<string, InsnDef> = {};
export const INSN_LIST: InsnDef[] = T.map(([name, ops, pop, push, category, doc, docEn]) => {
  const d: InsnDef = {
    name,
    operands: ops ? ops.split(" ") : [],
    pop: pop ? pop.split(" ") : [],
    push: push ? push.split(" ") : [],
    category,
    doc,
    docEn,
  };
  INSNS[name] = d;
  return d;
});
