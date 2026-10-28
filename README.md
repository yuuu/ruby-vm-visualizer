# Ruby VM Visualizer

A learning site that compiles Ruby code into CRuby's YARV instruction sequence and lets you watch the VM run it one instruction at a time, pushing values onto the stack and popping them off.

- Compilation is done by the real CRuby 4.0 running in the browser ([ruby.wasm](https://github.com/ruby/ruby.wasm))
- Execution is done by a TypeScript reimplementation of YARV, so it can stop at every instruction and show what is inside
- Shows the instruction sequence (iseq) and its catch table, the fetch → decode → execute stages, the VM stack (local variables, env data, operand stack, sp / ep), and the control frames
- Step forward / back, auto-run, breakpoints, and run to the end
- Explanation pages on how the stack machine works, an instruction list, and more
- Japanese / English switch (buttons in the header; the first visit follows the browser's language)

## Development

```sh
npm install
npm run dev      # dev server
npm test         # VM tests (compiles with the local ruby and compares the output with real ruby)
npm run build    # builds a static site into dist/ (deployable as is to Vercel etc.)
```

Pushing to `main` builds the site and deploys it to GitHub Pages (`.github/workflows/pages.yml`).

The tests and the sample build need Ruby 4.0.x (to match the instruction set of ruby.wasm in the browser).

## Rebuilding the samples

After editing `samples/*.rb`, rebuild their instruction sequences. Sample titles (Japanese and English) live in `samples/titles.json`.

```sh
npm run samples   # set RUBY=/path/to/ruby to choose the ruby
```

## How it works

- `src/yarv/dump_iseq.rb` — a Ruby script that turns the result of `RubyVM::InstructionSequence#to_a` into JSON. Used both in the browser (ruby.wasm) and by the local ruby
- `src/yarv/vm.ts` — a VM that runs one instruction at a time (corresponds to `insns.def` / `vm_insnhelper.c` / `vm.c`). All frames live on a single VM stack, and it reproduces how pushed arguments become the callee's local variables as is, and how environments captured by a Proc move to the heap
- `src/yarv/builtins.ts` — builtin methods. Methods that call blocks are written as generators, so the body of a block also runs one instruction at a time
- `src/i18n.tsx` — Japanese / English switching
- `scripts/trace.ts` — a dev script that runs the VM from the command line (`TRACE=1 npx vite-node scripts/trace.ts file.rb`)

Some features are not supported, such as Regexp, Struct, Fiber, argument forwarding (`...`), and file I/O.
