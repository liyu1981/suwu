/**
 * ES-module entry: joins the authenticated API URL (data-api injected by the
 * render stub), the 5-minute htmx poll, a plain-fetch fallback for when the
 * htmx CDN is unreachable, and the carousel.
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

// htmx drives the poll (hx-trigger="load, every 300s"); a failed request
// never reaches onStories, so the last edition stays on screen.
document.body.addEventListener("htmx:afterRequest", (e) => {
  const xhr = e.detail && e.detail.xhr;
  if (!xhr || xhr.status !== 200) return;
  onStories(xhr.responseText);
});

// If the CDN was unreachable, fall back to plain fetch polling — the API
// call itself never depended on htmx.
if (!window.htmx) {
  const pull = () =>
    fetch(API)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then(onStories)
      .catch(() => {
        /* keep the last edition */
      });
  pull();
  setInterval(pull, 300000);
}
