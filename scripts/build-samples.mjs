// Compiles samples/*.rb into YARV instruction sequences with the local ruby (4.0.x), writes them to public/samples/*.json,
// and writes the list to src/samples.json.
// Usage: npm run samples   (set RUBY=/path/to/ruby to choose the ruby)
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const ruby = process.env.RUBY ?? "ruby";
const dumper = join(root, "src/yarv/dump_iseq.rb");
const srcDir = join(root, "samples");
const outDir = join(root, "public/samples");
mkdirSync(outDir, { recursive: true });

const version = execFileSync(ruby, ["-e", "print RUBY_VERSION"]).toString();
if (!version.startsWith("4.0.")) {
  console.error(`ruby 4.0.x が必要です (ブラウザの ruby.wasm と命令セットを揃えるため)。いまの ruby は ${version} です`);
  process.exit(1);
}

// Sample titles in Japanese and English
const titles = JSON.parse(readFileSync(join(srcDir, "titles.json"), "utf8"));

const list = [];
for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".rb")).sort()) {
  const name = basename(file, ".rb");
  const source = readFileSync(join(srcDir, file), "utf8");
  const json = execFileSync(ruby, ["-r", dumper, "-e", "print IseqDump.dump(STDIN.read)"], { input: source }).toString();
  writeFileSync(join(outDir, `${name}.json`), json);
  const { ja: title = name, en: titleEn = title } = titles[name] ?? {};
  list.push({ id: name, title, titleEn, iseq: `samples/${name}.json`, source });
}
writeFileSync(join(root, "src/samples.json"), JSON.stringify(list, null, 2) + "\n");
console.log(`${list.length} samples built with ruby ${version}`);
