vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));

import { describe, it, expect, vi } from "vitest";
import {
  ALLOWED_KEYS,
  maskProxies,
  PROXY_PASSWORD_MASK,
  unmaskProxies,
} from "../routes/settings";

// ---------------------------------------------------------------------------
// ALLOWED_KEYS whitelist
// ---------------------------------------------------------------------------

describe("ALLOWED_KEYS", () => {
  it("contains all expected setting keys", () => {
    const expected = [
      "default_timezone",
      "default_max_retry",
      "check_daily_run",
      "default_ua",
      "default_play_duration",
      "default_device_name",
      "ai_model",
      "notify_tg_username",
      "notify_tg_events",
      "notify_bot_token",
      "notify_bot_target",
      "ua_presets",
      "log_retention_days",
      "schedule_min_gap_minutes",
    ];
    for (const key of expected) {
      expect(ALLOWED_KEYS).toContain(key);
    }
  });

  it("does not permit arbitrary keys", () => {
    expect(ALLOWED_KEYS).not.toContain("password");
    expect(ALLOWED_KEYS).not.toContain("session_string");
    expect(ALLOWED_KEYS).not.toContain("api_key");
    expect(ALLOWED_KEYS).not.toContain("jwt_secret");
  });

  it("has no duplicate entries", () => {
    expect(new Set(ALLOWED_KEYS).size).toBe(ALLOWED_KEYS.length);
  });
});

// ── Proxy credentials ─────────────────────────────────────────────────────────
// A proxy is stored as a URL with its password inside it. That password is a credential
// like any other, so it does not travel to the client; the mask has to survive the round
// trip back or an untouched proxy would be saved with its password wiped.

describe('proxy password masking', () => {
  const stored = JSON.stringify([
    { id: 'p1', name: 'One', url: 'socks5://user:s3cret@1.2.3.4:1080' },
    { id: 'p2', name: 'Two', url: 'socks5://5.6.7.8:1080' },
  ]);

  it('replaces the password on the way out and leaves the rest of the URL alone', () => {
    const masked = JSON.parse(maskProxies(stored)) as Array<{ url: string }>;
    expect(masked[0].url).toBe(`socks5://user:${PROXY_PASSWORD_MASK}@1.2.3.4:1080`);
    expect(masked[0].url).not.toContain('s3cret');
    // Nothing to mask on a proxy that has no credentials
    expect(masked[1].url).toBe('socks5://5.6.7.8:1080');
  });

  it('puts the real password back when the client echoes the mask unchanged', () => {
    const roundTripped = unmaskProxies(maskProxies(stored), stored);
    expect(JSON.parse(roundTripped)).toEqual(JSON.parse(stored));
  });

  it('keeps a password the operator actually retyped', () => {
    const edited = JSON.stringify([
      { id: 'p1', name: 'One', url: 'socks5://user:brand-new@1.2.3.4:1080' },
    ]);
    const saved = JSON.parse(unmaskProxies(edited, stored)) as Array<{ url: string }>;
    expect(saved[0].url).toContain('brand-new');
  });

  it('keeps other edits to a masked entry, such as a changed host', () => {
    const edited = JSON.stringify([
      { id: 'p1', name: 'Renamed', url: `socks5://user:${PROXY_PASSWORD_MASK}@9.9.9.9:1080` },
    ]);
    const saved = JSON.parse(unmaskProxies(edited, stored)) as Array<{ url: string; name: string }>;
    expect(saved[0].name).toBe('Renamed');
    expect(saved[0].url).toBe('socks5://user:s3cret@9.9.9.9:1080');
  });

  it('has nothing to restore for a proxy that was not stored before', () => {
    const added = JSON.stringify([
      { id: 'new', name: 'New', url: `socks5://user:${PROXY_PASSWORD_MASK}@1.1.1.1:1080` },
    ]);
    const saved = JSON.parse(unmaskProxies(added, stored)) as Array<{ url: string }>;
    // The mask is cleared rather than saved as if it were the password
    expect(saved[0].url).toBe('socks5://user@1.1.1.1:1080');
    expect(saved[0].url).not.toContain(PROXY_PASSWORD_MASK);
  });

  it('leaves a malformed or empty list alone', () => {
    expect(maskProxies(undefined)).toBe('[]');
    expect(maskProxies('not json')).toBe('not json');
    expect(unmaskProxies('not json', stored)).toBe('not json');
  });
});
