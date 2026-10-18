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
import { Api } from "telegram";
import {
  extractCodes,
  containsAny,
  compileCodeRegex,
  sanitizeAiCode,
  buildCodeFixPrompt,
  beginTextWait,
  beginAfterCodeWait,
  findAfterCodeTarget,
  applyCodeEdits,
} from "../jobs/autoreg";

const PREFIX = "ABC-30-Register_";

describe("extractCodes", () => {
  it("extracts a single code from a line, stripping the * decoy", () => {
    const { codes, usedPartials } = extractCodes(
      "ABC-30-Register_xk3mh*puUZR",
      PREFIX,
    );
    expect(codes).toEqual(["ABC-30-Register_xk3mhpuUZR"]);
    expect(usedPartials).toEqual([]);
  });

  it("extracts multiple codes on separate lines, stripping decoys", () => {
    const text = [
      "🎯 somebot已为您生成了 30天 注册码 5 个",
      "删除“*”",
      "ABC-30-Register_xk3mh*puUZR",
      "ABC-30-Register_SljWEmZa*Qd",
      "ABC-30-Register_MEPR*XKiE3I",
    ].join("\n");
    const { codes } = extractCodes(text, PREFIX);
    expect(codes).toEqual([
      "ABC-30-Register_xk3mhpuUZR",
      "ABC-30-Register_SljWEmZaQd",
      "ABC-30-Register_MEPRXKiE3I",
    ]);
  });

  it("strips a ~ decoy without truncating the code", () => {
    const text = [
      "删除符号“~”",
      "ABC-30-Register_C~3vLEpVAYh",
      "ABC-30-Register_H~a4uGmPetN",
    ].join("\n");
    const { codes, usedPartials } = extractCodes(text, PREFIX);
    expect(codes).toEqual([
      "ABC-30-Register_C3vLEpVAYh",
      "ABC-30-Register_Ha4uGmPetN",
    ]);
    expect(usedPartials).toEqual([]);
  });

  it("discards a short fragment quoted in chat", () => {
    const { codes, usedPartials } = extractCodes(
      "我复制了第一个码是这样子的ABC-30-Register_C",
      PREFIX,
    );
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual([]);
  });

  it("treats a masked code as a used-code announcement, not a fresh code", () => {
    const text =
      "🎫 注册码使用 - SomeUser [123456789] 使用了 ABC-30-Register_85D▓▓▓▓▓▓▓▓";
    const { codes, usedPartials } = extractCodes(text, PREFIX);
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["ABC-30-Register_85D"]);
  });

  it.each([
    ["black square", "使用了 ABC-30-Register_C⬛⬛⬛"],
    ["emoji", "使用了 ABC-30-Register_C🔒🔒🔒"],
    ["middle dots", "使用了 ABC-30-Register_C···"],
    ["ellipsis", "使用了 ABC-30-Register_C…"],
    ["fullwidth asterisk", "使用了 ABC-30-Register_C＊＊＊"],
    ["dingbat", "使用了 ABC-30-Register_C✳✳✳"],
  ])("treats a %s-masked code as used, not fresh", (_label, text) => {
    const { codes, usedPartials } = extractCodes(text, PREFIX);
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["ABC-30-Register_C"]);
  });

  it("ignores a bare prefix with no code after it", () => {
    const { codes } = extractCodes("ABC-30-Register_", PREFIX);
    expect(codes).toEqual([]);
  });

  it("finds a code mid-line and stops at whitespace", () => {
    const { codes } = extractCodes(
      "use ABC-30-Register_abc123 before it expires",
      PREFIX,
    );
    expect(codes).toEqual(["ABC-30-Register_abc123"]);
  });

  it("returns nothing when the prefix is empty or absent", () => {
    expect(extractCodes("any text", "").codes).toEqual([]);
    expect(extractCodes("no codes here", PREFIX).codes).toEqual([]);
  });

  it("wildcard prefix matches any duration", () => {
    const text = [
      "ABC-30-Register_abc123",
      "ABC-7-Register_def456",
      "ABC-365-Register_ghi789",
    ].join("\n");
    const { codes } = extractCodes(text, "ABC-*-Register_");
    expect(codes).toEqual([
      "ABC-30-Register_abc123",
      "ABC-7-Register_def456",
      "ABC-365-Register_ghi789",
    ]);
  });

  it("wildcard prefix still detects masked used-code announcements", () => {
    const { codes, usedPartials } = extractCodes(
      "使用了 ABC-7-Register_85D▓▓▓▓",
      "ABC-*-Register_",
    );
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["ABC-7-Register_85D"]);
  });

  it("wildcard prefix does not cross whitespace", () => {
    const { codes } = extractCodes(
      "ABC- broken Register_zzz and ABC-14-Register_ok1x",
      "ABC-*-Register_",
    );
    expect(codes).toEqual(["ABC-14-Register_ok1x"]);
  });

  it("regex special characters in the prefix are treated literally", () => {
    const { codes } = extractCodes(
      "CODE(A)+B_xyz789",
      "CODE(A)+B_",
    );
    expect(codes).toEqual(["CODE(A)+B_xyz789"]);
  });

  it("extracts a code embedded in a ?start= deep link", () => {
    const { codes } = extractCodes(
      "快抢 https://sfsffsf.xomsddf?start=ABC-7-Register_85Dxxxxx",
      "ABC-*-Register_",
    );
    expect(codes).toEqual(["ABC-7-Register_85Dxxxxx"]);
  });

  it("stops a URL-embedded code at the next query parameter", () => {
    const { codes } = extractCodes(
      "https://t.me/somebot?start=ABC-30-Register_abc123&lang=zh",
      "ABC-*-Register_",
    );
    expect(codes).toEqual(["ABC-30-Register_abc123"]);
  });
});

describe("containsAny", () => {
  it("matches a single keyword", () => {
    expect(containsAny("注册码已被使用", "已被使用")).toBe(true);
    expect(containsAny("注册成功", "已被使用")).toBe(false);
  });

  it("matches any of multiple |-separated keywords", () => {
    const keywords = "已被使用|错误";
    expect(containsAny("注册码已被使用", keywords)).toBe(true);
    expect(containsAny("你输入了一个错误de注册码", keywords)).toBe(true);
    expect(containsAny("注册成功", keywords)).toBe(false);
  });

  it("ignores blank keywords and surrounding whitespace", () => {
    expect(containsAny("some text", "| |")).toBe(false);
    expect(containsAny("bad code", " bad |")).toBe(true);
  });

  it("returns false when no keywords are configured", () => {
    expect(containsAny("anything", undefined)).toBe(false);
    expect(containsAny("anything", "")).toBe(false);
  });
});

describe("extractCodes with a regex", () => {
  it("takes capture group 1 so the surrounding wording stays out of the code", () => {
    const re = compileCodeRegex("兑换码[:：]\\s*([A-Za-z0-9_-]{6,})");
    const { codes } = extractCodes("今日兑换码：Xk3mhPuUZR 先到先得", "", re);
    expect(codes).toEqual(["Xk3mhPuUZR"]);
  });

  it("takes the whole match when the pattern has no capture group", () => {
    const re = compileCodeRegex("[A-Z]{3}-\\d{2}-[A-Za-z0-9]{8}");
    const { codes } = extractCodes("code XYZ-30-a1b2c3d4 enjoy", "", re);
    expect(codes).toEqual(["XYZ-30-a1b2c3d4"]);
  });

  it("finds every code in a multi-code post", () => {
    const re = compileCodeRegex("([A-Za-z0-9]{10})");
    const { codes } = extractCodes("aaaaaaaaaa\nbbbbbbbbbb", "", re);
    expect(codes).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
  });

  it("treats a masked match as a used-code announcement, not a fresh code", () => {
    const re = compileCodeRegex("([A-Za-z0-9]{6,})");
    const { codes, usedPartials } = extractCodes("Xk3mhP░░░ 已被使用", "", re);
    expect(codes).toEqual([]);
    expect(usedPartials).toEqual(["Xk3mhP"]);
  });

  it("accepts the /pattern/flags form and keeps the flags", () => {
    const re = compileCodeRegex("/code-([a-z0-9]+)/i");
    expect(re.flags).toContain("i");
    expect(re.flags).toContain("g");
    expect(extractCodes("CODE-Ab12", "", re).codes).toEqual(["Ab12"]);
  });

  it("wins over the prefix when both are configured", () => {
    const re = compileCodeRegex("(ZZZ-[0-9]+)");
    const { codes } = extractCodes("ABC-30-Register_xk3mhpuUZR ZZZ-77", PREFIX, re);
    expect(codes).toEqual(["ZZZ-77"]);
  });

  it("rejects a pattern that does not compile", () => {
    expect(() => compileCodeRegex("([A-Z")).toThrow();
  });
});

describe("sanitizeAiCode", () => {
  const captured = "ABC-30-Register_xk3mhpuUZR";

  it("takes the code the model replied with", () => {
    expect(sanitizeAiCode("ABC-30-Register_xk3mhpuUZ", captured)).toBe(
      "ABC-30-Register_xk3mhpuUZ",
    );
  });

  it("strips quoting and picks the first line", () => {
    expect(sanitizeAiCode('`ABC-1`\nthat is the code', captured)).toBe("ABC-1");
  });

  it("keeps the captured code when the model explained itself instead", () => {
    expect(sanitizeAiCode("The code should be ABC-1 after removing ~", captured)).toBe(captured);
    expect(sanitizeAiCode("", captured)).toBe(captured);
    expect(sanitizeAiCode("x".repeat(200), captured)).toBe(captured);
  });
});

describe("buildCodeFixPrompt", () => {
  it("puts the code, its message, the nearby chat and the bot prompt in front of the model", () => {
    const prompt = buildCodeFixPrompt(
      "ABC-1~2",
      {
        message: "code: ABC-1~2",
        nearby: ["删除符号“~”", "先到先得"],
        botPrompt: "对我发送注册码",
      },
      "this group deletes the ~",
    );
    expect(prompt).toContain("Code as captured: ABC-1~2");
    expect(prompt).toContain("删除符号“~”");
    expect(prompt).toContain("对我发送注册码");
    expect(prompt).toContain("this group deletes the ~");
    expect(prompt).toMatch(/ONLY the exact code/);
  });

  it("leaves out sections there is nothing to say about", () => {
    const prompt = buildCodeFixPrompt("ABC-1", { nearby: [] });
    expect(prompt).not.toContain("Operator note");
    expect(prompt).not.toContain("bot's last prompt");
  });
});

describe("beginTextWait", () => {
  function fakeClient() {
    const handlers: Array<(e: any) => void> = [];
    return {
      handlers,
      addEventHandler: (h: (e: any) => void) => handlers.push(h),
      removeEventHandler: () => {},
    } as any;
  }
  const say = (text: string) => ({ message: { message: text } });

  it("resolves once the bot says it is ready", async () => {
    const client = fakeClient();
    const wait = beginTextWait(client, "123", "对我发送注册", 5_000);
    client.handlers[0](say("请对我发送注册码"));
    await expect(wait.result).resolves.toBe(true);
  });

  it("counts an edit of an existing message, not just a new one", async () => {
    const client = fakeClient();
    const wait = beginTextWait(client, "123", "ready", 5_000);
    // The second handler is the EditedMessage one
    client.handlers[1](say("now ready for your code"));
    await expect(wait.result).resolves.toBe(true);
  });

  it("needs no wait when a message already in hand carries the wording", async () => {
    const client = fakeClient();
    const wait = beginTextWait(client, "123", "对我发送注册", 5_000, undefined, [
      { message: "对我发送注册码" } as any,
    ]);
    await expect(wait.result).resolves.toBe(true);
  });

  it("gives up rather than blocking the run when the bot stays quiet", async () => {
    const wait = beginTextWait(fakeClient(), "123", "ready", 10);
    await expect(wait.result).resolves.toBe(false);
  });

  it("ignores messages that say something else", async () => {
    const client = fakeClient();
    const wait = beginTextWait(client, "123", "ready", 20);
    client.handlers[0](say("hold on"));
    await expect(wait.result).resolves.toBe(false);
  });

  it("settles false when cancelled, so a rejected code drops its wait", async () => {
    const wait = beginTextWait(fakeClient(), "123", "ready", 5_000);
    wait.cancel();
    await expect(wait.result).resolves.toBe(false);
  });
});

describe("applyCodeEdits", () => {
  it("strips Chinese characters, punctuation and full-width forms", () => {
    expect(applyCodeEdits("注册码ABC-1（有效）", { stripChinese: true })).toBe("ABC-1");
    expect(applyCodeEdits("ABC－1", { stripChinese: true })).toBe("ABC1");
    expect(applyCodeEdits("码abc、def。", { stripChinese: true })).toBe("abcdef");
  });

  it("leaves a code that is already plain alone", () => {
    expect(applyCodeEdits("ABC-30-Register_xk3", { stripChinese: true })).toBe(
      "ABC-30-Register_xk3",
    );
  });

  it("strips each listed character wherever it appears", () => {
    expect(applyCodeEdits("A~B~C*1", { stripChars: "~*" })).toBe("ABC1");
    expect(applyCodeEdits("A·B·C", { stripChars: "·" })).toBe("ABC");
  });

  it("ignores whitespace in the character list, so `~ *` reads as two characters", () => {
    expect(applyCodeEdits("A~B*C", { stripChars: " ~ * " })).toBe("ABC");
  });

  it("applies both fixes together", () => {
    expect(
      applyCodeEdits("注册码：A~B~C", { stripChinese: true, stripChars: "~" }),
    ).toBe("ABC");
  });

  it("changes nothing when neither fix is configured", () => {
    expect(applyCodeEdits("注册码A~B", {})).toBe("注册码A~B");
    expect(applyCodeEdits("A~B", { stripChars: "" })).toBe("A~B");
  });
});

// ---------------------------------------------------------------------------
// findAfterCodeTarget -- the button or link a bot offers once a code is vetted
// ---------------------------------------------------------------------------

/** A message carrying the given inline buttons, laid out one per row. */
function withButtons(buttons: Api.TypeKeyboardButton[], text = ""): Api.Message {
  return {
    id: 1,
    message: text,
    entities: [],
    replyMarkup: new Api.ReplyInlineMarkup({
      rows: buttons.map((b) => new Api.KeyboardButtonRow({ buttons: [b] })),
    }),
  } as unknown as Api.Message;
}

const callbackBtn = (text: string) =>
  new Api.KeyboardButtonCallback({ text, data: Buffer.from(text) });
const urlBtn = (text: string, url: string) => new Api.KeyboardButtonUrl({ text, url });

describe("findAfterCodeTarget", () => {
  it("finds the callback button whose label carries the search text", () => {
    const msg = withButtons([callbackBtn("查看帮助"), callbackBtn("开始注册")]);
    const target = findAfterCodeTarget(msg, "开始注册");
    expect(target).toMatchObject({ kind: "callback", text: "开始注册" });
  });

  it("takes the first clickable button when no search text is given", () => {
    const msg = withButtons([callbackBtn("开始注册"), callbackBtn("取消")]);
    expect(findAfterCodeTarget(msg, "")).toMatchObject({ text: "开始注册" });
  });

  it("prefers a callback button over a link, whatever their order", () => {
    const msg = withButtons([
      urlBtn("注册", "https://t.me/mybot?start=abc"),
      callbackBtn("注册"),
    ]);
    expect(findAfterCodeTarget(msg, "注册")).toMatchObject({ kind: "callback" });
  });

  it("reads a ?start= link button as the payload to send", () => {
    const msg = withButtons([urlBtn("开始注册", "https://t.me/mybot?start=REG_9f2")]);
    expect(findAfterCodeTarget(msg, "")).toMatchObject({
      kind: "startLink",
      botUsername: "mybot",
      startParam: "REG_9f2",
    });
  });

  it("reports a plain web link as a url, which the caller cannot click", () => {
    const msg = withButtons([urlBtn("前往注册", "https://example.com/signup?t=1")]);
    expect(findAfterCodeTarget(msg, "")).toMatchObject({
      kind: "url",
      url: "https://example.com/signup?t=1",
    });
  });

  it("follows a ?start= link written into the message text", () => {
    const body = "验证通过，请点击 开始注册 完成";
    const msg = {
      id: 2,
      message: body,
      entities: [
        new Api.MessageEntityTextUrl({
          offset: body.indexOf("开始注册"),
          length: 4,
          url: "https://t.me/mybot?start=xyz",
        }),
      ],
    } as unknown as Api.Message;
    expect(findAfterCodeTarget(msg, "")).toMatchObject({
      kind: "startLink",
      text: "开始注册",
      startParam: "xyz",
    });
  });

  it("finds a bare t.me start URL sitting in the text", () => {
    const body = "https://t.me/mybot?start=plain";
    const msg = {
      id: 3,
      message: body,
      entities: [new Api.MessageEntityUrl({ offset: 0, length: body.length })],
    } as unknown as Api.Message;
    expect(findAfterCodeTarget(msg, "")).toMatchObject({
      kind: "startLink",
      startParam: "plain",
    });
  });

  it("finds nothing when no label matches the search text", () => {
    const msg = withButtons([callbackBtn("取消")]);
    expect(findAfterCodeTarget(msg, "开始注册")).toBeNull();
  });

  it("finds nothing on a plain message with no buttons or links", () => {
    const msg = { id: 4, message: "注册码有效", entities: [] } as unknown as Api.Message;
    expect(findAfterCodeTarget(msg, "")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// beginAfterCodeWait
// ---------------------------------------------------------------------------

describe("beginAfterCodeWait", () => {
  function fakeClient() {
    const handlers: Array<(e: any) => void> = [];
    return {
      handlers,
      addEventHandler: (h: (e: any) => void) => handlers.push(h),
      removeEventHandler: () => {},
    } as any;
  }

  it("resolves with the button once the bot offers it", async () => {
    const client = fakeClient();
    const wait = beginAfterCodeWait(client, "123", "开始注册", 5_000);
    client.handlers[0]({ message: withButtons([callbackBtn("开始注册")]) });
    await expect(wait.result).resolves.toMatchObject({ text: "开始注册" });
  });

  it("counts an edit that adds the button to an existing message", async () => {
    const client = fakeClient();
    const wait = beginAfterCodeWait(client, "123", "", 5_000);
    // The second handler is the EditedMessage one
    client.handlers[1]({ message: withButtons([callbackBtn("Register")]) });
    await expect(wait.result).resolves.toMatchObject({ text: "Register" });
  });

  it("needs no wait when the offer is already in a message in hand", async () => {
    const client = fakeClient();
    const wait = beginAfterCodeWait(client, "123", "", 5_000, undefined, [
      withButtons([callbackBtn("Register")]),
    ]);
    await expect(wait.result).resolves.toMatchObject({ text: "Register" });
  });

  it("resolves null rather than blocking when the bot offers nothing", async () => {
    const wait = beginAfterCodeWait(fakeClient(), "123", "开始注册", 10);
    await expect(wait.result).resolves.toBeNull();
  });

  it("ignores a reply whose buttons do not match the search text", async () => {
    const client = fakeClient();
    const wait = beginAfterCodeWait(client, "123", "开始注册", 20);
    client.handlers[0]({ message: withButtons([callbackBtn("取消")]) });
    await expect(wait.result).resolves.toBeNull();
  });

  it("settles null when cancelled, so a rejected code drops its wait", async () => {
    const wait = beginAfterCodeWait(fakeClient(), "123", "", 5_000);
    wait.cancel();
    await expect(wait.result).resolves.toBeNull();
  });
});
