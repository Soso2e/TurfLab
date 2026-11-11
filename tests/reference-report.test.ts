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
