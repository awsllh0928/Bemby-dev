// A Turnstile token is only proof of anything when the site asked for it. Cloudflare's own
// interstitial fills the same field in and still refuses the address, which is how a
// blocked site came to be logged as solved -- and its page steps then spent their whole
// timeout waiting for a login form that was never going to render.
import { describe, it, expect } from "vitest";
import { turnstilePassed, verifyPortalChoice } from "../jobs/cloudflare";

describe("turnstilePassed", () => {
  it("accepts a token from a widget on the site's own page", () => {
    expect(turnstilePassed("0.abc123", false)).toBe(true);
  });

  it("rejects a token issued by a full-page interstitial", () => {
    expect(turnstilePassed("0.abc123", true)).toBe(false);
  });

  it("is not satisfied by an empty token either way", () => {
    expect(turnstilePassed("", false)).toBe(false);
    expect(turnstilePassed("", true)).toBe(false);
  });
});

// The other half of the same mistake: a verify portal's button and a site's own form
// button read alike, and pressing the site's one submits the form. A login page with
// "发送验证码" on it was pressed with an empty field, and the site answered "邮箱不正确".
describe("verifyPortalChoice", () => {
  it("presses the verify button on a bare portal", () => {
    expect(verifyPortalChoice(["Verify you are human"])).toBe(0);
    expect(verifyPortalChoice(["Cancel", "开始验证"])).toBe(1);
  });

  it("presses the only button on a portal that does not name it", () => {
    expect(verifyPortalChoice(["Go"])).toBe(0);
  });

  it("presses nothing on a page with a whole site around the widget", () => {
    const nodeseek = ["日常", "技术", "情报", "测评", "交易", "发送验证码", "登录", "注册"];
    expect(verifyPortalChoice(nodeseek)).toBeNull();
  });

  it("presses nothing when a small page names no verify control", () => {
    expect(verifyPortalChoice(["Home", "About"])).toBeNull();
  });

  it("presses nothing on an empty page", () => {
    expect(verifyPortalChoice([])).toBeNull();
  });
});
