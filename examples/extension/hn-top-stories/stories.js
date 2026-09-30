// The API half of Hacker News Top Stories: fetches the current front page
// from the Algolia HN API on the server side and relays it as a JSON array.
//
// Network access comes from `"suwu": { "net": true }` in package.json —
// without it, fetch() rejects with "network access is disabled".
//
// Contract (docs/EXTENSION_API_PLAN.md):
//   input  = { action, id, route, path, pathParams, method, query, headers, ... }
//   return = { status?, contentType?, headers?, body | bodyB64 }

const FRONT_PAGE =
  "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30";
const MAX_STORIES = 30;

async function handler(input) {
  // Route matching is a prefix match, so /stories/anything also lands here:
  // the handler keeps its own surface exact.
  if (input.path !== "/stories") {
    return json(404, { error: "not found" });
  }
  if (input.method !== "GET" && input.method !== "HEAD") {
    return json(405, { error: "method not allowed" });
  }

  let res;
  try {
    res = await fetch(FRONT_PAGE);
  } catch (e) {
    return json(502, { error: "hacker news is unreachable" });
  }
  if (!res.ok) {
    return json(502, { error: "hacker news returned status " + res.status });
  }

  const data = await res.json();
  const hits = Array.isArray(data && data.hits) ? data.hits : [];
  const stories = hits.slice(0, MAX_STORIES).map(function (h) {
    const discussion = "https://news.ycombinator.com/item?id=" + h.objectID;
    return {
      id: String(h.objectID),
      title: h.title || "(untitled)",
      url: h.url || discussion,
      discussion: discussion,
      score: h.points || 0,
      comments: h.num_comments || 0,
      author: h.author || "",
      age: h.created_at || ""
    };
  });
  if (stories.length === 0) {
    return json(502, { error: "hacker news returned no stories" });
  }
  return json(200, stories);
}

function json(status, payload) {
  return {
    status: status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload)
  };
}
