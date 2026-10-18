// vi.mock calls are hoisted before imports, preventing the DB from opening
vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi } from "vitest";
import {
  expandCommand,
  isAiBtn,
  parseAiBtnHint,
  hasAiInput,
  parseAiInputLength,
  buildCaptchaPrompt,
  htmlToText,
} from "../jobs/checkin";

// ---------------------------------------------------------------------------
// expandCommand
// ---------------------------------------------------------------------------

describe("expandCommand", () => {
  it("returns the template unchanged when there are no placeholders", () => {
    expect(expandCommand("/checkin")).toBe("/checkin");
    expect(expandCommand("/start")).toBe("/start");
  });

  it("{word} produces 6 lowercase letters by default", () => {
    const result = expandCommand("{word}");
    expect(result).toMatch(/^[a-z]{6}$/);
  });

  it("{word:N} respects the custom length", () => {
    expect(expandCommand("{word:4}")).toMatch(/^[a-z]{4}$/);
    expect(expandCommand("{word:10}")).toMatch(/^[a-z]{10}$/);
  });

  it("{WORD} produces 6 uppercase letters by default", () => {
    expect(expandCommand("{WORD}")).toMatch(/^[A-Z]{6}$/);
  });

  it("{WORD:N} respects the custom length", () => {
    expect(expandCommand("{WORD:3}")).toMatch(/^[A-Z]{3}$/);
  });

  it("{num} produces 6 digits by default", () => {
    expect(expandCommand("{num}")).toMatch(/^\d{6}$/);
  });

  it("{num:N} respects the custom length", () => {
    expect(expandCommand("{num:4}")).toMatch(/^\d{4}$/);
  });

  it("{alpha} produces 8 alphanumeric characters by default", () => {
    expect(expandCommand("{alpha}")).toMatch(/^[a-zA-Z0-9]{8}$/);
  });

  it("{alpha:N} respects the custom length", () => {
    expect(expandCommand("{alpha:5}")).toMatch(/^[a-zA-Z0-9]{5}$/);
  });

  it("{uuid} produces a valid RFC 4122 v4 UUID", () => {
    const uuid = expandCommand("{uuid}");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("UUID version and variant bits are always correct across multiple calls", () => {
    for (let i = 0; i < 20; i++) {
      const uuid = expandCommand("{uuid}");
      // version nibble must be 4
      expect(uuid[14]).toBe("4");
      // variant nibble must be 8, 9, a, or b
      expect(["8", "9", "a", "b"]).toContain(uuid[19]);
    }
  });

  it("leaves unknown placeholders untouched", () => {
    expect(expandCommand("{foo}")).toBe("{foo}");
    expect(expandCommand("{bar:5}")).toBe("{bar:5}");
  });

  it("expands multiple placeholders in one string", () => {
    const result = expandCommand("/code {num:4}-{word:3}");
    expect(result).toMatch(/^\/code \d{4}-[a-z]{3}$/);
  });

  it("expands known placeholders while leaving unknown ones", () => {
    const result = expandCommand("{word} {unknown}");
    expect(result).toMatch(/^[a-z]{6} \{unknown\}$/);
  });
});

// ---------------------------------------------------------------------------
// isAiBtn
// ---------------------------------------------------------------------------

describe("isAiBtn", () => {
  it("recognises the bare placeholder", () => {
    expect(isAiBtn("{aiBtn}")).toBe(true);
  });

  it("recognises a placeholder with a hint", () => {
    expect(isAiBtn("{aiBtn:sign in}")).toBe(true);
    expect(isAiBtn("{aiBtn:click the check-in button}")).toBe(true);
  });

  it("rejects a placeholder with an empty hint", () => {
    expect(isAiBtn("{aiBtn:}")).toBe(false);
  });

  it("rejects plain button text", () => {
    expect(isAiBtn("签到")).toBe(false);
    expect(isAiBtn("Check In")).toBe(false);
  });

  it("rejects other placeholders", () => {
    expect(isAiBtn("{anyBtn}")).toBe(false);
    expect(isAiBtn("{word}")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isAiBtn("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAiBtnHint
// ---------------------------------------------------------------------------

describe("parseAiBtnHint", () => {
  it("returns undefined for the bare placeholder", () => {
    expect(parseAiBtnHint("{aiBtn}")).toBeUndefined();
  });

  it("returns the hint text", () => {
    expect(parseAiBtnHint("{aiBtn:sign in}")).toBe("sign in");
    expect(parseAiBtnHint("{aiBtn:click to check in}")).toBe("click to check in");
  });

  it("trims whitespace from the hint", () => {
    expect(parseAiBtnHint("{aiBtn:  trim me  }")).toBe("trim me");
  });
});

// ---------------------------------------------------------------------------
// hasAiInput
// ---------------------------------------------------------------------------

describe("hasAiInput", () => {
  it("returns false for commands with no placeholders", () => {
    expect(hasAiInput("/start")).toBe(false);
    expect(hasAiInput("/checkin")).toBe(false);
  });

  it("returns true for the bare {aiInput} placeholder", () => {
    expect(hasAiInput("{aiInput}")).toBe(true);
    expect(hasAiInput("/start {aiInput}")).toBe(true);
  });

  it("returns true for {aiInput:N} with a length", () => {
    expect(hasAiInput("{aiInput:6}")).toBe(true);
    expect(hasAiInput("/code {aiInput:4}")).toBe(true);
  });

  it("returns false for other placeholders", () => {
    expect(hasAiInput("{word}")).toBe(false);
    expect(hasAiInput("{aiBtn}")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAiInputLength
// ---------------------------------------------------------------------------

describe("parseAiInputLength", () => {
  it("returns undefined when there is no length suffix", () => {
    expect(parseAiInputLength("{aiInput}")).toBeUndefined();
    expect(parseAiInputLength("/start {aiInput}")).toBeUndefined();
    expect(parseAiInputLength("/start")).toBeUndefined();
  });

  it("parses the length from {aiInput:N}", () => {
    expect(parseAiInputLength("{aiInput:6}")).toBe(6);
    expect(parseAiInputLength("/start {aiInput:12}")).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// buildCaptchaPrompt
// ---------------------------------------------------------------------------

describe("buildCaptchaPrompt", () => {
  it("builds a generic prompt when no length is given", () => {
    const prompt = buildCaptchaPrompt();
    expect(prompt).toBe(
      "Read this captcha image. Reply with ONLY the captcha characters, nothing else.",
    );
  });

  it("includes the exact length when provided", () => {
    expect(buildCaptchaPrompt(6)).toContain("exactly 6 characters");
    expect(buildCaptchaPrompt(4)).toContain("exactly 4 characters");
  });
});

// ---------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------

describe("htmlToText", () => {
  it("leaves plain text unchanged", () => {
    expect(htmlToText("Hello World")).toBe("Hello World");
  });

  it("strips simple HTML tags", () => {
    expect(htmlToText("<strong>bold</strong>")).toBe("bold");
    expect(htmlToText("<em>italic</em>")).toBe("italic");
  });

  it("replaces block/inline tags with a space and collapses whitespace", () => {
    expect(htmlToText("<p>Hello</p><p>World</p>")).toBe("Hello World");
    expect(htmlToText("Hello<br>World")).toBe("Hello World");
  });

  it("collapses multiple whitespace runs into a single space", () => {
    expect(htmlToText("<b>a</b>   <b>b</b>")).toBe("a b");
  });

  it("trims leading and trailing whitespace", () => {
    expect(htmlToText("  <b>hi</b>  ")).toBe("hi");
  });

  it("returns an empty string for an empty input", () => {
    expect(htmlToText("")).toBe("");
  });

  it("handles nested tags", () => {
    expect(htmlToText("<div><span>text</span></div>")).toBe("text");
  });
});
