import type { Row } from "../../../packages/shared/src/domain";

/** Diagrammatic illustration only: does not claim surveyed rail geometry or start gate placement. */
export function CourseSchematic({ course }: { course: Row }) {
  const surface = String(course.surface ?? "");
  const direction = String(course.direction ?? "");
  const layout = String(course.layout ?? "");
  const distance = Number(course.distance_m);
  const straight = Number(course.straight_length_m);
  const firstTurn = Number(course.start_to_first_turn_m);
  const straightCourse = direction === "straight";
  const dirLabel = direction === "left" ? "左回り" : direction === "right" ? "右回り" : direction === "straight" ? "直線" : "回り方向未取得";
  const trackColor = surface === "芝" ? "#2a9863" : surface === "ダート" ? "#ba915c" : "#64748b";
  return (
    <figure className="course-schematic" aria-label={`コース模式図: ${surface || "馬場未取得"} ${Number.isFinite(distance) && distance > 0 ? distance + "m" : "距離未取得"}、${dirLabel}`}>
      <svg viewBox="0 0 340 165" role="img" aria-label="コースの概略図。実際のコース形状やスタート位置を表した図ではありません">
        {straightCourse ? (
          <>
            <path d="M 18 55 H 320 M 18 110 H 320" fill="none" stroke={trackColor} strokeWidth="9" strokeLinecap="round" />
            <path d="M 50 82 H 288" fill="none" stroke="currentColor" opacity=".6" strokeWidth="2" strokeDasharray="8 6" />
            <path d="M 288 82 l -13 -7 v 14 Z" fill="currentColor" opacity=".8" />
            <text x="22" y="42" fontSize="12" fill="currentColor">START（概略）</text>
            <text x="277" y="42" fontSize="12" fill="currentColor">GOAL</text>
          </>
        ) : (
          <>
            <rect x="22" y="16" width="296" height="132" rx="60" fill="none" stroke={trackColor} strokeWidth="15" />
            <rect x="22" y="16" width="296" height="132" rx="60" fill="none" stroke="currentColor" opacity=".22" strokeWidth="1.5" />
            <text x="170" y="78" fontSize="15" fontWeight="700" textAnchor="middle" fill="currentColor">{dirLabel}</text>
            <text x="170" y="97" fontSize="11" textAnchor="middle" fill="currentColor">{layout || "形状区分未取得"}</text>
            <path d={direction === "right" ? "M 120 24 H 206 l -13 -7 m 13 7 l -13 7" : "M 206 24 H 120 l 13 -7 m -13 7 l 13 7"} stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" />
            <path d="M 246 143 V 156" stroke="currentColor" strokeWidth="3" />
            <text x="251" y="158" fontSize="10" fill="currentColor">GOAL（模式位置）</text>
          </>
        )}
      </svg>
      <figcaption className="course-schematic-caption">
        <strong>{surface || "馬場未取得"}{Number.isFinite(distance) && distance > 0 ? ` ${distance}m` : ""} · {dirLabel}</strong>
        <span>{Number.isFinite(straight) && straight > 0 ? `直線 ${straight}m` : "直線距離未取得"} · {Number.isFinite(firstTurn) && firstTurn >= 0 ? `初回コーナーまで ${firstTurn}m` : "初回コーナー距離未取得"}</span>
        <small>模式図（実測した外周形状・スタート地点・高低差は未反映）。正確なコース図ではありません。</small>
      </figcaption>
    </figure>
  );
}
