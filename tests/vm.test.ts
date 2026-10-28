import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadDump } from "../src/yarv/iseq";
import { VM } from "../src/yarv/vm";

const root = join(__dirname, "..");
const dumper = join(root, "src/yarv/dump_iseq.rb");

/** Compiles into an instruction sequence with the local ruby (in the browser, ruby.wasm runs the same script) */
function compile(source: string): string {
  return execFileSync("ruby", ["-r", dumper, "-e", "print IseqDump.dump(STDIN.read)"], { input: source }).toString();
}

function realRuby(file: string): string {
  try {
    return execFileSync("ruby", [file], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e: any) {
    return e.stdout.toString();
  }
}

function run(source: string) {
  const vm = new VM(loadDump(compile(source)));
  let n = 0;
  while (!vm.halted && n < 2_000_000) {
    vm.step();
    n++;
  }
  return { vm, text: vm.output.filter((o) => o.kind === "out").map((o) => o.text).join("") };
}

for (const dir of ["samples", "tests/cases"]) {
  describe(`${dir} (本物の ruby と比較)`, () => {
    for (const f of readdirSync(join(root, dir)).filter((f) => f.endsWith(".rb"))) {
      it(f, () => {
        const file = join(root, dir, f);
        const { vm, text } = run(readFileSync(file, "utf8"));
        expect(vm.halted).toBe(true);
        expect(text).toBe(realRuby(file));
      });
    }
  });
}
