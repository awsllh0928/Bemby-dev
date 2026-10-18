// vi.mock calls are hoisted before imports, preventing the DB from opening
vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
  getDefaultTgApiCredentials: vi.fn(),
}));

import { describe, it, expect, vi } from "vitest";
import {
  parseBulkAddInput,
  extractApiCredentials,
  extractField,
} from "../jobs/bulkAdd";

describe("parseBulkAddInput", () => {
  it("parses phone----apiUrl lines, trimming whitespace", () => {
    const input = [
      "+917507166497----https://example.com/getcode?id=80323dfc-9002",
      "  +918719968726----https://example.com/getcode?id=0eaa294a  ",
    ].join("\n");
    const { lines, errors } = parseBulkAddInput(input);
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      {
        phoneNumber: "+917507166497",
        apiUrl: "https://example.com/getcode?id=80323dfc-9002",
      },
      {
        phoneNumber: "+918719968726",
        apiUrl: "https://example.com/getcode?id=0eaa294a",
      },
    ]);
  });

  it("skips blank lines", () => {
    const { lines } = parseBulkAddInput("\n\n+1----http://x\n\n");
    expect(lines).toHaveLength(1);
  });

  it("treats a line without a separator as a phone-only account", () => {
    const { lines, errors } = parseBulkAddInput("+1----http://x\n+61412345678");
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      { phoneNumber: "+1", apiUrl: "http://x" },
      { phoneNumber: "+61412345678", apiUrl: "" },
    ]);
  });

  it("treats an empty url after the separator as phone-only", () => {
    const { lines, errors } = parseBulkAddInput("+1----");
    expect(errors).toEqual([]);
    expect(lines).toEqual([{ phoneNumber: "+1", apiUrl: "" }]);
  });

  it("reports lines with an empty phone number", () => {
    const { lines, errors } = parseBulkAddInput("----http://x");
    expect(lines).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Missing phone number");
  });
});

describe("extractApiCredentials", () => {
  const html = `
    <input id="code" class="form-input" type="text" value="42344" readonly="" style="">
    <input class="form-input" type="text" value="2026-07-18 14:46:01" readonly="">
    <input id="pass2fa" class="form-input" type="text" value="bemby" readonly="" style="">
  `;

  it("extracts the code and 2FA password from the page inputs", () => {
    expect(extractApiCredentials(html)).toEqual({
      code: "42344",
      pass2fa: "bemby",
    });
  });

  it("returns empty strings when the inputs are absent", () => {
    expect(extractApiCredentials("<div>no inputs here</div>")).toEqual({
      code: "",
      pass2fa: "",
    });
  });

  it("handles an empty (not-yet-ready) code value", () => {
    const empty = `<input id="code" value="" readonly><input id="pass2fa" value="bemby">`;
    expect(extractApiCredentials(empty)).toEqual({ code: "", pass2fa: "bemby" });
  });

  it("reads from custom field ids", () => {
    const custom = `<input id="otp" value="99887"><input id="tfa" value="secret">`;
    expect(
      extractApiCredentials(
        custom,
        { fieldId: "otp" },
        { fieldId: "tfa" },
      ),
    ).toEqual({ code: "99887", pass2fa: "secret" });
  });

  it("reads via a custom regex (capture group 1)", () => {
    const page = "Your code is 123456 and password is hunter2.";
    expect(
      extractApiCredentials(
        page,
        { regex: "code is (\\d+)" },
        { regex: "password is (\\w+)" },
      ),
    ).toEqual({ code: "123456", pass2fa: "hunter2" });
  });

  it("returns empty string for an invalid regex instead of throwing", () => {
    expect(extractField("<input id=\"code\" value=\"1\">", { regex: "(" })).toBe(
      "",
    );
  });
});
