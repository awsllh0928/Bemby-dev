import { ref } from "vue";
import { settingsApi } from "../api/client";

// Module-level singleton: whether the upcoming-runs list gets its own menu entry rather than
// sitting inside the jobs page. Shared so App.vue's menu and JobsView's panel agree the
// moment the setting changes.
const separatePage = ref(false);
let loaded = false;

/** Lazy-loads the setting once. Safe to call from any view's onMounted. */
export async function loadSchedulePageSetting(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const s = await settingsApi.get();
    separatePage.value = s.schedule_separate_page === "true";
  } catch {
    loaded = false; // allow a later retry
  }
}

/** Applies the change straight away (called by Settings when the toggle flips). */
export function setSchedulePageSeparate(value: boolean): void {
  separatePage.value = value;
  loaded = true;
}

export { separatePage as scheduleSeparatePage };
