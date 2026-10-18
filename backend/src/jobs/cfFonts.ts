import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { dataDir } from "./paths";

// Only a Latin fallback ships in the image. The CJK and emoji faces are downloaded into
// the data dir when Cloudflare solving is set up, which keeps ~140MB of Noto packages out
// of every image and, because the data dir is a volume, keeps them across an upgrade.
//
// Pinned by tag/commit and checked by digest: these are binaries fetched at run time, so a
// truncated or substituted file has to fail loudly rather than land in the volume.

type CfFont = {
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Named in the install output, so a slow download says what it is fetching. */
  label: string;
};

export const CF_FONTS: CfFont[] = [
  {
    file: "NotoSansCJK-Regular.ttc",
    url: "https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTC/NotoSansCJK-Regular.ttc",
    bytes: 19_484_784,
    sha256: "b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a",
    label: "Noto Sans CJK",
  },
  {
    file: "NotoColorEmoji.ttf",
    url: "https://raw.githubusercontent.com/googlefonts/noto-emoji/f3ae03f5e9b3b8516fa151f7168159ca1a3e7515/fonts/NotoColorEmoji.ttf",
    bytes: 10_673_480,
    sha256: "72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b",
    label: "Noto Color Emoji",
  },
];

/** Data-dir subfolder holding the on-demand font install. */
export function cfFontsRoot(): string {
  return path.join(dataDir(), "cf-fonts");
}

function cfFontsDir(): string {
  return path.join(cfFontsRoot(), "fonts");
}

function cfFontConfigFile(): string {
  return path.join(cfFontsRoot(), "fonts.conf");
}

/** Installed only at the exact expected size, so a part-written file never counts. */
function cfFontPresent(f: CfFont): boolean {
  try {
    return statSync(path.join(cfFontsDir(), f.file)).size === f.bytes;
  } catch {
    return false;
  }
}

export function areCfFontsInstalled(): boolean {
  return CF_FONTS.every(cfFontPresent);
}

/** Which faces are in the data dir and which are still missing, for the settings view. */
export function cfFontsStatus(): { installed: string[]; missing: string[] } {
  return {
    installed: CF_FONTS.filter(cfFontPresent).map((f) => f.label),
    missing: CF_FONTS.filter((f) => !cfFontPresent(f)).map((f) => f.label),
  };
}

/**
 * Adds the data-dir fonts to the image's own fontconfig setup.
 *
 * The image config is included rather than replaced, so Debian's generic-family aliases and
 * hinting rules still apply and the Latin fallback in /usr/share/fonts stays visible. Our
 * cachedir is listed first because fontconfig writes to the first one it can write to:
 * that puts the cache on the volume, so it is built once instead of on every start.
 */
function ensureCfFontConfig(): string {
  const body = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<!-- Written by Bemby: the Cloudflare solver's fonts live in the data dir, not the image. -->
<fontconfig>
  <cachedir>${path.join(cfFontsRoot(), "cache")}</cachedir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${cfFontsDir()}</dir>
</fontconfig>
`;
  mkdirSync(cfFontsDir(), { recursive: true });
  mkdirSync(path.join(cfFontsRoot(), "cache"), { recursive: true });
  const conf = cfFontConfigFile();
  if (!existsSync(conf) || readFileSync(conf, "utf8") !== body) {
    writeFileSync(conf, body);
  }
  return conf;
}

/**
 * Points fontconfig at the data-dir fonts. Applied at launch rather than at install, so
 * fonts fetched by an earlier version are picked up without reinstalling anything.
 */
let warnedMissingFonts = false;
export function applyCfFontEnv(): void {
  if (!areCfFontsInstalled()) {
    // Once per process: this runs per browser launch, so a job would otherwise repeat it.
    if (!warnedMissingFonts) {
      warnedMissingFonts = true;
      console.warn(
        `[cfFonts] CJK/emoji fonts are missing from ${cfFontsDir()}; the browser has only ` +
          "the Latin fallback. Re-run the Cloudflare solver install in Settings to fetch them.",
      );
    }
    return;
  }
  warnedMissingFonts = false;
  try {
    process.env.FONTCONFIG_FILE = ensureCfFontConfig();
  } catch (err: any) {
    console.warn(`[cfFonts] could not point fontconfig at ${cfFontsDir()}: ${err?.message ?? err}`);
  }
}

/** Streams one face to a `.part` file, hashing as it goes, and only names it on a match. */
async function downloadCfFont(f: CfFont): Promise<void> {
  const dest = path.join(cfFontsDir(), f.file);
  const part = `${dest}.part`;
  const res = await fetch(f.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(res.body as any),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(part),
  );
  const digest = hash.digest("hex");
  if (digest !== f.sha256) {
    rmSync(part, { force: true });
    throw new Error(`digest mismatch (expected ${f.sha256.slice(0, 12)}, got ${digest.slice(0, 12)})`);
  }
  renameSync(part, dest);
}

/**
 * Downloads the faces the image no longer carries (~30MB) into the data dir.
 *
 * Deliberately not fatal to setting up the solver: with the image's Latin fallback the
 * browser still runs, it just cannot draw CJK or emoji, so a blocked download degrades the
 * challenge pass rate rather than leaving nothing installed at all.
 */
export async function installCfFonts(force = false): Promise<{ ok: boolean; output: string }> {
  const lines: string[] = [];
  try {
    ensureCfFontConfig();
  } catch (err: any) {
    return { ok: false, output: `Cannot write to ${cfFontsRoot()}: ${err?.message ?? err}` };
  }
  for (const f of CF_FONTS) {
    if (!force && cfFontPresent(f)) {
      lines.push(`${f.label}: already installed`);
      continue;
    }
    try {
      await downloadCfFont(f);
      lines.push(`${f.label}: installed (${Math.round(f.bytes / 1_048_576)}MB)`);
    } catch (err: any) {
      lines.push(`${f.label}: FAILED, ${err?.message ?? err}`);
    }
  }
  const ok = areCfFontsInstalled();
  if (ok) lines.push(buildCfFontCache());
  return { ok, output: lines.join("\n") };
}

/**
 * Builds the fontconfig cache up front so the first launch does not pay for it. Best
 * effort: without fc-cache on the path the browser builds the cache itself.
 */
function buildCfFontCache(): string {
  try {
    const out = spawnSync("fc-cache", ["-f", cfFontsDir()], {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, FONTCONFIG_FILE: cfFontConfigFile() },
    });
    if (out.error) return "fc-cache not available; the browser will build the cache itself";
    const tail = `${out.stdout ?? ""}${out.stderr ?? ""}`.trim().split("\n").pop();
    return `fc-cache: ${tail || "done"}`;
  } catch {
    return "fc-cache skipped";
  }
}
