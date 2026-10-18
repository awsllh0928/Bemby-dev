import { reactive } from 'vue';

const STORAGE_KEY = 'bemby_avatar_cache';

function loadFromStorage(): [string, string][] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as [string, string][];
  } catch {
    // Corrupted -- start fresh
  }
  return [];
}

// Module-level singleton: survives component unmount/remount, shared across all accounts,
// and backed by sessionStorage so page refreshes don't trigger repeat network requests.
// Key: chatId  Value: base64 string | '' (no avatar)  undefined = not yet fetched
export const avatarCache = reactive(new Map<string, string>(loadFromStorage()));

let persistTimer: ReturnType<typeof setTimeout> | null = null;

// Debounced write -- avatars often arrive in bursts, no need to serialise on every single one.
export function persistAvatarCache(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      // Only persist entries that have avatar data; skip empty strings so stale
      // "no avatar" results don't prevent a later fetch from succeeding.
      const entries = [...avatarCache.entries()].filter(([, v]) => v !== '');
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Quota exceeded or storage unavailable -- cache still works in-memory
    }
  }, 300);
}

export const avatarQueue: string[] = [];
export const avatarQueued = new Set<string>();
export const avatarFetching = new Set<string>();
export const avatarConcurrencyState = { active: 0 };
