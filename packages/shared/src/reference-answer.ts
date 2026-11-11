import { obj, rows, type Row } from "./domain";
import { scoreWeights } from "./scoring";

// Pure projection of observations already supplied by ChatGPT. Missing scores
// remain missing; there is no model invocation, inferred probability or score fill.
export function referenceAnswer(
  reference: Row,
  pack: Row,
  generatedAt: string,
): Row | null {
  if (reference.answer) return obj(reference.answer);
  const horses = rows(reference.horses);
  if (
    !horses.length ||
    !horses.every(
      (h) =>
        h.estimated_components &&
        Object.keys(scoreWeights).every(
          (key) => typeof obj(h.estimated_components)[key] === "number",
        ),
    )
  )
    return null;
  const scenarios = rows(reference.scenarios ?? []);
  if (
    scenarios.length !== 3 ||
    !reference.main_pace ||
    !reference.main_pace_reason
  )
    return null;
  const active = rows(pack.entries).filter((e) => e.status === "active");
  // Producers may write a JST offset; Core stores UTC instants.
  const generated = Number.isFinite(Date.parse(generatedAt))
    ? new Date(generatedAt).toISOString()
    : generatedAt;
  return {
    pack_hash: pack.pack_hash,
    generated_at: generated,
    rationale: reference.rationale ?? reference.main_pace_reason,
    main_pace: reference.main_pace,
    main_pace_reason: reference.main_pace_reason,
    limitations:
      "AI参考推定（producerは来歴参照）・名前一致のみ。公式個体/出典/取消/全頭完全性未照合。同名混同リスクあり。未観測情報はunknown",
    horse_evaluations: active.map((e) => {
      const h = horses.find((h) => h.horse_number === e.horse_number)!;
      return {
        horse_number: e.horse_number,
        horse_name: e.horse_name,
        components: h.estimated_components!,
        course_fit: h.course_fit ?? "unknown",
        jockey_fit: h.jockey_fit ?? "unknown",
        expected_position: h.expected_position ?? "unknown",
        rationale: h.evidence_note ?? "unknown",
      };
    }),
    scenarios: scenarios.map((s) => ({
      pace: s.pace,
      analysis: s.narrative ?? s.analysis ?? "unknown",
      lineup: active.map((e) => {
        const positions = Object.entries(obj(s.positions ?? {})).filter(
          ([, numbers]) =>
            Array.isArray(numbers) && numbers.includes(e.horse_number),
        );
        // Missing or ambiguous positions fail the normal answer validator.
        return {
          horse_number: e.horse_number,
          horse_name: e.horse_name,
          position: positions.length === 1 ? positions[0][0] : null,
          advantage:
            Array.isArray(s.favored) && s.favored.includes(e.horse_number)
              ? "参考推定:有利"
              : Array.isArray(s.unfavored) &&
                  s.unfavored.includes(e.horse_number)
                ? "参考推定:不利"
                : "unknown",
        };
      }),
    })),
    recommendations: reference.reference_bets ?? [],
    ...(typeof reference.skip_reason === "string"
      ? { skip_reason: reference.skip_reason }
      : {}),
  };
}
