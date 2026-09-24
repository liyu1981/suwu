/**
 * Lead-story carousel: autoplay every TICK with hover-pause, manual prev/next
 * and arrow keys (any interaction resets the timer), and rundown selection.
 * Renders only — data lives in stories-cache.
 *
 * Public file: never put secrets here (docs/EXTENSION_API_PLAN.md §2.8).
 */
import { entries, revision, esc, safeURL, ago } from "./stories-cache.js";

const TICK = 5000;

let dom = null;
let index = 0;
let timer = null;
let paused = false;
let shownRevision = -1;

function leadHTML(s, i) {
  const discussion = safeURL(s.discussion, "https://news.ycombinator.com/");
  const url = safeURL(s.url, discussion);
  return (
    '<p class="kicker">Top story No. ' +
    (i + 1) +
    " &middot; Wire dispatch</p>" +
    '<h2 class="headline"><a href="' +
    esc(url) +
    '" target="_blank" rel="noopener">' +
    esc(s.title) +
    "</a></h2>" +
    '<p class="deck">by ' +
    esc(s.author || "unknown") +
    " &middot; " +
    esc(String(s.score || 0)) +
    " points &middot; " +
    esc(String(s.comments || 0)) +
    " comments" +
    (s.age ? " &middot; " + esc(ago(s.age)) : "") +
    "</p>" +
    '<p class="discuss"><a href="' +
    esc(discussion) +
    '" target="_blank" rel="noopener">Discuss on Hacker News</a></p>'
  );
}

function renderRundown() {
  let html = "";
  entries().forEach((s, i) => {
    html +=
      '<li class="' +
      (i === index ? "current" : "") +
      '" data-index="' +
      i +
      '"><span class="rank">' +
      (i + 1) +
      '</span><span class="title">' +
      esc(s.title) +
      '</span><span class="pts">' +
      esc(String(s.score || 0)) +
      " pts</span></li>";
  });
  dom.rundown.innerHTML = html;
}

function render() {
  const items = entries();
  if (items.length === 0) return;
  if (index >= items.length) index = 0;
  dom.prev.disabled = false;
  dom.next.disabled = false;
  const s = items[index];
  dom.lead.innerHTML = leadHTML(s, index);
  dom.lead.classList.remove("flip");
  void dom.lead.offsetWidth; // restart the transition from the current value
  dom.lead.classList.add("flip");
  renderRundown();
  dom.counter.textContent = index + 1 + " / " + items.length;
  dom.pageStamp.textContent = "Page " + (index + 1) + " of " + items.length;
  const cur = dom.rundown.querySelector("li.current");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function stamp() {
  const d = new Date();
  dom.updatedStamp.textContent =
    "Updated " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}

function step(delta) {
  const items = entries();
  if (items.length === 0) return;
  index = (index + delta + items.length) % items.length;
  render();
}

function restart() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => step(1), TICK);
}

/** Called after each successful poll: re-render only when the edition changed. */
export function onEdition() {
  if (revision() !== shownRevision) {
    shownRevision = revision();
    render();
  }
  stamp();
}

/** Wire the page's DOM for the carousel and start autoplay. */
export function mountCarousel(domRefs) {
  dom = domRefs;

  dom.dateStamp.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  dom.prev.addEventListener("click", () => {
    step(-1);
    restart();
  });
  dom.next.addEventListener("click", () => {
    step(1);
    restart();
  });

  dom.rundown.addEventListener("click", (e) => {
    const li = e.target.closest ? e.target.closest("li[data-index]") : null;
    if (!li) return;
    index = Number(li.getAttribute("data-index")) || 0;
    render();
    restart();
  });

  // Autoplay pauses while the pointer rests on the lead (agency); manual
  // navigation resets the 5-second timer.
  dom.lead.addEventListener("mouseenter", () => {
    paused = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  dom.lead.addEventListener("mouseleave", () => {
    if (paused) {
      paused = false;
      restart();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      step(-1);
      restart();
    } else if (e.key === "ArrowRight") {
      step(1);
      restart();
    }
  });

  restart();
}
