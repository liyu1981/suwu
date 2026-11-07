/**
 * Vendor the Bento Slides shell into dist/.
 *
 * A `.bento.html` carries its own copy of the app, so the tile does not need a
 * second build of Bento — it needs one known-good shell, pinned by hash. This
 * script fetches the released single-file build, verifies it against
 * shell.lock.json, and writes dist/shell.html. `--from-source` builds from a
 * local checkout of the repo instead (for testing a Bento change).
 *
 *   node vendor.mjs                     # fetch the pinned release
 *   node vendor.mjs --from-source ../bento   # cd slides && npm i && npm run build:single
 *
 * Nothing else in the extension is generated: index.js splices the deck into this
 * shell at render time, and save.js writes the file back.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const OUT = join(DIST, "shell.html");
const lock = JSON.parse(readFileSync(join(HERE, "shell.lock.json"), "utf8"));

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function fromRelease() {
  process.stdout.write(`vendor: fetching ${lock.url}\n`);
  const res = await fetch(lock.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${lock.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== lock.sha256) {
    throw new Error(
      `sha256 mismatch: expected ${lock.sha256}\n` +
        `                  got      ${got}\n` +
        `upstream changed. If you meant to move to a new Bento release, update\n` +
        `shell.lock.json (version, bytes, sha256) in the same commit.`,
    );
  }
  if (buf.length !== lock.bytes) {
    throw new Error(`size mismatch: expected ${lock.bytes}, got ${buf.length}`);
  }
  return buf;
}

function fromSource(repo) {
  const slides = join(resolve(repo), "slides");
  if (!existsSync(join(slides, "package.json"))) {
    throw new Error(`--from-source: ${slides} is not a Bento checkout`);
  }
  process.stdout.write(`vendor: building ${slides} (npm run build:single)\n`);
  execFileSync("npm", ["install"], { cwd: slides, stdio: "inherit" });
  execFileSync("npm", ["run", "build:single"], { cwd: slides, stdio: "inherit" });
  const built = join(slides, "dist-single", "Bento_Slides.bento.html");
  const buf = readFileSync(built);
  process.stdout.write(`vendor: built ${buf.length} bytes, sha256 ${sha256(buf)}\n`);
  process.stdout.write("vendor: this is NOT the pinned release — dist/ is dirty, do not commit it\n");
  // Licensing travels with the shell.
  for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    const src = join(resolve(repo), f);
    if (existsSync(src)) copyFileSync(src, join(DIST, f));
  }
  return buf;
}

const fromIdx = process.argv.indexOf("--from-source");
const buf = fromIdx > 0 ? fromSource(process.argv[fromIdx + 1] || "..") : await fromRelease();

mkdirSync(DIST, { recursive: true });
writeFileSync(OUT, buf);
process.stdout.write(`vendor: wrote ${OUT} (${buf.length} bytes)\n`);
