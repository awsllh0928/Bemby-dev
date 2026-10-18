import crypto from 'crypto';
import argon2 from 'argon2';
import { getSettings } from '../db/repos/settings';

// Legacy HMAC key -- retained only for verifying existing stored hashes during migration
const LEGACY_HMAC_KEY = 'bemby-pwd-v1';

export function legacyHashPassword(password: string): string {
  return crypto.createHmac('sha256', LEGACY_HMAC_KEY).update(password).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function isArgon2Hash(h: string): boolean {
  return h.startsWith('$argon2');
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  if (isArgon2Hash(stored)) return argon2.verify(stored, plaintext);
  // Legacy HMAC path -- constant-time comparison
  return timingSafeCompare(legacyHashPassword(plaintext), stored);
}

export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Constant-time equality for values of any length. `timingSafeCompare` above returns early
 * when the lengths differ, which is right for two hashes (always the same length) but leaks
 * the length of anything else. Hashing both sides first gives fixed-length inputs, so this
 * suits a username, where the length is part of what an attacker is trying to learn.
 */
export function constantTimeStringEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function getStoredCredentials(): Promise<{
  username: string;
  passwordHash: string | null;
}> {
  const map = await getSettings(['admin_username', 'admin_password_hash']);
  return {
    username: map['admin_username'] ?? (process.env.ADMIN_USERNAME ?? 'admin'),
    passwordHash: map['admin_password_hash'] ?? null,
  };
}
