// オフライン再現可能な競艇B11×級別σ×進入順ゲート 研究パイプラインCLI。
// 原本 (TurfLab-data/boatrace/YYYY-MM-DD/archive-*.json) は読取専用とし、絶対に上書きしない。
// 派生研究データは content-addressed ファイルとして追記保存し、同一入力なら冪等スキップする。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { canonical } from "../packages/shared/src/domain";
import {
  buildEvaluationReport,
  buildForecastRecord,
  extractBoatFeatures,
  MANIFEST_SCHEMA_VERSION,
  mergeBoatArchives,
  normalizeBoatRace,
  type BoatArchiveInput,
  type BoatResearchEvaluationReport,
} from "../packages/shared/src/boatrace-research";
import type { B11Stats, B11Summary } from "../packages/shared/src/boatrace-b11";
import { summarizeGradeOrder } from "../packages/shared/src/boatrace-grade-order";
import { evaluateB13, B13_VERSION } from "../packages/shared/src/boatrace-b13";
import { evaluateB13V2, B13V2_VERSION } from "../packages/shared/src/boatrace-b13-v2";

export interface CliOptions {
  command: "audit" | "normalize" | "features" | "backtest" | "report" | "run";
  dataRoot: string;
  outDir: string;
  from?: string;
  to?: string;
  generatedAt?: string;
  dataSha?: string;
  codeSha?: string;
  write: boolean;
}

export function sha256Hex(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function gitHead(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export function loadArchiveInputs(dataRoot: string, from = "0000", to = "9999") {
  const base = join(dataRoot, "boatrace");
  if (!existsSync(base)) throw new Error(`boatrace ディレクトリが見つかりません: ${base}`);
  const archives: BoatArchiveInput[] = [];
  const inputFiles: { path: string; sha256: string; bytes: number }[] = [];
  const missingDays: string[] = [];

  for (const day of readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from && d <= to).sort()) {
    const dayDir = join(base, day);
    const files = readdirSync(dayDir).filter((f) => /^archive-.*\.json$/.test(f)).sort();
    if (!files.length) {
      missingDays.push(day);
      continue;
    }
    for (const file of files) {
      const fullPath = join(dayDir, file);
      const raw = readFileSync(fullPath);
      const rel = relative(dataRoot, fullPath).replaceAll("\\", "/");
      inputFiles.push({ path: rel, sha256: sha256Hex(raw), bytes: raw.byteLength });
      const parsed = JSON.parse(raw.toString("utf8")) as Omit<BoatArchiveInput, "file">;
      archives.push({
        file: rel,
        date: parsed.date ?? day,
        records: parsed.records ?? [],
        research: parsed.research,
        revisions: parsed.revisions,
      });
    }
  }
  return { archives, inputFiles, missingDays };
}

function writeImmutable(filePath: string, content: string): "written" | "skipped" {
  mkdirSync(dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    const prev = readFileSync(filePath, "utf8");
    if (prev === content) return "skipped";
    throw new Error(`既存ファイルと内容が衝突しました（上書き禁止）: ${filePath}`);
  }
  writeFileSync(filePath, content, "utf8");
  return "written";
}

export function runResearchPipeline(opts: CliOptions) {
  const { archives, inputFiles, missingDays } = loadArchiveInputs(opts.dataRoot, opts.from, opts.to);
  const merged = mergeBoatArchives(archives, missingDays);
  const period = {
    from: opts.from ?? (merged.races[0]?.date ?? null),
    to: opts.to ?? (merged.races[merged.races.length - 1]?.date ?? null),
  };
  const report = buildEvaluationReport(merged, period);
  const gradeOrder = summarizeGradeOrder(merged.races);
  const b13 = evaluateB13(merged.races);
  const b13v2 = evaluateB13V2(merged.races);

  const normalizedByDay = new Map<string, ReturnType<typeof normalizeBoatRace>[]>();
  const featuresByDay = new Map<string, ReturnType<typeof extractBoatFeatures>[]>();
  const forecastsByDay = new Map<string, ReturnType<typeof buildForecastRecord>[]>();

  for (const race of merged.races) {
    const fwd = merged.forwardResearch.get(race.id);
    const norm = normalizeBoatRace(race);
    const feat = extractBoatFeatures(race, fwd);
    const fcst = buildForecastRecord(race, fwd);
    normalizedByDay.set(race.date, [...(normalizedByDay.get(race.date) ?? []), norm]);
    featuresByDay.set(race.date, [...(featuresByDay.get(race.date) ?? []), feat]);
    forecastsByDay.set(race.date, [...(forecastsByDay.get(race.date) ?? []), fcst]);
  }

  const outputs: { layer: string; path: string; sha256: string; deterministicSha256: string; status: "written" | "skipped" | "dry-run" }[] = [];
  const emit = (layer: string, relDir: string, prefix: string, payload: unknown) => {
    const detCanonical = canonical(payload);
    const detHash = sha256Hex(detCanonical);
    const content = JSON.stringify(payload, null, 2) + "\n";
    const fileHash = sha256Hex(content);
    const relPath = `${relDir}/${prefix}-${detHash.slice(0, 8)}.json`;
    const fullPath = join(opts.outDir, relPath);
    const status = opts.write ? writeImmutable(fullPath, content) : "dry-run";
    outputs.push({ layer, path: relPath, sha256: fileHash, deterministicSha256: detHash, status });
  };

  if (opts.command === "normalize" || opts.command === "run") {
    for (const [day, items] of [...normalizedByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      emit("normalized", "normalized", day, { schemaVersion: "boatrace-normalized-day-v1", date: day, count: items.length, races: items });
    }
  }
  if (opts.command === "features" || opts.command === "run") {
    for (const [day, items] of [...featuresByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      emit("features", "features", day, { schemaVersion: "boatrace-features-day-v1", date: day, count: items.length, races: items });
    }
  }
  if (opts.command === "backtest" || opts.command === "run") {
    for (const [day, items] of [...forecastsByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      emit("forecasts", "forecasts", day, { schemaVersion: "boatrace-forecasts-day-v1", date: day, count: items.length, races: items });
    }
    const span = `${period.from ?? "none"}_${period.to ?? "none"}`;
    emit("evaluations", "evaluations", `b11-eval-${span}`, report);
    emit("evaluations", "evaluations", `grade-order-${span}`, { period, ...gradeOrder });
    emit("evaluations", "evaluations", `b13-${span}`, { period, ...b13 });
    emit("evaluations", "evaluations", `b13v2-${span}`, { period, ...b13v2 });
  }

  const deterministicHash = sha256Hex(canonical({
    period,
    inputs: inputFiles.map((f) => ({ path: f.path, sha256: f.sha256 })),
    report,
    gradeOrder,
    b13,
    b13v2,
    outputs: outputs.map((o) => ({ layer: o.layer, path: o.path, deterministicSha256: o.deterministicSha256 })),
  }));

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId: `${period.from ?? "all"}_${period.to ?? "all"}-${deterministicHash.slice(0, 12)}`,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    dataCommitSha: opts.dataSha ?? gitHead(opts.dataRoot),
    codeCommitSha: opts.codeSha ?? gitHead(process.cwd()),
    period,
    command: opts.command,
    config: {
      b11Version: "b11-sigma-research-v1",
      b13Version: B13_VERSION,
      b13v2Version: B13V2_VERSION,
      evaluatorVersion: report.evaluatorVersion,
      courseGate: "exhibition-123456",
    },
    inputs: inputFiles,
    outputs: outputs.map(({ layer, path, sha256, deterministicSha256 }) => ({ layer, path, sha256, deterministicSha256 })),
    deterministicHash,
  };

  if (opts.command === "run" || opts.command === "backtest") {
    const span = `${period.from ?? "none"}_${period.to ?? "none"}`;
    const manifestPath = join(opts.outDir, "manifests", `manifest-${span}-${deterministicHash.slice(0, 8)}.json`);
    const manifestContent = JSON.stringify(manifest, null, 2) + "\n";
    if (opts.write) {
      // manifest は generatedAt が変わる可能性があるため、同 deterministicHash が既にあればスキップして冪等性を保つ
      const status = existsSync(manifestPath) ? "skipped" : writeImmutable(manifestPath, manifestContent);
      outputs.push({
        layer: "manifests",
        path: `manifests/manifest-${span}-${deterministicHash.slice(0, 8)}.json`,
        sha256: sha256Hex(manifestContent),
        deterministicSha256: deterministicHash,
        status,
      });
    }
  }

  return { report, gradeOrder, b13, b13v2, manifest, outputs };
}

function pct(v: number | null) {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function printSummaryRows(label: string, summary: B11Summary, useGate: boolean) {
  const group = useGate ? summary.withCourseGate : summary;
  console.log(`\n[${label} / ${useGate ? "進入ゲートあり(展示123456)" : "進入ゲートなし(対照)"}] 総数 ${summary.total}R`);
  for (const { key, stats: s } of group.byCap) {
    printStatLine(key.padEnd(8), s);
  }
  for (const { sigmaClass, stats: s } of group.byClass) {
    printStatLine(`class:${sigmaClass}`.padEnd(12), s);
  }
}

function printStatLine(head: string, s: B11Stats) {
  console.log(
    `${head} 対象${s.targets} 適用${s.applied} モデル見送${s.modelSkip} 閾値外${s.outside} 欠損${s.unjudged} ゲート見送${s.gateSkip} ゲート保留${s.gatePending} | 精算${s.settled} 未確定${s.pending} 除外${s.excluded} | 的中${s.hits} ${pct(s.hitRate)} 投入${s.stake} 払戻${s.payout} 返還${s.refund} 損益${s.net} 回収${pct(s.roi)} 本番変化${s.actualChangedInApplied}`,
  );
}

export function formatReportText(report: BoatResearchEvaluationReport): string[] {
  const a = report.audit;
  const lines = [
    `期間: ${report.period.from ?? "—"} 〜 ${report.period.to ?? "—"} | アーカイブ: ${a.archiveFiles}ファイル | ユニーク: ${a.uniqueRaces}R (重複ID ${a.duplicateRaces})`,
    `日別: ${JSON.stringify(a.perDay)} | 欠損日: ${a.missingDays.join(",") || "なし"}`,
    `欠損級別: ${a.missingGradeCount}R | 結果なし: ${a.noResultCount}R | 事前凍結(freeze): ${a.preCutoffFreezeCount}R`,
    `展示進入: 事前${a.preCutoffExhibitionCount}R / 事後${a.postCutoffExhibitionCount}R / 欠損${a.missingExhibitionCount}R | 123456=${a.exhibition123456Count}R / 変更=${a.exhibitionChangedCount}R | 本番進入変更=${a.actualChangedCount}R (うち展示123456=${a.actualChangedWhenEx123456Count}R)`,
  ];
  return lines;
}

if (process.argv[1]?.endsWith("boatrace-research-cli.ts")) {
  const args = process.argv.slice(2);
  const cmd = args[0] as CliOptions["command"] | undefined;
  const valid = ["audit", "normalize", "features", "backtest", "report", "run"];
  if (!cmd || !valid.includes(cmd)) {
    console.error("使い方: boatrace-research-cli.ts <audit|normalize|features|backtest|report|run> <TurfLab-data> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out-dir path] [--write] [--generated-at ISO] [--data-sha SHA] [--code-sha SHA]");
    process.exit(2);
  }
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.slice(1).filter((a, i, arr) => !a.startsWith("--") && !arr[i - 1]?.startsWith("--"));
  const dataRoot = resolve(positional[0] ?? "../TurfLab-data");
  const outDir = resolve(opt("--out-dir") ?? join(dataRoot, "boatrace-research"));
  const write = args.includes("--write") || ["normalize", "features", "backtest", "run"].includes(cmd);
  const { report, gradeOrder, b13, b13v2, manifest, outputs } = runResearchPipeline({
    command: cmd,
    dataRoot,
    outDir,
    from: opt("--from"),
    to: opt("--to"),
    generatedAt: opt("--generated-at"),
    dataSha: opt("--data-sha"),
    codeSha: opt("--code-sha"),
    write: cmd === "audit" || cmd === "report" ? false : write,
  });

  for (const line of formatReportText(report)) console.log(line);
  if (cmd === "report" || cmd === "backtest" || cmd === "run") {
    const g = gradeOrder.overall;
    console.log(`\n[級別順守率] 対象 ${g.eligible}/${g.total}R | 上位3着 ${pct(g.top3.rate)} (${g.top3.concordant}/${g.top3.comparable}組) | 全6着 ${pct(g.full6.rate)} (${g.full6.concordant}/${g.full6.comparable}組, ${g.full6.races}R) | 1号艇敗北時 ${pct(gradeOrder.boat1Lost.top3.rate)}`);
    console.log("\n[B13 / reconstructed shadow]");
    for (const [id, s] of Object.entries(b13.models)) {
      console.log(`${id} 対象${s.targets} 適用${s.applied} 見送${s.skipped} 精算${s.settled} 未確定${s.pending} 除外${s.excluded} 的中${s.hits} 投入${s.stake} 払戻${s.payout} 返還${s.refund} 損益${s.net} 回収${pct(s.roi)} | log loss=${s.logLoss ?? "—"}`);
    }
    console.log(`\n[B13v2 / contextual Plackett-Luce shadow (main=${b13v2.mainModel}, 初期仮想予算=${b13v2.virtualBankrollInitialYen}円)]`);
    console.log(`  締切前展示取得: ${b13v2.missingness.preCutoffExhibition}/${b13v2.missingness.totalRaces}R (${pct(b13v2.missingness.preCutoffExhibitionRate)}) | 展示欠損: ${b13v2.missingness.missingExhibition}R`);
    for (const [id, s] of Object.entries(b13v2.models)) {
      console.log(`${id.padEnd(9)} 対象${s.targets} 適用${s.applied} 見送${s.skipped} 精算${s.settled} 的中${s.hits} ${pct(s.hitRate)} 投入${s.stake} 払戻${s.payout} 返還${s.refund} 損益${s.net} 残高${s.balanceEnd} 回収${pct(s.roi)} | LL=${s.logLoss !== null ? s.logLoss.toFixed(4) : "—"} Brier=${s.brierScore !== null ? s.brierScore.toFixed(5) : "—"}`);
    }
    printSummaryRows("reconstructed", report.reconstructed, false);
    printSummaryRows("reconstructed", report.reconstructed, true);
    if (report.forward.total > 0) {
      printSummaryRows("forward", report.forward, false);
      printSummaryRows("forward", report.forward, true);
    } else {
      console.log("\n[forward] 発走前凍結レコード 0件");
    }
  }
  if (outputs.length) {
    console.log(`\n出力 (${outputs.length}件, deterministicHash=${manifest.deterministicHash}):`);
    for (const o of outputs) console.log(`  ${o.status.padEnd(7)} ${o.layer.padEnd(11)} ${o.path}`);
  }
}
