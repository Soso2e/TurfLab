import { describe, expect, it } from "vitest";
import { validateReferenceMirror } from "../workers/api/src/reference-report";

const now="2026-11-03T00:10:00.000Z";
const report={
  schema_version:"1",report_type:"chatgpt_daily_reference",
  date_jst:"2026-11-03",generated_at:"2026-11-03T00:02:00Z",
  core_importable:false,races:[{race_key_human:"2026-11-03|金沢|7"}],
};
const input={
  path:"daily/2026-11-03/morning-reference-v1.json",
  sha:"a".repeat(40),document:report,
};
describe("reference mirror is only a bounded immutable display artifact",()=>{
  it("accepts valid reference JSON but marks it not Core importable",()=>{
    const x=validateReferenceMirror(input,now);
    expect(x.date_jst).toBe("2026-11-03");
    expect(x.core_importable).toBe(false);
    expect(x.path).toBe(input.path);
  });
  it("accepts next-day race references created the previous day", () => {
    const nextDay = {
      ...report,
      report_type: "ai_daily_reference",
      producer: "chatgpt",
      date_jst: "2026-11-22",
      generated_at: "2026-11-21T15:48:23+09:00",
    };
    const mirror = validateReferenceMirror({
      ...input,
      path: "daily/2026-11-22/chatgpt/morning-reference-v1.json",
      document: nextDay,
    }, "2026-11-21T16:00:00+09:00");
    expect(mirror.date_jst).toBe("2026-11-22");
    expect(mirror.producer).toBe("chatgpt");
    expect(mirror.core_importable).toBe(false);
  });
  it("rejects reports generated after the event date or in the future", () => {
    const nextDay = {...report, date_jst: "2026-11-22"};
    const path = "daily/2026-11-22/morning-reference-v1.json";
    expect(() => validateReferenceMirror({
      ...input, path,
      document: {...nextDay, generated_at: "2026-11-23T00:00:00+09:00"},
    }, "2026-11-24T00:00:00+09:00")).toThrow(/生成日時/);
    expect(() => validateReferenceMirror({
      ...input, path,
      document: {...nextDay, generated_at: "2026-11-21T23:00:00+09:00"},
    }, "2026-11-21T22:00:00+09:00")).toThrow(/生成日時/);
  });
  it("rejects wrong paths, sha and forged Core status",()=>{
    expect(()=>validateReferenceMirror({...input,path:"daily/2026-11-02/morning-reference-v1.json"},now)).toThrow();
    expect(()=>validateReferenceMirror({...input,sha:"bad"},now)).toThrow();
    expect(()=>validateReferenceMirror({...input,document:{...report,core_importable:true}},now)).toThrow();
  });
});

describe("any AI can file a daily reference under its own producer folder", () => {
  it("root-level files stay ChatGPT; folders name the producer", () => {
    expect(validateReferenceMirror(input, now).producer).toBe("chatgpt");
    const claude = validateReferenceMirror({
      ...input,
      path: "daily/2026-11-03/claude/morning-reference-v1.json",
      document: { ...report, report_type: "ai_daily_reference", producer: "claude", model: "claude-opus-5-5" },
    }, now);
    expect(claude.producer).toBe("claude");
    // Folder alone is enough; producer may be omitted.
    expect(validateReferenceMirror({
      ...input, path: "daily/2026-11-03/gemini/morning-reference-v2.json",
    }, now).producer).toBe("gemini");
  });
  it("rejects a producer that disagrees with its folder or an invalid folder name", () => {
    const doc = { ...report, report_type: "ai_daily_reference", producer: "claude" };
    expect(() => validateReferenceMirror({ ...input, path: "daily/2026-11-03/gemini/morning-reference-v1.json", document: doc }, now)).toThrow(/一致しません/);
    expect(() => validateReferenceMirror({ ...input, document: doc }, now)).toThrow(/claude/);
    expect(() => validateReferenceMirror({ ...input, path: "daily/2026-11-03/Claude_AI/morning-reference-v1.json" }, now)).toThrow();
    expect(() => validateReferenceMirror({ ...input, path: "daily/2026-11-03/a/b/morning-reference-v1.json" }, now)).toThrow();
    expect(() => validateReferenceMirror({ ...input, document: { ...report, report_type: "other" } }, now)).toThrow();
  });
});
