import { useEffect, useRef, useState } from "react";
import samples from "../samples.json";
import type { Simulator as Sim } from "../useSimulator";
import { pad4 } from "../yarv/disasm";
import { Icon } from "./common";
import { useLang, useT } from "../i18n";
import { IseqPanel } from "./IseqPanel";
import { ControlFramePanel, LocalTablePanel, OutputPanel, VarsPanel } from "./SidePanels";
import { SourcePanel } from "./SourcePanel";
import { StackPanel } from "./StackPanel";
import { StagePanel } from "./StagePanel";

const SPEEDS = [0.5, 1, 2, 4, 8, 20, 60];

export function Simulator({ sim }: { sim: Sim }) {
  const { loaded, vm, last } = sim;
  const t = useT();
  const lang = useLang();
  const [sampleId, setSampleId] = useState<string>(samples[0].id);
  const [follow, setFollow] = useState(true);
  const [manualIseq, setManualIseq] = useState(0);
  const [selFrame, setSelFrame] = useState<{ id: number; version: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadSample = async (id: string) => {
    const s = samples.find((x) => x.id === id);
    if (!s) return;
    setSampleId(id);
    setEditing(false);
    try {
      const res = await fetch(import.meta.env.BASE_URL + s.iseq);
      if (!res.ok) throw new Error(`${res.status}`);
      sim.load(`${s.id}.rb`, await res.text(), s.source);
    } catch (e) {
      sim.setError(`${t("サンプルを読み込めませんでした", "Could not load the sample")}: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    if (!loaded) loadSample(samples[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const compile = async (source: string, name = "main.rb") => {
    const ok = await sim.compile(source, name);
    if (ok) setSampleId("");
    return ok;
  };

  const loadFiles = async (files: FileList | File[]) => {
    const rb = [...files].find((f) => /\.rb$/i.test(f.name)) ?? [...files][0];
    if (!rb) return;
    if (!/\.rb$/i.test(rb.name)) {
      sim.setError(t(".rb ファイルを選んでください。", "Please choose a .rb file."));
      return;
    }
    await compile(await rb.text(), rb.name);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        sim.step();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        sim.back();
      } else if (e.key === " " && document.activeElement?.closest("#simulator")) {
        e.preventDefault();
        sim.setPlaying(!sim.playing);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sim]);

  const top = vm?.frames[vm.frames.length - 1];
  const iseqs = loaded?.program.iseqs ?? [];
  const ruby = vm?.rubyTop();
  const followIseq = ruby?.iseq?.index ?? last?.iseqIndex ?? 0;
  const shown = Math.min(follow ? followIseq : manualIseq, Math.max(0, iseqs.length - 1));
  const selectedFrame = (selFrame && selFrame.version === sim.version && vm?.frames.find((f) => f.id === selFrame.id)) || top || null;
  const line = top?.iseq ? (top.iseq.byPc.get(top.pc)?.line ?? null) : last ? last.insn.line : null;

  return (
    <section
      id="simulator"
      className={`simulator ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        loadFiles(e.dataTransfer.files);
      }}
    >
      <div className="section-head">
        <span className="eyebrow">{t("シミュレーター", "Simulator")}</span>
        <h2>{t("1 命令ずつ、VM を動かしてみよう", "Run the VM one instruction at a time")}</h2>
        {lang === "en" ? (
          <p>
            Pick a sample, or press "Edit" to write your own Ruby code (you can also drop a <code>.rb</code> file). Press <kbd>→</kbd> to step one
            instruction and <kbd>←</kbd> to step back.
          </p>
        ) : (
          <p>
            サンプルを選ぶか、「書き換える」で自分の Ruby コードを書いてください (<code>.rb</code> ファイルのドロップもできます)。
            キーボードの <kbd>→</kbd> で 1 命令進む、<kbd>←</kbd> で戻ります。
          </p>
        )}
      </div>

      <div className="toolbar">
        <div className="tb-group load">
          <label className="select">
            <span>{t("サンプル", "Sample")}</span>
            <select value={sampleId} onChange={(e) => loadSample(e.target.value)}>
              {sampleId === "" && <option value="">{t("(自分のコード)", "(your code)")}</option>}
              {samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {lang === "en" ? s.titleEn : s.title}
                </option>
              ))}
            </select>
          </label>
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" /> {t(".rb を開く", "Open .rb")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".rb"
            hidden
            onChange={(e) => {
              if (e.target.files) loadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <div className="tb-group controls" role="group" aria-label={t("実行コントロール", "Run controls")}>
          <button className="btn icon-btn" onClick={sim.reset} title={t("最初に戻す", "Back to the start")} aria-label={t("リセット", "Reset")}>
            <Icon name="reset" />
          </button>
          <button className="btn icon-btn" onClick={sim.back} disabled={!vm || vm.steps === 0} title={t("1つ戻る (←)", "Step back (←)")} aria-label={t("1つ戻る", "Step back")}>
            <Icon name="back" />
          </button>
          <button className="btn primary step-btn" onClick={sim.step} disabled={!vm || vm.halted} title={t("1つ進める (→)", "Step (→)")}>
            <Icon name="step" /> {t("1つ進める", "Step")}
          </button>
          <button className="btn icon-btn" onClick={() => sim.setPlaying(!sim.playing)} disabled={!vm || vm.halted} title={t("自動実行 (スペース)", "Auto-run (Space)")} aria-label={sim.playing ? t("一時停止", "Pause") : t("自動実行", "Auto-run")}>
            <Icon name={sim.playing ? "pause" : "play"} />
          </button>
          <button className="btn icon-btn" onClick={sim.runToEnd} disabled={!vm || vm.halted} title={t("最後 (またはブレークポイント) まで実行", "Run to the end (or a breakpoint)")} aria-label={t("最後まで実行", "Run to end")}>
            <Icon name="end" />
          </button>
          <label className="speed" title={t("自動実行の速さ", "Auto-run speed")}>
            <span>{t("速さ", "Speed")}</span>
            <input type="range" min={0} max={SPEEDS.length - 1} value={Math.max(0, SPEEDS.indexOf(sim.speed))} onChange={(e) => sim.setSpeed(SPEEDS[Number(e.target.value)])} />
            <span className="speed-val">{sim.speed}/{t("秒", "s")}</span>
          </label>
        </div>

        <div className="tb-group status" aria-live="polite">
          <span className="stat">
            <b>{vm?.steps ?? 0}</b> {t("ステップ", "steps")}
          </span>
          <span className="stat">
            pc <b>{top?.iseq ? pad4(top.pc) : "—"}</b>
          </span>
          <span className="stat">
            sp <b>{top ? top.sp : "—"}</b>
          </span>
          {vm?.halted && <span className={`badge ${vm.uncaught ? "bad" : "ok"}`}>{vm.uncaught ? t("例外で停止", "Stopped by exception") : t("実行完了", "Finished")}</span>}
        </div>
      </div>

      {sim.error && (
        <div className="alert" role="alert">
          <pre>{sim.error}</pre>
          <button className="btn ghost small" onClick={() => sim.setError(null)}>
            {t("閉じる", "Close")}
          </button>
        </div>
      )}

      {loaded && vm && (
        <div className="sim-grid">
          <div className="col col-left">
            <SourcePanel source={loaded.source} line={editing ? null : line} compileState={sim.compileState} onCompile={(src) => compile(src)} editing={editing} setEditing={setEditing} />
            <IseqPanel
              vm={vm}
              iseqs={iseqs}
              shown={shown}
              follow={follow}
              setFollow={setFollow}
              onSelect={(i) => {
                setManualIseq(i);
                setFollow(false);
              }}
              last={last}
              breakpoints={sim.breakpoints}
              toggleBreakpoint={sim.toggleBreakpoint}
            />
          </div>
          <div className="col col-mid">
            <StagePanel vm={vm} iseqs={iseqs} last={last} playing={sim.playing} speed={sim.speed} />
            <StackPanel vm={vm} last={last} selectedId={selFrame && selFrame.version === sim.version ? selFrame.id : null} version={sim.version} />
          </div>
          <div className="col col-right">
            <ControlFramePanel vm={vm} selectedId={selectedFrame?.id ?? null} onSelect={(f) => setSelFrame({ id: f.id, version: sim.version })} />
            <OutputPanel vm={vm} version={sim.version} />
            <LocalTablePanel iseq={iseqs[shown]} />
            <VarsPanel vm={vm} />
          </div>
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Icon name="upload" />
            <p>{t(".rb ファイルをドロップするとコンパイルして実行します", "Drop a .rb file to compile and run it")}</p>
          </div>
        </div>
      )}
    </section>
  );
}
