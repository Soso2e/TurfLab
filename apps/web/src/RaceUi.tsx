import React from "react";
import type { Json } from "../../../packages/shared/src/domain";

/** 券種の日本語表記。未知の券種はそのまま表示する。 */
export const ticketTypeNames: Record<string, string> = {
  win: "単勝",
  place: "複勝",
  bracket_quinella: "枠連",
  bracket_exacta: "枠単",
  quinella: "馬連",
  wide: "ワイド",
  exacta: "馬単",
  trio: "三連複",
  trifecta: "三連単",
};
export const ticketTypeName = (type: Json | undefined) =>
  ticketTypeNames[String(type)] ?? String(type ?? "—");

/**
 * 頭数から馬番→枠番を求める（JRA・地方共通の8枠割当）。
 * 8頭以下は馬番＝枠番。9頭以上は外枠から順に2頭ずつ（必要なら3頭）入る。
 */
export function frameOf(horseNumber: number, fieldSize: number): number | null {
  if (!Number.isFinite(horseNumber) || horseNumber < 1) return null;
  const size = Math.max(fieldSize, horseNumber);
  if (size <= 8) return horseNumber;
  const base = Math.floor(size / 8);
  const extra = size % 8;
  let start = 1;
  for (let frame = 1; frame <= 8; frame++) {
    const count = base + (frame > 8 - extra ? 1 : 0);
    if (horseNumber < start + count) return frame;
    start += count;
  }
  return 8;
}

/** 馬番を枠色で表示する。fieldSize不明時は枠色なし。 */
export function HorseNo({
  n,
  fieldSize,
  size = "md",
}: {
  n: Json | undefined;
  fieldSize?: number;
  size?: "sm" | "md" | "lg";
}) {
  const num = Number(n);
  if (n == null || !Number.isFinite(num))
    return <span className={`horse-no size-${size}`}>?</span>;
  const frame = fieldSize ? frameOf(num, fieldSize) : null;
  return (
    <span
      className={`horse-no size-${size} ${frame ? "frame-" + frame : ""}`}
      title={frame ? `${frame}枠 ${num}番` : `${num}番`}
    >
      {num}
    </span>
  );
}

const marks = ["◎", "○", "▲", "△", "☆"];
/** 予想順位から印を返す（1〜5位）。 */
export const markOf = (rank: Json | undefined) => {
  const r = Number(rank);
  return Number.isInteger(r) && r >= 1 && r <= marks.length ? marks[r - 1] : "";
};
export function Mark({ rank }: { rank: Json | undefined }) {
  const m = markOf(rank);
  return m ? (
    <span className={`mark mark-${Number(rank)}`} aria-label={`${rank}位`}>
      {m}
    </span>
  ) : (
    <span className="mark mark-none">{String(rank ?? "")}</span>
  );
}

/** 0〜1の確率を横棒で表示する。 */
export function ProbBar({
  value,
  tone = "win",
}: {
  value: Json | undefined;
  tone?: "win" | "top3";
}) {
  if (typeof value !== "number" || !Number.isFinite(value))
    return <span className="prob-empty">—</span>;
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <span className={`prob prob-${tone}`}>
      <span className="prob-track">
        <span className="prob-fill" style={{ width: `${clamped * 100}%` }} />
      </span>
      <span className="prob-label">{(value * 100).toFixed(1)}%</span>
    </span>
  );
}

/** 買い目（券種＋馬番）をチップで表示する。 */
export function TicketChip({
  type,
  selections,
  amount,
  fieldSize,
}: {
  type: Json | undefined;
  selections: Json[];
  amount?: Json;
  fieldSize?: number;
}) {
  const sep = ["exacta", "trifecta", "bracket_exacta"].includes(String(type))
    ? "→"
    : "-";
  return (
    <span className="ticket-chip">
      <span className="ticket-type">{ticketTypeName(type)}</span>
      <span className="ticket-numbers">
        {selections.map((s, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="ticket-sep">{sep}</span>}
            <HorseNo n={s} fieldSize={fieldSize} size="sm" />
          </React.Fragment>
        ))}
      </span>
      {typeof amount === "number" && (
        <span className="ticket-amount">¥{amount.toLocaleString("ja-JP")}</span>
      )}
    </span>
  );
}

/** 発走までの残り時間の表示とトーン。 */
export function countdownInfo(minutes: number | null): {
  label: string;
  tone: "far" | "soon" | "now" | "past";
} | null {
  if (minutes === null) return null;
  if (minutes > 60) {
    const h = Math.floor(minutes / 60);
    return { label: `あと${h}時間${minutes % 60}分`, tone: "far" };
  }
  if (minutes > 10) return { label: `あと${minutes}分`, tone: "soon" };
  if (minutes > 0) return { label: `あと${minutes}分`, tone: "now" };
  if (minutes >= -15) return { label: "発走直前・発走中", tone: "now" };
  return { label: "発走済み", tone: "past" };
}
