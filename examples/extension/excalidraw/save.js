// Save handler: writes the posted scene to the file given by ?file=...
function handler() {
  const file = (input.query && input.query.file) || (input.params && input.params.file) || "";
  if (!file) {
    return { status: 400, contentType: "application/json", body: '{"error":"missing file"}' };
  }
  const base = file.split("/").pop();
  const path = "/fs/" + base;
  const body = input.body || "";
  fs.writeFileSync(path, body);
  return { status: 200, contentType: "application/json", body: '{"ok":true}' };
}
