// Fetch a JSON API with the modern Fetch API.
// Requires network access: `suwu gq --allow-net --print-result examples/gqjs/fetch.js`
// (add --allow-private to reach a local dev server).
const res = await fetch('https://httpbin.org/get?from=suwu', {
  headers: { 'X-Suwu': 'gqjs' },
});

console.log(res.status, res.statusText, res.url);

({
  ok: res.ok,
  contentType: res.headers.get('content-type'),
  body: await res.json(),
});
