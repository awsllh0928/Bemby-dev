// Microsoft Edge restores a minimised window the instant a History API call runs inside a
// visibilitychange handler, and vue-router makes one there to save the scroll position, so
// the panel pops back up the moment it is minimised. Dropping just that call keeps it down.
// See https://wiki.4ading.com/vue/trouble/edge-minimize-problem/
//
// Scoped to the visibilitychange dispatch rather than to "the page is hidden" as the article
// has it: a background tab that navigates for its own reasons -- an expired session sending
// the app to the login page, say -- must still update the address bar.

const IS_EDGE = /\bEdg\//.test(navigator.userAgent);

/** Installs the workaround once at startup; a no-op on every browser but Edge. */
export function suppressEdgeMinimizeRestore(): void {
  if (!IS_EDGE) return;

  let inVisibilityChange = false;

  // On window in the capture phase, so this runs ahead of every listener on document
  // whatever order the modules registering them happen to load in.
  window.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState !== "hidden") return;
      inVisibilityChange = true;
      // One event's listeners all run in the same task, so a microtask lowers the flag
      // once the last of them has been served.
      void Promise.resolve().then(() => {
        inVisibilityChange = false;
      });
    },
    true,
  );

  type StateFn = (data: unknown, unused: string, url?: string | URL | null) => void;

  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name].bind(history) as StateFn;
    const guarded: StateFn = (data, unused, url) => {
      if (inVisibilityChange) return;
      original(data, unused, url);
    };
    history[name] = guarded;
  }
}
