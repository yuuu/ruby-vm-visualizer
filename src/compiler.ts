// Runs the real CRuby (ruby.wasm) in the browser to compile Ruby source into YARV instruction sequences.
// The wasm is large (about 17MB), so it is loaded only once, on the first compile.
import wasmUrl from "@ruby/4.0-wasm-wasi/dist/ruby.wasm?url";
import dumpScript from "./yarv/dump_iseq.rb?raw";

type RubyVM = { eval(code: string): { toString(): string } };

let loading: Promise<RubyVM> | null = null;

export type LoadProgress = (loaded: number, total: number) => void;

async function fetchWithProgress(url: string, onProgress?: LoadProgress): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ruby.wasm (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return buf.buffer;
}

export function loadRuby(onProgress?: LoadProgress): Promise<RubyVM> {
  if (!loading) {
    loading = (async () => {
      const { DefaultRubyVM } = await import("@ruby/wasm-wasi/dist/browser");
      const module = await WebAssembly.compile(await fetchWithProgress(wasmUrl, onProgress));
      const { vm } = await DefaultRubyVM(module, { consolePrint: false });
      vm.eval(dumpScript);
      return vm as unknown as RubyVM;
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

export function isRubyLoaded() {
  return loading !== null;
}

/** Compiles the source and returns the JSON string produced by dump_iseq.rb */
export async function compileRuby(source: string, onProgress?: LoadProgress): Promise<string> {
  const vm = await loadRuby(onProgress);
  // Pass the UTF-8 bytes as hex so we don't have to worry about escaping the string
  const hex = Array.from(new TextEncoder().encode(source), (b) => b.toString(16).padStart(2, "0")).join("");
  return vm.eval(`IseqDump.dump(["${hex}"].pack("H*").force_encoding(Encoding::UTF_8))`).toString();
}
