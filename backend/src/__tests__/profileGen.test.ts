// vi.mock is hoisted before imports, keeping the DB (and the AI credential lookup) shut
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
  parseProfiles,
  buildProfilePrompt,
  PROFILE_LIMITS,
  dropDuplicatedSurname,
} from "../jobs/profileGen";

describe("parseProfiles", () => {
  it("reads the JSON array a well-behaved model returns", () => {
    const raw = '[{"firstName":"伟","lastName":"张","about":"喜欢电影"}]';
    expect(parseProfiles(raw, 1)).toEqual([
      { firstName: "伟", lastName: "张", about: "喜欢电影" },
    ]);
  });

  it("digs the array out of code fences and chatter", () => {
    const raw = 'Sure!\n```json\n[{"firstName":"Mary","lastName":"Jones","about":""}]\n```';
    expect(parseProfiles(raw, 1)).toEqual([
      { firstName: "Mary", lastName: "Jones", about: "" },
    ]);
  });

  it("falls back to tab columns when the model ignores the JSON instruction", () => {
    const raw = "John\tSmith\tHey there\nMary\tJones\t";
    expect(parseProfiles(raw, 2)).toEqual([
      { firstName: "John", lastName: "Smith", about: "Hey there" },
      { firstName: "Mary", lastName: "Jones", about: "" },
    ]);
  });

  it("clamps every field to what Telegram accepts", () => {
    const raw = JSON.stringify([
      { firstName: "a".repeat(90), lastName: "b".repeat(90), about: "c".repeat(120) },
    ]);
    const [p] = parseProfiles(raw, 1);
    expect([...p.firstName]).toHaveLength(PROFILE_LIMITS.firstName);
    expect([...p.lastName]).toHaveLength(PROFILE_LIMITS.lastName);
    expect([...p.about]).toHaveLength(PROFILE_LIMITS.about);
  });

  it("never cuts an emoji in half", () => {
    const raw = JSON.stringify([{ firstName: "A", lastName: "", about: "🎬".repeat(90) }]);
    const [p] = parseProfiles(raw, 1);
    expect([...p.about]).toHaveLength(PROFILE_LIMITS.about);
    expect(p.about).not.toContain("�");
  });

  it("strips tabs and newlines, which would shift the form's columns", () => {
    const raw = JSON.stringify([
      { firstName: "Jo\thn", lastName: "Sm\nith", about: "line\tone\ntwo" },
    ]);
    expect(parseProfiles(raw, 1)).toEqual([
      { firstName: "Jo hn", lastName: "Sm ith", about: "line one two" },
    ]);
  });

  it("drops rows with no first name, which the bulk form would reject", () => {
    const raw = JSON.stringify([
      { firstName: "", lastName: "Jones", about: "x" },
      { firstName: "  ", lastName: "Brown", about: "y" },
      { firstName: "Ann", lastName: "", about: "z" },
    ]);
    expect(parseProfiles(raw, 3)).toEqual([
      { firstName: "Ann", lastName: "", about: "z" },
    ]);
  });

  it("drops repeats so a batch is not handed the same person twice", () => {
    const raw = JSON.stringify([
      { firstName: "John", lastName: "Smith", about: "a" },
      { firstName: "john", lastName: "smith", about: "b" },
      { firstName: "Mary", lastName: "Smith", about: "c" },
    ]);
    expect(parseProfiles(raw, 3).map((p) => p.firstName)).toEqual(["John", "Mary"]);
  });

  it("stops at the number of accounts, however many the model volunteered", () => {
    const raw = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({ firstName: `N${i}`, lastName: "", about: "" })),
    );
    expect(parseProfiles(raw, 3)).toHaveLength(3);
  });

  it("returns nothing usable rather than junk when the model just talked", () => {
    expect(parseProfiles("I cannot help with that.", 2)).toEqual([
      { firstName: "I cannot help with that.", lastName: "", about: "" },
    ]);
    expect(parseProfiles("", 2)).toEqual([]);
  });
});

describe("without bios", () => {
  it("drops the about column whatever the model volunteered", () => {
    const raw = JSON.stringify([{ firstName: "Ann", lastName: "Lee", about: "chatty" }]);
    expect(parseProfiles(raw, 1, false)).toEqual([
      { firstName: "Ann", lastName: "Lee", about: "" },
    ]);
  });

  it("asks for names only, so the model spends nothing on bios", () => {
    const prompt = buildProfilePrompt(3, undefined, false);
    expect(prompt).toContain('"firstName", "lastName". Do not write bios');
    expect(prompt).not.toContain("short bio line");
    expect(prompt).not.toContain('"about"');
  });
});

describe("buildProfilePrompt", () => {
  it("states the count, the shape and the limits", () => {
    const prompt = buildProfilePrompt(3);
    expect(prompt).toContain("3 plausible Telegram user profiles");
    expect(prompt).toContain(`at most ${PROFILE_LIMITS.about} characters`);
    expect(prompt).toContain("No tabs and no line breaks");
    expect(prompt).not.toContain("They must fit this");
  });

  it("passes the operator's requirement through", () => {
    const prompt = buildProfilePrompt(2, "names a Chinese person would pick");
    expect(prompt).toContain("They must fit this requirement");
    expect(prompt).toContain("names a Chinese person would pick");
  });

  it("asks for what real accounts look like: nicknames, and scripts that vary", () => {
    const prompt = buildProfilePrompt(2);
    expect(prompt).toMatch(/nickname/);
    expect(prompt).toMatch(/lastName is empty/);
    expect(prompt).toMatch(/pinyin/);
  });
});

describe("dropDuplicatedSurname", () => {
  it("drops a surname the model repeated into the given-name field", () => {
    expect(dropDuplicatedSurname("张伟", "张")).toBe("伟");
    expect(dropDuplicatedSurname("Lǐ Xiǎo", "Lǐ")).toBe("Xiǎo");
    expect(dropDuplicatedSurname("John Smith", "Smith")).toBe("John");
    expect(dropDuplicatedSurname("smith john", "Smith")).toBe("john");
  });

  it("leaves a name that merely starts the same way alone", () => {
    expect(dropDuplicatedSurname("Anna", "Ann")).toBe("Anna");
    expect(dropDuplicatedSurname("Wang", "Wang")).toBe("Wang");
    expect(dropDuplicatedSurname("小明", "")).toBe("小明");
    expect(dropDuplicatedSurname("Mary Jane", "Smith")).toBe("Mary Jane");
  });

  it("takes effect through the parse, so no pair reads as a doubled surname", () => {
    const raw = JSON.stringify([{ firstName: "张伟", lastName: "张", about: "" }]);
    expect(parseProfiles(raw, 1)).toEqual([
      { firstName: "伟", lastName: "张", about: "" },
    ]);
  });
});
