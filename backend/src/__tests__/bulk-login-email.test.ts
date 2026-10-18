import { describe, it, expect } from "vitest";
import {
  buildPlusAddress,
  expandEmailTag,
  extractLoginCode,
} from "../jobs/bulkLoginEmail";

const noTgId = async () => {
  throw new Error("getTgId should not be called");
};

describe("buildPlusAddress", () => {
  it("inserts +suffix (phone digits) before the @ of a Gmail address", () => {
    expect(buildPlusAddress("myemail@gmail.com", "61412345678")).toBe(
      "myemail+61412345678@gmail.com",
    );
  });

  it("uses the last @ when the local part is unusual", () => {
    expect(buildPlusAddress("a.b@gmail.com", "42")).toBe("a.b+42@gmail.com");
  });

  it("throws on an address with no @", () => {
    expect(() => buildPlusAddress("not-an-email", "1")).toThrow();
  });
});

describe("expandEmailTag", () => {
  const ctx = { phoneNumber: "+61 412 345 678", accountId: 42, getTgId: noTgId };

  // Telegram rejects numeric email tags, so digits are mapped to letters (0=a..9=j).
  it("expands {phoneNum} to phone digits mapped to letters", async () => {
    expect(await expandEmailTag("{phoneNum}", ctx)).toBe("gbebcdefghi");
  });

  it("expands {id} to the account id mapped to letters", async () => {
    expect(await expandEmailTag("{id}", ctx)).toBe("ec");
  });

  it("fetches {tgId} only when referenced", async () => {
    const withId = {
      ...ctx,
      getTgId: async () => "7623901234",
    };
    expect(await expandEmailTag("{tgId}", withId)).toBe("hgcdjabcde");
  });

  it("strips address-unsafe characters", async () => {
    expect(await expandEmailTag("a b@c+{id}", ctx)).toBe("abcec");
  });

  it("throws when the template expands to nothing usable", async () => {
    await expect(expandEmailTag("@@@", ctx)).rejects.toThrow();
  });

  it("maps any remaining digits to letters (no numbers in the tag)", async () => {
    const tag = await expandEmailTag("{num:5}", ctx);
    expect(tag).toMatch(/^[a-j]{5}$/);
  });
});

describe("extractLoginCode", () => {
  it("prefers a code next to the word 'code'", () => {
    expect(
      extractLoginCode("Login code", "Your login code is 123456. Ignore 2026."),
    ).toBe("123456");
  });

  it("falls back to the first 5-7 digit run", () => {
    expect(extractLoginCode("", "Verification: 55123")).toBe("55123");
  });

  it("returns null when there is no code-like number", () => {
    expect(extractLoginCode("Hello", "no digits of the right length: 12")).toBe(
      null,
    );
  });
});
