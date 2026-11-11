export interface CourseSpec {
  direction: "left" | "right" | "straight";
  straight_length_m: number;
  start_to_first_turn_m: number;
  layout: string;
  course_width_m?: number;
}

interface TrackGeneral {
  direction: "left" | "right" | "straight";
  dirt_straight_m: number;
  turf_straight_m?: number;
  course_width_m?: number;
  default_start_to_first_turn_m: number;
}

const TRACK_GENERAL: Record<string, TrackGeneral> = {
  川崎: { direction: "left", dirt_straight_m: 300, course_width_m: 25, default_start_to_first_turn_m: 400 },
  門別: { direction: "right", dirt_straight_m: 330, course_width_m: 25, default_start_to_first_turn_m: 300 },
  金沢: { direction: "right", dirt_straight_m: 236, course_width_m: 23, default_start_to_first_turn_m: 350 },
  大井: { direction: "right", dirt_straight_m: 386, course_width_m: 25, default_start_to_first_turn_m: 300 },
  船橋: { direction: "left", dirt_straight_m: 308, course_width_m: 25, default_start_to_first_turn_m: 350 },
  浦和: { direction: "left", dirt_straight_m: 220, course_width_m: 22, default_start_to_first_turn_m: 300 },
  盛岡: { direction: "left", dirt_straight_m: 300, turf_straight_m: 300, course_width_m: 25, default_start_to_first_turn_m: 350 },
  水沢: { direction: "right", dirt_straight_m: 245, course_width_m: 20, default_start_to_first_turn_m: 250 },
  園田: { direction: "right", dirt_straight_m: 213, course_width_m: 22, default_start_to_first_turn_m: 300 },
  姫路: { direction: "right", dirt_straight_m: 233, course_width_m: 22, default_start_to_first_turn_m: 300 },
  笠松: { direction: "right", dirt_straight_m: 201, course_width_m: 20, default_start_to_first_turn_m: 250 },
  名古屋: { direction: "right", dirt_straight_m: 240, course_width_m: 23, default_start_to_first_turn_m: 250 },
  高知: { direction: "right", dirt_straight_m: 200, course_width_m: 22, default_start_to_first_turn_m: 250 },
  佐賀: { direction: "right", dirt_straight_m: 200, course_width_m: 22, default_start_to_first_turn_m: 300 },
  帯広: { direction: "straight", dirt_straight_m: 200, course_width_m: 16, default_start_to_first_turn_m: 0 },
  東京: { direction: "left", dirt_straight_m: 501, turf_straight_m: 526, course_width_m: 30, default_start_to_first_turn_m: 400 },
  中山: { direction: "right", dirt_straight_m: 308, turf_straight_m: 310, course_width_m: 25, default_start_to_first_turn_m: 350 },
  京都: { direction: "right", dirt_straight_m: 329, turf_straight_m: 404, course_width_m: 28, default_start_to_first_turn_m: 350 },
  阪神: { direction: "right", dirt_straight_m: 353, turf_straight_m: 474, course_width_m: 28, default_start_to_first_turn_m: 350 },
  中京: { direction: "left", dirt_straight_m: 411, turf_straight_m: 413, course_width_m: 28, default_start_to_first_turn_m: 350 },
  新潟: { direction: "left", dirt_straight_m: 354, turf_straight_m: 659, course_width_m: 25, default_start_to_first_turn_m: 350 },
  札幌: { direction: "right", dirt_straight_m: 264, turf_straight_m: 266, course_width_m: 25, default_start_to_first_turn_m: 300 },
  函館: { direction: "right", dirt_straight_m: 260, turf_straight_m: 262, course_width_m: 25, default_start_to_first_turn_m: 300 },
  福島: { direction: "right", dirt_straight_m: 296, turf_straight_m: 292, course_width_m: 25, default_start_to_first_turn_m: 300 },
  小倉: { direction: "right", dirt_straight_m: 291, turf_straight_m: 293, course_width_m: 25, default_start_to_first_turn_m: 300 },
};

// Course-specific exact specifications key: `${normTrack}:${surface}:${distance_m}`
const EXACT_COURSES: Record<string, CourseSpec> = {
  // 川崎
  "川崎:ダート:900": { direction: "left", straight_length_m: 300, start_to_first_turn_m: 400, layout: "ワンターン", course_width_m: 25 },
  "川崎:ダート:1400": { direction: "left", straight_length_m: 300, start_to_first_turn_m: 300, layout: "周回", course_width_m: 25 },
  "川崎:ダート:1500": { direction: "left", straight_length_m: 300, start_to_first_turn_m: 400, layout: "周回ポケット発走", course_width_m: 25 },
  "川崎:ダート:1600": { direction: "left", straight_length_m: 300, start_to_first_turn_m: 500, layout: "周回ポケット発走", course_width_m: 25 },
  "川崎:ダート:2000": { direction: "left", straight_length_m: 300, start_to_first_turn_m: 400, layout: "周回", course_width_m: 25 },
  "川崎:ダート:2100": { direction: "left", straight_length_m: 300, start_to_first_turn_m: 500, layout: "周回スタンド前発走", course_width_m: 25 },

  // 門別
  "門別:ダート:1000": { direction: "right", straight_length_m: 218, start_to_first_turn_m: 330, layout: "内回りワンターン", course_width_m: 25 },
  "門別:ダート:1100": { direction: "right", straight_length_m: 218, start_to_first_turn_m: 430, layout: "内回りワンターン", course_width_m: 25 },
  "門別:ダート:1200": { direction: "right", straight_length_m: 330, start_to_first_turn_m: 270, layout: "外回りワンターン", course_width_m: 25 },
  "門別:ダート:1700": { direction: "right", straight_length_m: 330, start_to_first_turn_m: 170, layout: "外回り周回", course_width_m: 25 },
  "門別:ダート:1800": { direction: "right", straight_length_m: 330, start_to_first_turn_m: 270, layout: "外回り周回スタンド前発走", course_width_m: 25 },
  "門別:ダート:2000": { direction: "right", straight_length_m: 330, start_to_first_turn_m: 470, layout: "外回り周回", course_width_m: 25 },

  // 金沢
  "金沢:ダート:1400": { direction: "right", straight_length_m: 236, start_to_first_turn_m: 350, layout: "周回", course_width_m: 23 },
  "金沢:ダート:1500": { direction: "right", straight_length_m: 236, start_to_first_turn_m: 450, layout: "周回", course_width_m: 23 },
  "金沢:ダート:1900": { direction: "right", straight_length_m: 236, start_to_first_turn_m: 350, layout: "周回", course_width_m: 23 },
  "金沢:ダート:2100": { direction: "right", straight_length_m: 236, start_to_first_turn_m: 550, layout: "周回", course_width_m: 23 },

  // 大井
  "大井:ダート:1000": { direction: "right", straight_length_m: 286, start_to_first_turn_m: 250, layout: "内回りワンターン", course_width_m: 25 },
  "大井:ダート:1200": { direction: "right", straight_length_m: 286, start_to_first_turn_m: 450, layout: "内回りワンターン", course_width_m: 25 },
  "大井:ダート:1400": { direction: "right", straight_length_m: 386, start_to_first_turn_m: 250, layout: "外回り周回", course_width_m: 25 },
  "大井:ダート:1600": { direction: "right", straight_length_m: 286, start_to_first_turn_m: 250, layout: "内回り周回", course_width_m: 25 },
  "大井:ダート:1650": { direction: "right", straight_length_m: 286, start_to_first_turn_m: 300, layout: "内回り周回", course_width_m: 25 },
  "大井:ダート:1700": { direction: "right", straight_length_m: 386, start_to_first_turn_m: 150, layout: "外回り周回", course_width_m: 25 },
  "大井:ダート:1800": { direction: "right", straight_length_m: 386, start_to_first_turn_m: 250, layout: "外回り周回", course_width_m: 25 },
  "大井:ダート:2000": { direction: "right", straight_length_m: 386, start_to_first_turn_m: 450, layout: "外回り周回スタンド前発走", course_width_m: 25 },

  // 船橋
  "船橋:ダート:1000": { direction: "left", straight_length_m: 262, start_to_first_turn_m: 250, layout: "内回りワンターン", course_width_m: 25 },
  "船橋:ダート:1200": { direction: "left", straight_length_m: 308, start_to_first_turn_m: 400, layout: "外回りワンターン", course_width_m: 25 },
  "船橋:ダート:1500": { direction: "left", straight_length_m: 308, start_to_first_turn_m: 250, layout: "外回り周回", course_width_m: 25 },
  "船橋:ダート:1600": { direction: "left", straight_length_m: 308, start_to_first_turn_m: 350, layout: "外回り周回", course_width_m: 25 },
  "船橋:ダート:1700": { direction: "left", straight_length_m: 308, start_to_first_turn_m: 450, layout: "外回り周回", course_width_m: 25 },
  "船橋:ダート:1800": { direction: "left", straight_length_m: 308, start_to_first_turn_m: 250, layout: "外回り周回スタンド前発走", course_width_m: 25 },

  // 浦和
  "浦和:ダート:800": { direction: "left", straight_length_m: 220, start_to_first_turn_m: 300, layout: "ワンターン", course_width_m: 22 },
  "浦和:ダート:1400": { direction: "left", straight_length_m: 220, start_to_first_turn_m: 300, layout: "周回", course_width_m: 22 },
  "浦和:ダート:1500": { direction: "left", straight_length_m: 220, start_to_first_turn_m: 400, layout: "周回", course_width_m: 22 },
  "浦和:ダート:1600": { direction: "left", straight_length_m: 220, start_to_first_turn_m: 200, layout: "周回ポケット発走", course_width_m: 22 },
  "浦和:ダート:2000": { direction: "left", straight_length_m: 220, start_to_first_turn_m: 300, layout: "周回スタンド前発走", course_width_m: 22 },

  // 園田
  "園田:ダート:820": { direction: "right", straight_length_m: 213, start_to_first_turn_m: 150, layout: "ワンターン", course_width_m: 22 },
  "園田:ダート:1230": { direction: "right", straight_length_m: 213, start_to_first_turn_m: 200, layout: "周回", course_width_m: 22 },
  "園田:ダート:1400": { direction: "right", straight_length_m: 213, start_to_first_turn_m: 377, layout: "周回", course_width_m: 22 },
  "園田:ダート:1700": { direction: "right", straight_length_m: 213, start_to_first_turn_m: 327, layout: "周回", course_width_m: 22 },
  "園田:ダート:1870": { direction: "right", straight_length_m: 213, start_to_first_turn_m: 200, layout: "周回スタンド前発走", course_width_m: 22 },

  // 高知
  "高知:ダート:800": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 150, layout: "ワンターン", course_width_m: 22 },
  "高知:ダート:1300": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 250, layout: "周回", course_width_m: 22 },
  "高知:ダート:1400": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 350, layout: "周回", course_width_m: 22 },
  "高知:ダート:1600": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 200, layout: "周回", course_width_m: 22 },
  "高知:ダート:1900": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 250, layout: "周回", course_width_m: 22 },

  // 佐賀
  "佐賀:ダート:900": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 200, layout: "ワンターン", course_width_m: 22 },
  "佐賀:ダート:1300": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 250, layout: "周回", course_width_m: 22 },
  "佐賀:ダート:1400": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 350, layout: "周回", course_width_m: 22 },
  "佐賀:ダート:1750": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 300, layout: "周回", course_width_m: 22 },
  "佐賀:ダート:1800": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 350, layout: "周回スタンド前発走", course_width_m: 22 },
  "佐賀:ダート:2000": { direction: "right", straight_length_m: 200, start_to_first_turn_m: 200, layout: "周回", course_width_m: 22 },
};

export function normalizeTrackName(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/競馬場$/u, "");
}

export function normalizeSurface(raw: unknown): "ダート" | "芝" | "障害" {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("芝") || s === "turf") return "芝";
  if (s.includes("障") || s.includes("obstacle")) return "障害";
  return "ダート";
}

/**
 * Looks up course specifications (straight length, distance to first turn, direction, layout).
 * Prioritizes exact matches, then falls back to track-level defaults.
 */
const JRA_TRACKS = new Set(["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"]);
const NAR_TRACKS = new Set(["門別", "帯広", "盛岡", "水沢", "浦和", "船橋", "大井", "川崎", "金沢", "笠松", "名古屋", "園田", "姫路", "高知", "佐賀"]);

export function detectJurisdiction(trackRaw: unknown): "JRA" | "NAR" | "unknown" {
  const track = normalizeTrackName(trackRaw);
  if (JRA_TRACKS.has(track)) return "JRA";
  if (NAR_TRACKS.has(track)) return "NAR";
  return "unknown";
}

export function lookupCourseSpecs(
  trackRaw: unknown,
  surfaceRaw: unknown,
  distanceRaw: unknown,
): CourseSpec | null {
  const track = normalizeTrackName(trackRaw);
  if (!track) return null;
  const surface = normalizeSurface(surfaceRaw);
  const distance = Number(distanceRaw);
  if (!Number.isFinite(distance) || distance <= 0) return null;

  const key = `${track}:${surface}:${distance}`;
  const exact = EXACT_COURSES[key];
  if (exact) return exact;

  const general = TRACK_GENERAL[track];
  if (!general) return null;

  const straight = surface === "芝" && general.turf_straight_m ? general.turf_straight_m : general.dirt_straight_m;
  return {
    direction: general.direction,
    straight_length_m: straight,
    start_to_first_turn_m: general.default_start_to_first_turn_m,
    layout: `${surface}周回`,
    course_width_m: general.course_width_m,
  };
}
