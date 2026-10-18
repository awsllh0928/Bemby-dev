// Page steps that reach into the browser, driven against a real one.
//
// These cover a failure that no amount of unit testing catches: anything defined as a named
// function inside a `page.evaluate` body is rewritten by tsx (the dev server's loader) into
// a call to a `__name` helper that exists only on this side, so the body throws on its first
// line. Both callers below swallow that -- a scroll reports "nothing scrolls", a click asks
// the model to judge a screenshot with no grid on it -- which reads as a page that behaved
// oddly rather than as a broken step. Only running the real thing tells them apart.
// The settings row the stub hands back is the tuning one: the pauses a step leaves for a
// real page to settle are dead time against a local one, and they dominate the run.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({ value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0 }) }),
      run: () => {},
      all: () => [],
    }),
  },
}));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { chromiumExecutable } from "../jobs/cfBrowser";
import { runWebSteps } from "../jobs/cloudflare";

// The keyed build quits without a licence seat, so these drive the unlicensed one
const exe = chromiumExecutable("free");

const page = (html: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0">${html}</body>`)}`;

describe.skipIf(!exe)("page steps in a real browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (html: string, size = { width: 800, height: 600 }): Promise<Page> => {
    const p = await browser.newPage({ viewport: size });
    await p.goto(page(html), { waitUntil: "domcontentloaded" });
    return p;
  };

  it(
    "scrolls the page, rather than reporting that nothing scrolls",
    async () => {
      const p = await open(`<div style="height:3000px">tall</div>`);
      const run = await runWebSteps(p, [{ type: "web_scroll", y: 500 }], Date.now() + 30_000, {});
      expect(run.logs[0].error).toBeUndefined();
      expect(run.logs[0].outcome).toContain("500");
      expect(await p.evaluate(() => window.scrollY)).toBe(500);
      await p.close();
    },
    60_000,
  );

  it(
    "corrects the wide guess against the close-up, and clicks what it settled on",
    async () => {
      // A 22px box centred at 355,457 -- the size and place of a Turnstile checkbox
      const p = await open(
        `<input id="cb" type="checkbox" style="position:absolute;left:344px;top:446px;width:22px;height:22px;margin:0">` +
          `<span style="position:absolute;left:385px;top:450px">Verify you are human</span>`,
        { width: 945, height: 939 },
      );
      const truth = await p.evaluate(() => {
        const r = document.getElementById("cb")!.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });

      const shots: string[] = [];
      let pass = 0;
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy", hint: "the verify you are human checkbox" }],
        Date.now() + 30_000,
        {
          aiLocate: async (image, prompt) => {
            shots.push(image);
            pass++;
            // The wide pass answers off-target, the way the live model did; the close-up
            // is the one that has to be believed
            return pass === 1
              ? '{"x": 360, "y": 485}'
              : `{"x": ${truth.x}, "y": ${truth.y}}`;
          },
        },
      );

      expect(run.logs[0].error).toBeUndefined();
      expect(pass).toBe(2);
      // The close-up is a window on the page, so it must be the smaller picture of the two
      expect(shots[1].length).toBeLessThan(shots[0].length);
      expect(run.logs[0].outcome).toContain(`AI clicked ${truth.x},${truth.y}`);
      expect(run.logs[0].outcome).toContain("close-up moved it");
      expect(await p.evaluate(() => (document.getElementById("cb") as HTMLInputElement).checked))
        .toBe(true);
      // The ring drawn over the click is left for this step's screenshot and then taken off
      expect(run.logs[0].screenshot).toBeTruthy();
      expect(await p.evaluate(() => document.querySelectorAll(".__bemby_mark").length)).toBe(0);
      await p.close();
    },
    60_000,
  );

  it(
    "keeps the wide guess when the close-up cannot see the target, rather than reading null as 0,0",
    async () => {
      const p = await open(`<button id="b" style="position:absolute;left:300px;top:200px">go</button>`);
      const replies: string[] = ['{"x": 360, "y": 485}', '{"x": null, "y": null, "what": "not in view"}'];
      let pass = 0;
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy", hint: "the go button" }],
        Date.now() + 30_000,
        { aiLocate: async () => replies[pass++] },
      );
      expect(run.logs[0].error).toBeUndefined();
      expect(run.logs[0].outcome).toContain("AI clicked 360,485");
      expect(run.logs[0].outcome).toContain("could not see it");
      await p.close();
    },
    60_000,
  );

  it(
    "does not tell the close-up what the wide pass answered, which is what made it echo",
    async () => {
      const p = await open(`<button id="b" style="position:absolute;left:300px;top:200px">go</button>`);
      const prompts: string[] = [];
      let pass = 0;
      await runWebSteps(p, [{ type: "ai_web_click_xy" }], Date.now() + 30_000, {
        aiLocate: async (_image, prompt) => {
          prompts.push(prompt);
          return pass++ === 0 ? '{"x": 360, "y": 485}' : '{"x": 312, "y": 210}';
        },
      });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).not.toContain("360");
      expect(prompts[1]).not.toContain("485");
      await p.close();
    },
    60_000,
  );

  it(
    "says so when asked for a Turnstile checkbox on a page that has none",
    async () => {
      const p = await open(`<div>no widget here</div>`);
      const run = await runWebSteps(p, [{ type: "web_turnstile" }], Date.now() + 30_000, {});
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toContain("no Turnstile widget");
      await p.close();
    },
    60_000,
  );

  it(
    "fails the step when the ruler cannot be drawn, instead of asking for a blind guess",
    async () => {
      const p = await open(`<div>plain</div>`);
      // A page with no body is the one case that leaves nothing to draw the grid into
      await p.evaluate(() => document.body.remove());
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy", hint: "anything" }],
        Date.now() + 30_000,
        { aiLocate: async () => '{"x": 10, "y": 10}' },
      );
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toMatch(/grid/i);
      await p.close();
    },
    60_000,
  );
});
