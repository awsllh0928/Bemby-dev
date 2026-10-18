import { ref } from "vue";
import { settingsApi } from "../api/client";

// Module-level singleton: whether to append the Telegram name when referring to
// an account elsewhere in the app (Messenger, jobs, templates, ...).
// Shared across all views so a change in Settings is reflected everywhere.
const withTgName = ref(false);
let loaded = false;

// Lazy-load the setting once. Safe to call from any view's onMounted.
export async function loadAccountDisplaySetting(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const s = await settingsApi.get();
    withTgName.value = s.account_display_with_tg_name === "true";
  } catch {
    loaded = false; // allow a later retry
  }
}

// Update the shared value immediately (called by Settings when the toggle changes).
export function setAccountDisplayWithTgName(value: boolean): void {
  withTgName.value = value;
  loaded = true;
}

type AccountLike = { name: string; tgDisplayName?: string | null };

// Compose an account's display label, appending the TG name when the setting is on.
export function formatAccountLabel(
  account: AccountLike | null | undefined,
  fallback = "",
): string {
  if (!account) return fallback;
  if (withTgName.value && account.tgDisplayName) {
    return `${account.name} - ${account.tgDisplayName}`;
  }
  return account.name || fallback;
}

export { withTgName as accountDisplayWithTgName };
