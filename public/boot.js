"use strict";

// dogear used to carry its first author's name, "bw" (bookworm), in everything
// it stores on a device: localStorage keys "bw_…" and cache names "bw-…". Move
// whatever a device already holds to the new names, once, so renaming loses
// no setting, no downloaded voice pack and no offline chapters.
// Loaded first (before i18n.js, which reads the language key).

(() => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("bw_")) continue;
      const next = "dogear_" + key.slice(3);
      if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key));
      localStorage.removeItem(key);
    }
  } catch { /* private mode: nothing was stored anyway */ }
})();

// The service worker's own "bw-shell-*" caches are dropped by the new worker;
// the others hold data that is expensive to fetch again (the ~140 MB voice pack,
// offline chapters), so their entries are copied across.
(async () => {
  if (!("caches" in self)) return;
  try {
    for (const name of await caches.keys()) {
      if (!name.startsWith("bw-") || name.startsWith("bw-shell-")) continue;
      const from = await caches.open(name);
      const to = await caches.open("dogear-" + name.slice(3));
      for (const request of await from.keys()) {
        const response = await from.match(request);
        if (response) await to.put(request, response);
      }
      await caches.delete(name);
    }
  } catch { /* the next load tries again; the old cache is only deleted after a full copy */ }
})();
