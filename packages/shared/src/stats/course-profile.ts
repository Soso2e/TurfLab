// Course features that statistics alone cannot give: where the hills are.
// Values are transcribed from each organiser's public course guide. Entries
// not re-checked against the guide are marked verified:false and shown as such.

export type SlopeClass = "steep" | "moderate" | "flat";
export const SLOPE_LABEL: Record<SlopeClass, string> = {
  steep: "急坂",
  moderate: "坂あり",
  flat: "平坦",
};

export type CourseProfile = {
  track: string;
  /** Slope in the home straight (what a horse meets at the finish). */
  stretch_slope: SlopeClass;
  /** Total elevation difference of the course in metres (turf, outer if two). */
  elevation_m: number | null;
  note: string;
  source_url: string;
  /** Checked against the official guide in this repository's research notes. */
  verified: boolean;
};

const JRA = (slug: string) => `https://www.jra.go.jp/facilities/race/${slug}/course/index.html`;

export const COURSE_PROFILES: Record<string, CourseProfile> = {
  中山: { track: "中山", stretch_slope: "steep", elevation_m: 5.3, note: "ゴール前の急坂（高低差2.2m・最大勾配2.24%はJRA最大）", source_url: JRA("nakayama"), verified: true },
  阪神: { track: "阪神", stretch_slope: "steep", elevation_m: 2.4, note: "ゴール前に急坂", source_url: JRA("hanshin"), verified: false },
  東京: { track: "東京", stretch_slope: "moderate", elevation_m: 2.7, note: "直線中ほどに坂。直線525.9m", source_url: JRA("tokyo"), verified: true },
  中京: { track: "中京", stretch_slope: "moderate", elevation_m: 3.5, note: "2012年改修で直線に坂を新設。直線412.5m", source_url: JRA("chukyo"), verified: true },
  京都: { track: "京都", stretch_slope: "flat", elevation_m: 4.3, note: "3コーナーの坂（外4.3m/内3.1m）以外はほぼ平坦。直線は平坦", source_url: JRA("kyoto"), verified: true },
  新潟: { track: "新潟", stretch_slope: "flat", elevation_m: 2.2, note: "直線は平坦（外回り658.7m）", source_url: JRA("niigata"), verified: false },
  札幌: { track: "札幌", stretch_slope: "flat", elevation_m: 0.7, note: "ほぼ平坦", source_url: JRA("sapporo"), verified: false },
  函館: { track: "函館", stretch_slope: "flat", elevation_m: 3.5, note: "向正面から上り、直線はほぼ平坦", source_url: JRA("hakodate"), verified: false },
  福島: { track: "福島", stretch_slope: "flat", elevation_m: 1.9, note: "小さな起伏。直線は短く平坦に近い", source_url: JRA("fukushima"), verified: false },
  小倉: { track: "小倉", stretch_slope: "flat", elevation_m: 3.0, note: "向正面〜3角に起伏、直線は平坦", source_url: JRA("kokura"), verified: false },
  盛岡: { track: "盛岡", stretch_slope: "steep", elevation_m: 4.6, note: "直線に上り坂（地方で数少ない坂のあるコース）", source_url: "https://www.iwatekeiba.or.jp/", verified: false },
};

/** Profile of a track; NAR tracks without an entry are flat ovals. */
export function courseProfile(track: string): CourseProfile | null {
  if (COURSE_PROFILES[track]) return COURSE_PROFILES[track];
  const flatNar = ["門別", "水沢", "浦和", "船橋", "大井", "川崎", "金沢", "笠松", "名古屋", "園田", "姫路", "高知", "佐賀"];
  if (flatNar.includes(track))
    return { track, stretch_slope: "flat", elevation_m: null, note: "平坦な周回コース", source_url: "https://www.keiba.go.jp/", verified: false };
  return null;
}

/** "坂あり" groups steep and moderate stretches. */
export const hasSlope = (track: string): boolean | null => {
  const p = courseProfile(track);
  return p ? p.stretch_slope !== "flat" : null;
};
