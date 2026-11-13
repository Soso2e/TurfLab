// Tendency tags (tendency-v1): short, deterministic labels for how a horse or
// a jockey has run recently. Computed by code from saved runs only — never by
// an LLM — and only from runs strictly before the race day. Every tag carries
// its sample size; a tag is omitted when the sample is too small.
import type { Json } from "./domain";
import { cornerChange, runningStyle, type RunningStyle } from "./run-record";

export const TENDENCY_VERSION = "tendency-v1";

export type TendencyKind = "style" | "move" | "stretch" | "result" | "form";
export type TendencyTag = {
  kind: TendencyKind;
  label: string;
  /** Plain explanation shown on hover / tap. */
  detail: string;
  /** Runs (or rides) the tag is based on. */
  sample: number;
  tone: "good" | "bad" | "neutral";
};

/** One run as stored in `performances` (only the fields used here). */
export type TendencyRun = {
  finish_position?: Json;
  corner_positions_json?: Json;
  field_size?: Json;
};

const HORSE_RUNS = 10;
const JOCKEY_RIDES = 50;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const num = (v: Json | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function styles(runs: TendencyRun[]): RunningStyle[] {
  return runs
    .map((r) => runningStyle(r.corner_positions_json ?? null, r.field_size ?? null))
    .filter((s): s is RunningStyle => s !== null);
}

function share(list: string[], pick: (s: string) => boolean) {
  return list.length ? list.filter(pick).length / list.length : 0;
}

/** Horse tags from its runs, newest first (at most the latest 10 are used). */
export function horseTendency(allRuns: TendencyRun[]): TendencyTag[] {
  const runs = allRuns.slice(0, HORSE_RUNS);
  const tags: TendencyTag[] = [];

  const st = styles(runs);
  if (st.length >= 3) {
    const counts = new Map<string, number>();
    for (const s of st) counts.set(s, (counts.get(s) ?? 0) + 1);
    const [top, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    tags.push(
      count / st.length >= 0.6
        ? { kind: "style", label: top, detail: `通過順のある${st.length}走中${count}走が${top}`, sample: st.length, tone: "neutral" }
        : { kind: "style", label: "自在", detail: `${st.length}走で脚質が分散（最多 ${top} ${count}走）`, sample: st.length, tone: "neutral" },
    );
  }

  const changes = runs.map((r) => cornerChange(r.corner_positions_json ?? null, r.finish_position ?? null));
  const inRace = changes.map((c) => c.in_race).filter((v): v is number => v !== null);
  if (inRace.length >= 3 && mean(inRace) >= 2)
    tags.push({ kind: "move", label: "まくり型", detail: `道中で平均${mean(inRace).toFixed(1)}頭押し上げ（${inRace.length}走）`, sample: inRace.length, tone: "good" });
  const stretch = changes.map((c) => c.stretch).filter((v): v is number => v !== null);
  if (stretch.length >= 3) {
    const m = mean(stretch);
    if (m >= 1.5)
      tags.push({ kind: "stretch", label: "末脚堅実", detail: `直線で平均${m.toFixed(1)}頭差し込む（${stretch.length}走）`, sample: stretch.length, tone: "good" });
    else if (m <= -1.5)
      tags.push({ kind: "stretch", label: "直線失速", detail: `直線で平均${(-m).toFixed(1)}頭後退（${stretch.length}走）`, sample: stretch.length, tone: "bad" });
  }

  const finished = runs
    .map((r) => ({ finish: num(r.finish_position), field: num(r.field_size) }))
    .filter((r): r is { finish: number; field: number | null } => r.finish !== null && r.finish >= 1);
  const n = finished.length;
  if (n >= 3) {
    const wins = finished.filter((r) => r.finish === 1).length;
    const top3 = finished.filter((r) => r.finish <= 3).length;
    const winRate = wins / n, top3Rate = top3 / n;
    const base = `${n}走 ${wins}勝・3着内${top3}回`;
    if (n >= 4 && winRate >= 0.3 && top3 > 0 && wins / top3 >= 0.6)
      tags.push({ kind: "result", label: "勝ち切り型", detail: `${base}（勝率${pct(winRate)}。好走時は勝ち切る）`, sample: n, tone: "good" });
    else if (top3Rate >= 0.5)
      tags.push({ kind: "result", label: `堅実 複勝${pct(top3Rate)}`, detail: `${base}（3着以内率${pct(top3Rate)}）`, sample: n, tone: "good" });
    if (n >= 4 && top3Rate >= 0.4 && winRate <= 0.1)
      tags.push({ kind: "result", label: "善戦止まり", detail: `${base}（2・3着が多く勝ち切れない）`, sample: n, tone: "neutral" });
    const bad = finished.filter((r) => r.field !== null && r.finish > r.field / 2).length;
    if (n >= 4 && top3 >= 2 && bad >= 2)
      tags.push({ kind: "result", label: "ムラあり", detail: `${base}・後方半分の着順${bad}回`, sample: n, tone: "neutral" });
  }

  const last3 = runs.slice(0, 3).map((r) => num(r.finish_position));
  if (last3.length === 3 && last3.every((v): v is number => v !== null && v >= 1)) {
    const [a, b, c] = last3; // a = latest
    if (a < b && b < c)
      tags.push({ kind: "form", label: "上昇気配", detail: `直近3走 ${c}→${b}→${a}着`, sample: 3, tone: "good" });
    else if (a > b && b > c)
      tags.push({ kind: "form", label: "下降気味", detail: `直近3走 ${c}→${b}→${a}着`, sample: 3, tone: "bad" });
  }
  return tags;
}

/** Jockey tags from the jockey's rides (any horse), newest first. */
export function jockeyTendency(allRides: TendencyRun[]): TendencyTag[] {
  const rides = allRides.slice(0, JOCKEY_RIDES);
  const tags: TendencyTag[] = [];
  const st = styles(rides);
  if (st.length >= 10) {
    const front = share(st, (s) => s === "逃げ" || s === "先行");
    const back = share(st, (s) => s === "差し" || s === "追込");
    if (front >= 0.55)
      tags.push({ kind: "style", label: "前に行かせる", detail: `${st.length}騎乗の${pct(front)}が逃げ・先行`, sample: st.length, tone: "neutral" });
    else if (back >= 0.6)
      tags.push({ kind: "style", label: "控える", detail: `${st.length}騎乗の${pct(back)}が差し・追込`, sample: st.length, tone: "neutral" });
  }
  const inRace = rides
    .map((r) => cornerChange(r.corner_positions_json ?? null, r.finish_position ?? null).in_race)
    .filter((v): v is number => v !== null);
  if (inRace.length >= 10 && mean(inRace) >= 1)
    tags.push({ kind: "move", label: "押し上げる", detail: `道中で平均${mean(inRace).toFixed(1)}頭押し上げ（${inRace.length}騎乗）`, sample: inRace.length, tone: "good" });
  const finishes = rides.map((r) => num(r.finish_position)).filter((v): v is number => v !== null && v >= 1);
  const n = finishes.length;
  if (n >= 10) {
    const winRate = finishes.filter((f) => f === 1).length / n;
    const top3Rate = finishes.filter((f) => f <= 3).length / n;
    if (winRate >= 0.2)
      tags.push({ kind: "result", label: `勝率${pct(winRate)}`, detail: `${n}騎乗で勝率${pct(winRate)}・3着内率${pct(top3Rate)}`, sample: n, tone: "good" });
    else if (top3Rate >= 0.45)
      tags.push({ kind: "result", label: `複勝${pct(top3Rate)}`, detail: `${n}騎乗で3着内率${pct(top3Rate)}`, sample: n, tone: "good" });
  }
  return tags;
}
