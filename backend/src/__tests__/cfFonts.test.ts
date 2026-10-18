// The CJK/emoji faces are no longer in the image; they are downloaded into the data dir.
// That makes "are the fonts installed" a filesystem question, and it has to treat a
// half-finished download as missing rather than reporting a browser that cannot draw CJK.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  truncateSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let dir: string;
let cf: typeof import("../jobs/cloudflare");

function fontsDir(): string {
  return path.join(dir, "cf-fonts", "fonts");
}

/** Sparse file of an exact size, so a 19MB face costs nothing to fake. */
function fakeFont(file: string, bytes: number): string {
  const p = path.join(fontsDir(), file);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "");
  truncateSync(p, bytes);
  return p;
}

/** Every face at its expected size, i.e. a completed install. */
function fakeAllFonts(): void {
  for (const f of cf.CF_FONTS) fakeFont(f.file, f.bytes);
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "bemby-cf-fonts-"));
  process.env.DB_PATH = path.join(dir, "bemby.db");
  cf = await import("../jobs/cloudflare");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.FONTCONFIG_FILE;
  vi.unstubAllGlobals();
});

describe("cf font install state", () => {
  it("reports nothing installed when the data dir is empty", () => {
    expect(cf.areCfFontsInstalled()).toBe(false);
    expect(cf.cfFontsStatus().installed).toEqual([]);
    expect(cf.cfFontsStatus().missing).toEqual(cf.CF_FONTS.map((f) => f.label));
  });

  it("counts a face only at its exact expected size", () => {
    fakeAllFonts();
    expect(cf.areCfFontsInstalled()).toBe(true);
    expect(cf.cfFontsStatus().missing).toEqual([]);
  });

  // The guard that matters: a download cut off partway leaves a real file at the real
  // name, and treating it as installed would silently ship a browser missing glyphs.
  it("treats a truncated face as missing, not installed", () => {
    fakeAllFonts();
    const first = cf.CF_FONTS[0];
    fakeFont(first.file, first.bytes - 1);
    expect(cf.areCfFontsInstalled()).toBe(false);
    expect(cf.cfFontsStatus().missing).toEqual([first.label]);
    expect(cf.cfFontsStatus().installed).not.toContain(first.label);
  });

  it("reports a partial install per face", () => {
    const [cjk, emoji] = cf.CF_FONTS;
    fakeFont(emoji.file, emoji.bytes);
    expect(cf.areCfFontsInstalled()).toBe(false);
    expect(cf.cfFontsStatus().installed).toEqual([emoji.label]);
    expect(cf.cfFontsStatus().missing).toEqual([cjk.label]);
  });
});

describe("installCfFonts", () => {
  it("skips faces already on disk", async () => {
    fakeAllFonts();
    // Any download attempt would be a bug: the faces are already there.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("should not download"); }));
    const res = await cf.installCfFonts();
    expect(res.ok).toBe(true);
    expect(res.output).toContain("already installed");
  });

  // A substituted or truncated download must not land in the volume, because the size
  // check alone would accept it on the next start.
  it("rejects a body that fails the digest check and leaves nothing behind", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      }),
    })));
    const res = await cf.installCfFonts();
    expect(res.ok).toBe(false);
    expect(res.output).toContain("digest mismatch");
    expect(cf.areCfFontsInstalled()).toBe(false);
    // Neither the final name nor the `.part` scratch file survives a failure.
    expect(readdirSync(fontsDir())).toEqual([]);
  });

  it("writes a fontconfig file that includes the image config and our font dir", async () => {
    fakeAllFonts();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("should not download"); }));
    await cf.installCfFonts();
    const conf = path.join(dir, "cf-fonts", "fonts.conf");
    expect(existsSync(conf)).toBe(true);
    const body = readFileSync(conf, "utf8");
    // Included, not replaced: the image's Latin fallback and alias rules must stay visible.
    expect(body).toContain("<include ignore_missing=\"yes\">/etc/fonts/fonts.conf</include>");
    expect(body).toContain(`<dir>${fontsDir()}</dir>`);
    // Cache on the volume, and ahead of the image's dirs so it is the one written to.
    expect(body.indexOf("<cachedir>")).toBeLessThan(body.indexOf("<include"));
    expect(body).toContain(`<cachedir>${path.join(dir, "cf-fonts", "cache")}</cachedir>`);
  });
});
