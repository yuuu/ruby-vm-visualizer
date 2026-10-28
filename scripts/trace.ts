// Dev script: compile with the local ruby and run it on the visualizer's VM.
//   npx vite-node scripts/trace.ts file.rb        (output only)
//   TRACE=1 npx vite-node scripts/trace.ts file.rb (with a description of every instruction)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadDump } from "../src/yarv/iseq";
import { VM } from "../src/yarv/vm";
const file = process.argv[2];
const src = file === "-e" ? process.argv[3] : readFileSync(file, "utf8");
const json = execFileSync("ruby", ["-r", new URL("../src/yarv/dump_iseq.rb", import.meta.url).pathname, "-e", "print IseqDump.dump(STDIN.read)"], { input: src }).toString();
const vm = new VM(loadDump(json));
const trace = process.env.TRACE;
let n = 0;
while (!vm.halted && n < 2_000_000) {
  const i = vm.step();
  if (trace && i) console.log(`[${i.index}] ${vm.program.iseqs[i.iseqIndex].label} ${String(i.insn.pc).padStart(4, "0")} ${i.insn.name}: ${i.desc}${i.event ? "  ★" + i.event.text : ""}`);
  n++;
}
process.stdout.write(vm.output.map((o) => (o.kind === "err" ? "[ERR] " : "") + o.text).join(""));
