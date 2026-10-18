// The stealth browser is downloaded into the data dir, so which build gets launched is a
// filesystem question: newest version wins, and the settings page has to be able to answer
// "is it installed" without an async call into the library.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let dir: string;
let cf: typeof import("../jobs/cloudflare");

/** The name the solver looks for inside an unpacked build, per platform. */
const CHROME_EXE =
  process.platform === "win32"
    ? "chrome.exe"
    : process.platform === "darwin"
      ? path.join("Chromium.app", "Contents", "MacOS", "Chromium")
      : "chrome";

/** Lays down a CloakBrowser cache entry and returns the executable path. */
function fakeDownload(version: string, pro = false): string {
  const exe = path.join(dir, "cloakbrowser", `chromium-${version}${pro ? "-pro" : ""}`, CHROME_EXE);
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  return exe;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "bemby-chromium-"));
  process.env.DB_PATH = path.join(dir, "bemby.db");
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  delete process.env.CLOAKBROWSER_CACHE_DIR;
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
  cf = await import("../jobs/cloudflare");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
});

describe("chromiumExecutable", () => {
  it("reports nothing installed when the data dir is empty", () => {
    expect(cf.chromiumExecutable()).toBeUndefined();
    expect(cf.isChromiumInstalled()).toBe(false);
  });

  it("finds a downloaded browser under the data dir", () => {
    const exe = fakeDownload("146.0.7680.177.5");
    expect(cf.chromiumExecutable()).toBe(exe);
    expect(cf.isChromiumInstalled()).toBe(true);
  });

  it("launches the newest build after an update, not the one left behind", () => {
    fakeDownload("146.0.7680.177.5");
    const newer = fakeDownload("150.0.7900.10.1");
    expect(cf.chromiumExecutable()).toBe(newer);
  });

  it("compares versions numerically, not as text", () => {
    fakeDownload("146.0.7680.98.1");
    const newer = fakeDownload("146.0.7680.177.5");
    expect(cf.chromiumExecutable()).toBe(newer);
  });

  it("resolves a Pro build the same way as a free one", () => {
    fakeDownload("146.0.7680.177.5");
    const pro = fakeDownload("150.0.7900.10.1", true);
    expect(cf.chromiumExecutable()).toBe(pro);
  });

  // A directory with no executable in it is what a download that died halfway leaves
  // behind; offering it would report a browser that cannot launch.
  it("ignores a cache entry with no executable in it", () => {
    mkdirSync(path.join(dir, "cloakbrowser", "chromium-150.0.7900.10.1"), { recursive: true });
    const exe = fakeDownload("146.0.7680.177.5");
    expect(cf.chromiumExecutable()).toBe(exe);
  });

  it("lets an explicit executable path win over everything", () => {
    fakeDownload("146.0.7680.177.5");
    const pinned = path.join(dir, "my-chrome");
    writeFileSync(pinned, "");
    process.env.CLOAKBROWSER_BINARY_PATH = pinned;
    expect(cf.chromiumExecutable()).toBe(pinned);
  });

  // The previous solver launched whatever this named, and installs set up then still carry
  // it. A stock Chromium has none of the fingerprint patches, so a job pointed at one is
  // not solving anything -- it only looks like it is.
  it("ignores the previous solver's PUPPETEER_EXECUTABLE_PATH pin", () => {
    const stale = path.join(dir, "old-playwright-chrome");
    writeFileSync(stale, "");
    process.env.PUPPETEER_EXECUTABLE_PATH = stale;
    const build = fakeDownload("150.0.7900.10.1");
    expect(cf.chromiumExecutable()).toBe(build);
  });

  it("reports nothing installed when only the previous solver's browser is pinned", () => {
    const stale = path.join(dir, "old-playwright-chrome");
    writeFileSync(stale, "");
    process.env.PUPPETEER_EXECUTABLE_PATH = stale;
    expect(cf.chromiumExecutable()).toBeUndefined();
    expect(cf.isChromiumInstalled()).toBe(false);
  });

  // A launch with a key in hand must not land on the free build and vice versa: the keyed
  // build declines to run without one.
  it("picks the build matching the tier asked for", () => {
    const free = fakeDownload("146.0.7680.177.5");
    const keyed = fakeDownload("150.0.7900.10.1", true);
    expect(cf.chromiumExecutable("keyed")).toBe(keyed);
    expect(cf.chromiumExecutable("free")).toBe(free);
  });

  it("falls back to whatever is installed when the tier asked for is not", () => {
    const free = fakeDownload("146.0.7680.177.5");
    expect(cf.chromiumExecutable("keyed")).toBe(free);
  });

  // The reverse substitution is not safe, and used to happen: a launch with no seat asked
  // for the free build, was handed the keyed one, and it quit during startup for want of a
  // licence -- reported as a browser that closed itself, with a page of Chromium log.
  it("never serves the keyed build to a launch that has no key", () => {
    fakeDownload("150.0.7900.10.1", true);
    expect(cf.chromiumExecutable("free")).toBeUndefined();
    expect(cf.installedBuildTier()).toBe("keyed");
  });
});

// A key is only worth something once the build behind it is on disk, and downloading is
// deliberate here rather than automatic -- so this is what puts the download in front of
// the operator after they add one.
describe("keyedBuildPending", () => {
  it("is false with no key configured", async () => {
    fakeDownload("146.0.7680.177.5");
    expect(await cf.keyedBuildPending()).toBe(false);
  });

  it("is true once a key is stored but its build is not downloaded", async () => {
    fakeDownload("146.0.7680.177.5");
    process.env.CLOAKBROWSER_LICENSE_KEY = "cb_aaaaaaaaaaaa";
    expect(await cf.keyedBuildPending()).toBe(true);
  });

  it("clears once the keyed build is downloaded", async () => {
    fakeDownload("146.0.7680.177.5");
    fakeDownload("150.0.7900.10.1", true);
    process.env.CLOAKBROWSER_LICENSE_KEY = "cb_aaaaaaaaaaaa";
    expect(await cf.keyedBuildPending()).toBe(false);
  });

  // An operator pointing at their own binary has taken the choice of build out of our
  // hands entirely, so there is nothing to offer them.
  it("stays quiet when an explicit CloakBrowser binary is pinned", async () => {
    const pinned = path.join(dir, "my-cloakbrowser");
    writeFileSync(pinned, "");
    process.env.CLOAKBROWSER_BINARY_PATH = pinned;
    process.env.CLOAKBROWSER_LICENSE_KEY = "cb_aaaaaaaaaaaa";
    expect(await cf.keyedBuildPending()).toBe(false);
  });

  // The stale pin is ignored, so it must not silence the prompt either
  it("still prompts when the previous solver's browser is pinned", async () => {
    const stale = path.join(dir, "old-playwright-chrome");
    writeFileSync(stale, "");
    process.env.PUPPETEER_EXECUTABLE_PATH = stale;
    fakeDownload("150.0.7900.10.1");
    process.env.CLOAKBROWSER_LICENSE_KEY = "cb_aaaaaaaaaaaa";
    expect(await cf.keyedBuildPending()).toBe(true);
  });
});

describe("installedBuildTier", () => {
  it("reports which build is on disk", () => {
    fakeDownload("146.0.7680.177.5");
    expect(cf.installedBuildTier()).toBe("free");
    fakeDownload("150.0.7900.10.1", true);
    expect(cf.installedBuildTier()).toBe("keyed");
  });

  it("reports nothing when the data dir is empty", () => {
    expect(cf.installedBuildTier()).toBeUndefined();
  });
});
