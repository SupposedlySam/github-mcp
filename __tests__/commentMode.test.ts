import { planCommentMode } from "../src/commentMode.js";
import { applySignature } from "../src/signature.js";

describe("planCommentMode", () => {
  it("resolves to top-level when no targeting options are given", () => {
    expect(planCommentMode({})).toEqual({ mode: "top-level" });
  });

  it("resolves to reply when in_reply_to is set", () => {
    expect(planCommentMode({ in_reply_to: 42 })).toEqual({
      mode: "reply",
      in_reply_to: 42,
    });
  });

  it("prefers reply over inline when both option sets are present", () => {
    expect(
      planCommentMode({ in_reply_to: 42, path: "src/a.ts", line: 7 })
    ).toEqual({ mode: "reply", in_reply_to: 42 });
  });

  it("resolves to inline with RIGHT side default", () => {
    expect(planCommentMode({ path: "src/a.ts", line: 7 })).toEqual({
      mode: "inline",
      path: "src/a.ts",
      line: 7,
      side: "RIGHT",
    });
  });

  it("keeps an explicit side", () => {
    expect(planCommentMode({ path: "src/a.ts", line: 7, side: "LEFT" })).toEqual(
      { mode: "inline", path: "src/a.ts", line: 7, side: "LEFT" }
    );
  });

  it("defaults start_side to side for multi-line ranges", () => {
    expect(
      planCommentMode({ path: "src/a.ts", line: 9, start_line: 5, side: "LEFT" })
    ).toEqual({
      mode: "inline",
      path: "src/a.ts",
      line: 9,
      side: "LEFT",
      start_line: 5,
      start_side: "LEFT",
    });
  });

  it("keeps an explicit start_side", () => {
    expect(
      planCommentMode({
        path: "src/a.ts",
        line: 9,
        start_line: 5,
        start_side: "LEFT",
      })
    ).toEqual({
      mode: "inline",
      path: "src/a.ts",
      line: 9,
      side: "RIGHT",
      start_line: 5,
      start_side: "LEFT",
    });
  });

  it("omits start_side when there is no start_line", () => {
    const plan = planCommentMode({
      path: "src/a.ts",
      line: 7,
      start_side: "LEFT",
    });
    expect(plan).toEqual({
      mode: "inline",
      path: "src/a.ts",
      line: 7,
      side: "RIGHT",
    });
  });

  it("errors when path is given without line", () => {
    expect(planCommentMode({ path: "src/a.ts" })).toEqual({
      error: "Inline comments require both path and line",
    });
  });

  it("errors when line is given without path", () => {
    expect(planCommentMode({ line: 7 })).toEqual({
      error: "Inline comments require both path and line",
    });
  });
});

describe("signature across comment modes", () => {
  const SIG = "— 🤖 Example MCP Bot";
  const env = { GITHUB_COMMENT_SIGNATURE: SIG };

  const modeOptions = {
    "top-level": {},
    reply: { in_reply_to: 42 },
    inline: { path: "src/a.ts", line: 7 },
  } as const;

  it.each(Object.entries(modeOptions))(
    "signs the body identically in %s mode",
    (mode, options) => {
      const plan = planCommentMode(options);
      expect(plan).toMatchObject({ mode });
      expect(applySignature("Looks good", env)).toBe(`Looks good\n\n${SIG}`);
    }
  );

  it.each(Object.entries(modeOptions))(
    "does not double-append in %s mode when already signed",
    (mode, options) => {
      const plan = planCommentMode(options);
      expect(plan).toMatchObject({ mode });
      const signed = `Looks good\n\n${SIG}`;
      expect(applySignature(signed, env)).toBe(signed);
    }
  );
});
