import { getSetting, setSetting } from "../db/repos/settings";

// CloakBrowser licence keys. The binary that ships without a key is the old free build,
// which ages as detection moves on; a key -- free, one per GitHub sign-in -- gets the
// current build instead. A free key allows one concurrent session, so several of them are
// kept here and one is leased per running browser: with two keys two jobs can solve at
// once, which is what Bemby's scheduler runs.
//
// Keys are stored in the settings table and never sent back to the client in full.

export const CF_KEYS_SETTING = "cf_cloak_keys";

export type CfLicenseKey = {
  /** Free-text label, e.g. which account the key came from. */
  label: string;
  key: string;
};

/** What the client is allowed to see: the label, and enough of the key to recognise it. */
export type CfLicenseKeyView = {
  label: string;
  /** First and last few characters, e.g. "cb_1a2b****9z8y". */
  masked: string;
};

export function maskKey(key: string): string {
  if (key.length <= 10) return "****";
  return `${key.slice(0, 7)}****${key.slice(-4)}`;
}

async function readKeys(): Promise<CfLicenseKey[]> {
  try {
    const parsed = JSON.parse((await getSetting(CF_KEYS_SETTING)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry: any) => ({ label: String(entry?.label ?? ""), key: String(entry?.key ?? "").trim() }))
      .filter((entry) => entry.key);
  } catch {
    return [];
  }
}

export async function cfLicenseKeys(): Promise<CfLicenseKey[]> {
  return readKeys();
}

export async function cfLicenseKeysForClient(): Promise<CfLicenseKeyView[]> {
  return (await readKeys()).map((entry) => ({ label: entry.label, masked: maskKey(entry.key) }));
}

/**
 * Replaces the stored keys. An entry whose key is the masked form the client was given
 * keeps whatever is stored under that label, so editing a label does not require the
 * operator to paste every key again.
 */
export async function saveCfLicenseKeys(
  incoming: Array<{ label?: string; key?: string }>,
): Promise<CfLicenseKey[]> {
  const existing = await readKeys();
  const kept: CfLicenseKey[] = [];
  const seen = new Set<string>();

  for (const entry of incoming) {
    const label = String(entry?.label ?? "").trim();
    const raw = String(entry?.key ?? "").trim();
    const key = raw.includes("****") ? existing.find((e) => maskKey(e.key) === raw)?.key : raw;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push({ label, key });
  }

  await setSetting(CF_KEYS_SETTING, JSON.stringify(kept));
  // The seats belonged to the old list, and anything queued for one was queued for a key
  // that may no longer exist
  leased.clear();
  for (const waiter of waiting.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.resolve(NO_KEY);
  }
  return kept;
}

// Keys handed out to a browser that is still running. A free key is one concurrent
// session, so a key in here is not offered again until its browser closes.
const leased = new Set<string>();

// Launches waiting for a seat, oldest first. A released key goes straight to the head of
// this queue rather than back to the pool, so a waiter cannot be jumped.
type Waiter = { resolve: (lease: LeasedKey) => void; timer: ReturnType<typeof setTimeout> };
const waiting: Waiter[] = [];

export type LeasedKey = {
  /** The key to launch with, or undefined when there is none free (or none at all). */
  key?: string;
  release: () => void;
};

const NO_KEY: LeasedKey = { release: () => {} };

function handOut(key: string): LeasedKey {
  let released = false;
  return {
    key,
    release: () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) {
        // Passed on while still counted as leased: the seat never goes back to the pool
        clearTimeout(next.timer);
        next.resolve(handOut(key));
        return;
      }
      leased.delete(key);
    },
  };
}

/**
 * Takes a key for one browser.
 *
 * A free key is a single concurrent session, so when every key is out this waits for one
 * rather than doubling up -- which the licence server refuses -- for up to `waitMs`.
 * Waiting is the honest answer: it makes how many solvers run at once follow how many keys
 * the operator has, instead of failing the job or quietly running an unlicensed build.
 *
 * Gives up with no key when the wait runs out, or when none is configured at all.
 */
/**
 * Reads the keys and takes the first free one as one critical section.
 *
 * Reading the keys is now a collection round-trip, so the await between "find a free key"
 * and "mark it leased" would otherwise let two concurrent launches lease the same key --
 * and the licence server refuses the second session outright. Serialising just this part
 * restores what a synchronous read gave for free; the wait below is not held under it.
 */
let leaseGate: Promise<unknown> = Promise.resolve();

async function takeFreeKey(): Promise<LeasedKey | undefined> {
  const run = leaseGate.then(async () => {
    const keys = await readKeys();
    const free = keys.find((entry) => !leased.has(entry.key));
    if (!free) return undefined;
    leased.add(free.key);
    return handOut(free.key);
  });
  // A rejected link must not wedge the gate for every later lease
  leaseGate = run.catch(() => {});
  return run;
}

export async function leaseCfLicenseKey(waitMs = 0): Promise<LeasedKey> {
  const envKey = process.env.CLOAKBROWSER_LICENSE_KEY?.trim();
  if (envKey) return { key: envKey, release: () => {} };

  const taken = await takeFreeKey();
  if (taken) return taken;
  if (!(await readKeys()).length || waitMs <= 0) return NO_KEY;

  return new Promise((resolve) => {
    const waiter: Waiter = {
      resolve,
      timer: setTimeout(() => {
        const at = waiting.indexOf(waiter);
        if (at >= 0) waiting.splice(at, 1);
        resolve(NO_KEY);
      }, waitMs),
    };
    waiting.push(waiter);
  });
}

/**
 * A key to identify the account with, without taking a seat. Downloading a build is not a
 * browser session, so the installer must not hold one -- and must not be told there is no
 * key just because every seat is currently in a running browser.
 */
export async function anyCfLicenseKey(): Promise<string | undefined> {
  return process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || (await readKeys())[0]?.key;
}

/** How many keys are configured and how many are in use right now, for the settings view. */
export async function cfLicenseUsage(): Promise<{ total: number; inUse: number }> {
  return { total: (await readKeys()).length, inUse: leased.size };
}
