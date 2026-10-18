// Session strings, api_hashes and passkey private keys are encrypted in the database when a
// data key is configured. What matters here is that turning the key on does not strand the
// rows written before it, and that turning it off (or changing it) fails safe rather than
// handing back rubbish that would be used as a credential.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  decryptAccountRow,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  isSecretEncryptionEnabled,
  resetSecretKeyCache,
} from "../db/secretColumns";

const KEY = "test-data-key-not-for-real-use";

function withKey(value: string | undefined): void {
  if (value === undefined) delete process.env.BEMBY_DATA_KEY;
  else process.env.BEMBY_DATA_KEY = value;
  resetSecretKeyCache();
}

beforeEach(() => {
  withKey(KEY);
});

afterEach(() => {
  withKey(undefined);
  vi.restoreAllMocks();
});

describe("with a key configured", () => {
  it("round-trips a value", () => {
    const secret = "1BQANOTEuMTA4LjU2LjEzMAG7fake==";
    const stored = encryptSecret(secret);
    expect(stored).not.toBe(secret);
    expect(stored).not.toContain(secret);
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe(secret);
  });

  it("produces different ciphertext each time, so equal values are not obviously equal", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("leaves null and empty values alone", () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeUndefined();
    expect(encryptSecret("")).toBe("");
  });

  it("does not encrypt twice", () => {
    const once = encryptSecret("value");
    expect(encryptSecret(once)).toBe(once);
  });

  it("passes plain text through, so rows written before the key was set still read", () => {
    expect(decryptSecret("plain-session-string")).toBe("plain-session-string");
  });

  it("refuses a value written under a different key rather than returning rubbish", () => {
    const stored = encryptSecret("value");
    vi.spyOn(console, "error").mockImplementation(() => {});
    withKey("a-completely-different-key");
    expect(decryptSecret(stored)).toBeNull();
  });

  it("rejects a tampered payload -- GCM authenticates as well as encrypts", () => {
    const stored = encryptSecret("value")!;
    const parts = stored.split(":");
    parts[parts.length - 1] = Buffer.from("tampered").toString("base64url");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(decryptSecret(parts.join(":"))).toBeNull();
  });

  it("decrypts every secret column on a row and leaves the rest untouched", () => {
    const row = {
      id: 7,
      name: "acct",
      api_hash: encryptSecret("hash"),
      session_string: encryptSecret("session"),
      passkey: encryptSecret('{"credentialId":"x"}'),
    };
    const out = decryptAccountRow(row);
    expect(out.api_hash).toBe("hash");
    expect(out.session_string).toBe("session");
    expect(out.passkey).toBe('{"credentialId":"x"}');
    expect(out.name).toBe("acct");
    expect(out.id).toBe(7);
  });

  it("leaves columns the query did not select alone", () => {
    const row = { session_string: encryptSecret("session") } as Record<string, unknown>;
    decryptAccountRow(row);
    expect(row.session_string).toBe("session");
    expect("api_hash" in row).toBe(false);
  });
});

describe("with no key configured", () => {
  beforeEach(() => withKey(undefined));

  it("stores values as they are, so an install that has not opted in is unchanged", () => {
    expect(isSecretEncryptionEnabled()).toBe(false);
    expect(encryptSecret("value")).toBe("value");
    expect(decryptSecret("value")).toBe("value");
  });

  it("reports rather than mangles a value it cannot read", () => {
    withKey(KEY);
    const stored = encryptSecret("value");
    vi.spyOn(console, "error").mockImplementation(() => {});
    withKey(undefined);
    expect(decryptSecret(stored)).toBeNull();
  });
});
