/**
 * forecast-v1: the common, odds-free prediction contract shared by every forecaster
 * (mathematical model M, the AI, any blend). Pure: no I/O, no clock, no randomness.
 *
 * Rules enforced here (docs/forecast-validation.md):
 * - a forecast is numeric (win/top-3 probabilities, optional corner ranks and pace class);
 * - odds, popularity and external forecasts are declared unused and no such key may appear;
 * - the forecast is complete for the field, normalised, with information cutoff <= generated_at <= start;
 * - an AI forecast is only eligible for leak-free scoring when the race post-dates the model's
 *   knowledge cutoff.
 */
import { comparePaceReview, type PaceLabel, type PaceReviewComparison } from "./post-race-pace-review";

export const FORECAST_VERSION = "forecast-v1";
export const REASON_CATEGORIES = [
  "form", "speed", "pace_style", "going", "distance_course", "draw", "weight",
  "jockey", "jockey_horse", "rest_condition", "scratch_change", "other",
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];
export type ForecasterKind = "math" | "ai" | "blend";
export const CORNER_KEYS = ["first", "last"] as const;
const PROB_FLOOR = 1e-6;
const SUM_TOLERANCE = 0.02;

export interface ForecastHorse {
  horse_number: number;
  win_probability: number;
  top3_probability: number | null;
  corner_ranks: { first: number; last: number } | null;
  missing: { history: boolean } | null;
}

export interface Forecast {
  schema_version: typeof FORECAST_VERSION;
  report_type: "race_forecast";
  forecaster: { id: string; kind: ForecasterKind; model_version: string; model_knowledge_cutoff: string | null };
  race: {
    race_key_human: string; date_jst: string; track: string; race_no: number;
    distance_m: number | null; surface: string | null; scheduled_start_at_jst?: string | null;
  };
  cutoff_at: string;
  generated_at: string;
  input_hash: string;
  /** live: frozen before the start of a future race (leak-free by construction). replay: a past race re-run later. */
  mode?: "live" | "replay";
  inputs_attestation: { odds_used: false; popularity_used: false; external_forecasts_used: false };
  horses: ForecastHorse[];
  pace: { class: PaceLabel; z: number | null } | null;
  reason_categories: ReasonCategory[];
  /** Absent for math forecasts. */
  training?: Record<string, unknown>;
}

export type Validation = { ok: true; forecast: Forecast; floor_applied: boolean } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const FORBIDDEN_KEY = /odds|オッズ|popular|人気|ninki|payout|払戻|market/i;
const ATTESTATION_KEYS = new Set(["odds_used", "popularity_used", "external_forecasts_used"]);
const TZ_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function scanForbiddenKeys(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) value.forEach((v, i) => scanForbiddenKeys(v, `${path}[${i}]`, errors));
  else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k) && !ATTESTATION_KEYS.has(k)) errors.push(`${path}.${k}: オッズ・人気・市場に関するキーは禁止`);
      scanForbiddenKeys(v, `${path}.${k}`, errors);
    }
  }
}

function permutation(values: number[], n: number): boolean {
  if (values.length !== n) return false;
  return new Set(values).size === n && values.every((v) => Number.isInteger(v) && v >= 1 && v <= n);
}

/** Validate and normalise a forecast. `activeHorseNumbers` (when given) must match the field exactly. */
export function validateForecast(raw: unknown, activeHorseNumbers?: number[]): Validation {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["forecast must be an object"] };
  scanForbiddenKeys(raw, "forecast", errors);
  if (raw.schema_version !== FORECAST_VERSION) errors.push(`schema_version must be ${FORECAST_VERSION}`);
  if (raw.report_type !== "race_forecast") errors.push("report_type must be race_forecast");
  const f = isObj(raw.forecaster) ? raw.forecaster : {};
  if (typeof f.id !== "string" || !/^[a-z][a-z0-9-]{1,40}$/.test(f.id)) errors.push("forecaster.id invalid");
  if (!["math", "ai", "blend"].includes(String(f.kind))) errors.push("forecaster.kind invalid");
  if (typeof f.model_version !== "string" || !f.model_version) errors.push("forecaster.model_version required");
  if (raw.mode != null && raw.mode !== "live" && raw.mode !== "replay") errors.push("mode must be live|replay");
  const kc = f.model_knowledge_cutoff;
  if (kc != null && (typeof kc !== "string" || !/^\d{4}-\d{2}(-\d{2})?$/.test(kc))) errors.push("model_knowledge_cutoff must be YYYY-MM[-DD]");
  const race = isObj(raw.race) ? raw.race : {};
  if (typeof race.race_key_human !== "string" || !race.race_key_human) errors.push("race.race_key_human required");
  if (typeof race.date_jst !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(race.date_jst)) errors.push("race.date_jst invalid");
  if (typeof race.track !== "string" || !race.track) errors.push("race.track required");
  if (!Number.isInteger(race.race_no)) errors.push("race.race_no must be an integer");
  for (const key of ["cutoff_at", "generated_at"] as const) {
    if (typeof raw[key] !== "string" || !TZ_TIMESTAMP.test(raw[key] as string) || Number.isNaN(Date.parse(raw[key] as string)))
      errors.push(`${key} must be an ISO timestamp with a timezone`);
  }
  if (!errors.length && Date.parse(raw.cutoff_at as string) > Date.parse(raw.generated_at as string))
    errors.push("cutoff_at is after generated_at: information cannot post-date the forecast");
  const start = race.scheduled_start_at_jst;
  if (typeof start === "string" && !errors.length && Date.parse(raw.generated_at as string) > Date.parse(start))
    errors.push("generated_at is after the scheduled start: the forecast was not frozen before the race");
  if (raw.mode === "replay" && f.kind !== "math" && !f.model_knowledge_cutoff) errors.push("replay forecasts by AI require model_knowledge_cutoff");
  if (typeof raw.input_hash !== "string" || raw.input_hash.length < 16) errors.push("input_hash required (>=16 chars)");
  const att = isObj(raw.inputs_attestation) ? raw.inputs_attestation : {};
  for (const key of ATTESTATION_KEYS) if (att[key] !== false) errors.push(`inputs_attestation.${key} must be exactly false`);
  const reasons = Array.isArray(raw.reason_categories) ? raw.reason_categories : [];
  if (!Array.isArray(raw.reason_categories)) errors.push("reason_categories must be an array");
  for (const c of reasons) if (!REASON_CATEGORIES.includes(c as ReasonCategory)) errors.push(`unknown reason category: ${String(c)}`);
  const horsesRaw = Array.isArray(raw.horses) ? raw.horses : [];
  if (horsesRaw.length < 2) errors.push("horses must contain the whole field");
  const numbers: number[] = [];
  let sum = 0;
  let top3Sum = 0;
  let top3Count = 0;
  let cornerCount = 0;
  for (const [i, h] of horsesRaw.entries()) {
    if (!isObj(h)) { errors.push(`horses[${i}] must be an object`); continue; }
    if (!Number.isInteger(h.horse_number) || (h.horse_number as number) < 1) errors.push(`horses[${i}].horse_number invalid`);
    else numbers.push(h.horse_number as number);
    const p = h.win_probability;
    if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > 1) errors.push(`horses[${i}].win_probability must be in (0,1]`);
    else sum += p;
    if (h.top3_probability != null) {
      const t = h.top3_probability;
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) errors.push(`horses[${i}].top3_probability invalid`);
      else { top3Sum += t; top3Count++; }
      if (typeof p === "number" && typeof t === "number" && t + 1e-9 < p) errors.push(`horses[${i}].top3_probability < win_probability`);
    }
    if (h.corner_ranks != null) {
      if (!isObj(h.corner_ranks) || !CORNER_KEYS.every((k) => Number.isInteger((h.corner_ranks as Record<string, unknown>)[k]))) errors.push(`horses[${i}].corner_ranks needs integer first/last`);
      else cornerCount++;
    }
  }
  if (new Set(numbers).size !== numbers.length) errors.push("duplicate horse_number");
  if (activeHorseNumbers) {
    const want = [...activeHorseNumbers].sort((a, b) => a - b).join(",");
    if ([...numbers].sort((a, b) => a - b).join(",") !== want) errors.push("horses do not match the active field exactly");
  }
  if (Number.isFinite(sum) && horsesRaw.length && Math.abs(sum - 1) > SUM_TOLERANCE) errors.push(`win_probability sums to ${sum.toFixed(4)}, expected 1±${SUM_TOLERANCE}`);
  if (top3Count && top3Count !== horsesRaw.length) errors.push("top3_probability must be given for every horse or none");
  if (top3Count === horsesRaw.length && horsesRaw.length >= 3 && Math.abs(top3Sum - 3) > 0.3) errors.push(`top3_probability sums to ${top3Sum.toFixed(3)}, expected about 3`);
  if (cornerCount && cornerCount !== horsesRaw.length) errors.push("corner_ranks must be given for every horse or none");
  if (cornerCount === horsesRaw.length) {
    for (const k of CORNER_KEYS) {
      const vals = horsesRaw.map((h) => ((h as Record<string, Record<string, number>>).corner_ranks)[k]);
      if (!permutation(vals, horsesRaw.length)) errors.push(`corner_ranks.${k} must be a 1..n permutation (no ties)`);
    }
  }
  if (raw.pace != null) {
    const pace = raw.pace as Record<string, unknown>;
    if (!isObj(pace) || !["slow", "middle", "high"].includes(String(pace.class))) errors.push("pace.class must be slow|middle|high");
    else if (pace.z != null && (typeof pace.z !== "number" || !Number.isFinite(pace.z))) errors.push("pace.z must be finite");
  }
  if (errors.length) return { ok: false, errors };
  let floored = false;
  const horses: ForecastHorse[] = (horsesRaw as Record<string, unknown>[]).map((h) => {
    let p = (h.win_probability as number) / sum;
    if (p < PROB_FLOOR) { p = PROB_FLOOR; floored = true; }
    return {
      horse_number: h.horse_number as number, win_probability: p,
      top3_probability: (h.top3_probability as number | null | undefined) ?? null,
      corner_ranks: (h.corner_ranks as ForecastHorse["corner_ranks"] | undefined) ?? null,
      missing: (h.missing as ForecastHorse["missing"] | undefined) ?? null,
    };
  });
  const norm = horses.reduce((s, h) => s + h.win_probability, 0);
  for (const h of horses) h.win_probability /= norm;
  return {
    ok: true, floor_applied: floored,
    forecast: { ...(raw as unknown as Forecast), horses, reason_categories: reasons as ReasonCategory[], pace: (raw.pace as Forecast["pace"]) ?? null },
  };
}

/**
 * Live forecasts of a future race cannot contain its result. Replays by an AI are leak-free only for
 * races after the model's knowledge cutoff (the model may have seen earlier results in training).
 */
export function leakFreeEligible(f: Forecast): boolean {
  if (f.forecaster.kind === "math" || (f.mode ?? "live") === "live") return true;
  const cutoff = f.forecaster.model_knowledge_cutoff;
  if (!cutoff) return false;
  const normalised = cutoff.length === 7 ? `${cutoff}-28` : cutoff; // month-only cutoffs are treated as month end
  return f.race.date_jst > normalised;
}

export interface RaceResult {
  race_key_human: string;
  date_jst: string;
  /** Horse numbers of the winner(s); more than one for a dead heat. */
  winners: number[];
  /** Official order. finish null = did not finish. */
  finishers: { horse_number: number; finish: number | null }[];
  /** Observed corner order per horse number; only measured corners, null when missing. */
  corners?: Record<string, { first: number | null; last: number | null }>;
  /** Pace class observed against a time-consistent course baseline; null when no baseline. */
  pace_observed?: PaceLabel | null;
}

export interface ForecastScore {
  race_key_human: string;
  log_loss: number;
  brier: number;
  top3_brier: number | null;
  pace_class_match: boolean | null;
  pace_review: PaceReviewComparison | null;
  floor_applied: boolean;
}

export function scoreForecast(f: Forecast, result: RaceResult): ForecastScore {
  const byNumber = new Map(f.horses.map((h) => [h.horse_number, h]));
  if (!result.winners.length || result.winners.some((w) => !byNumber.has(w)))
    throw new Error(`result winners are not in the forecast field for ${f.race.race_key_human}`);
  const losses = result.winners.map((w) => -Math.log(Math.max(byNumber.get(w)!.win_probability, PROB_FLOOR)));
  const log_loss = losses.reduce((s, x) => s + x, 0) / losses.length;
  const won = new Set(result.winners);
  const brier = f.horses.reduce((s, h) => s + (h.win_probability - (won.has(h.horse_number) ? 1 : 0)) ** 2, 0);
  let top3_brier: number | null = null;
  if (f.horses.every((h) => h.top3_probability != null)) {
    const finish = new Map(result.finishers.map((r) => [r.horse_number, r.finish]));
    top3_brier = f.horses.reduce((s, h) => {
      const fin = finish.get(h.horse_number);
      return s + (h.top3_probability! - (fin != null && fin <= 3 ? 1 : 0)) ** 2;
    }, 0) / f.horses.length;
  }
  // Wires the previously unused numeric pace comparison into scoring.
  let pace_review: PaceReviewComparison | null = null;
  let pace_class_match: boolean | null = null;
  if (f.pace && result.pace_observed) pace_class_match = f.pace.class === result.pace_observed;
  if (f.horses.every((h) => h.corner_ranks) && result.corners) {
    pace_review = comparePaceReview({
      corner_labels: [...CORNER_KEYS],
      predicted: { pace: f.pace?.class ?? null, runners: f.horses.map((h) => ({ entry_id: String(h.horse_number), corner_ranks: { ...h.corner_ranks! } })) },
      observed: {
        pace: result.pace_observed ?? null,
        runners: f.horses.map((h) => {
          const o = result.corners![String(h.horse_number)];
          return { entry_id: String(h.horse_number), corner_ranks: { first: o?.first ?? null, last: o?.last ?? null } };
        }),
      },
    });
  }
  return { race_key_human: f.race.race_key_human, log_loss, brier, top3_brier, pace_class_match, pace_review, floor_applied: f.horses.some((h) => h.win_probability <= PROB_FLOOR * 1.0001) };
}
