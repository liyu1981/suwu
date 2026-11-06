/**
 * ES-module entry: joins the authenticated API URL (data-api injected by the
 * render stub), the 5-minute refresh, and the carousel. The handler behind
 * that URL crawls Hacker News server-side, so this module is the entire
 * client — no CDN, no third-party script in the page.
 *
 * Public file: never put secrets here — the token arrives at runtime via
 * data-api from the authenticated HTML (docs/EXTENSION_API_PLAN.md §2.8).
 */
import { merge } from "./stories-cache.js";
import { mountCarousel, onEdition } from "./carousel.js";

const wire = document.getElementById("wire");
const API = wire.dataset.api; // token-bearing URL, injected server-side

function onStories(text) {
  let fresh;
  try {
    fresh = JSON.parse(text);
  } catch (err) {
    return;
  }
  if (!Array.isArray(fresh) || fresh.length === 0) return;
  merge(fresh);
  onEdition();
}

mountCarousel({
  lead: document.getElementById("lead"),
  rundown: document.getElementById("rundown"),
  counter: document.getElementById("counter"),
  pageStamp: document.getElementById("edition-page"),
  updatedStamp: document.getElementById("edition-updated"),
  dateStamp: document.getElementById("edition-date"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
});

const POLL_MS = 300000;

// One pull at startup, then one every five minutes. A failed request never
// reaches onStories, so the last edition stays on screen and the next tick
// simply tries again.
function pull() {
  fetch(API)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })
    .then(onStories)
    .catch(() => {
      /* keep the last edition */
    });
}

pull();
window.setInterval(pull, POLL_MS);
