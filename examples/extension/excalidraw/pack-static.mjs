/**
 * Pack the built static tree into a single archive.
 *
 * `suwu.static: "dist.zip"` makes the backend serve /gqjs/static/<id>/<path>
 * from inside a zip instead of from a directory, so an installed extension is
 * one file per extension rather than ~400 — in git, in the install payload, and
 * for the GitHub catalog. Text entries are deflated (~7.8 MB of JS becomes
 * ~2.4 MB); everything else is stored, because fonts and images are already
 * compressed and deflating them only costs CPU on both ends. HTTP gzip is
 * independent — the server compresses what it serves, whatever the archive
 * holds. No dependencies, and a fixed timestamp keeps the archive reproducible.
 *
 * Usage: node pack-static.mjs   (run from the extension directory)
 */
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { join, relative, sep } from "node:path";

const EXT_DIR = process.cwd();
const pkg = JSON.parse(readFileSync(join(EXT_DIR, "package.json"), "utf8"));
const staticPath = (pkg.suwu && pkg.suwu.static) || "";
if (!staticPath.endsWith(".zip")) {
  console.error(`pack-static: suwu.static is ${JSON.stringify(staticPath)}, not a .zip — nothing to do`);
  process.exit(1);
}
const SRC = join(EXT_DIR, staticPath.slice(0, -".zip".length));
const OUT = join(EXT_DIR, staticPath);

// ── deterministic input: every file under SRC, sorted, with fixed mtimes ─────

/** @returns {string[]} relative slash-separated file paths, sorted */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(SRC, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

// ── zip writing (stored entries only) ────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS time/date for a fixed timestamp (1980-01-01 00:00), so the archive is
// reproducible: the same sources always produce the same bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // year 1980, month 1, day 1

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const name of files) {
    const raw = readFileSync(join(SRC, name));
    // Deflate text; store everything else (already-compressed formats).
    const deflate = /\.(js|mjs|css|html|htm|xhtml|json|svg|txt|map)$/i.test(name);
    const data = deflate ? deflateRawSync(raw, { level: 9 }) : raw;
    const method = deflate ? 8 : 0;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(raw.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // signature
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}

// ── entry metadata for the render stub ───────────────────────────────────────

// The render stub (index.js) cannot read inside the archive from the gqjs
// sandbox, so the hashed entry chunk is published next to it as build.json.
function writeBuildInfo() {
  const manifest = JSON.parse(readFileSync(join(SRC, ".vite", "manifest.json"), "utf8"));
  let entry = manifest["src/main.js"];
  if (!entry) {
    for (const key of Object.keys(manifest)) {
      if (manifest[key] && manifest[key].isEntry) {
        entry = manifest[key];
        break;
      }
    }
  }
  if (!entry || !entry.file) throw new Error("build manifest has no entry chunk");
  const info = { js: entry.file, css: Array.isArray(entry.css) ? entry.css : [] };
  writeFileSync(join(EXT_DIR, "build.json"), JSON.stringify(info, null, 2) + "\n");
  return info;
}

// ── main ─────────────────────────────────────────────────────────────────────

const files = listFiles(SRC).filter(
  // Vite's manifest is build metadata: build.json carries what the page needs,
  // and shipping the raw manifest would expose the build's module graph.
  (rel) => !rel.startsWith(".vite/") && !rel.endsWith(".map"),
);

const info = writeBuildInfo();
const zip = buildZip(files);
writeFileSync(OUT, zip);

// The unpacked tree is a build artifact; the archive is what ships.
rmSync(SRC, { recursive: true, force: true });

const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
console.log(`pack-static: ${files.length} files -> ${staticPath} (${kib(zip.length)})`);
console.log(`pack-static: build.json entry=${info.js}${info.css.length ? ` css=${info.css.join(",")}` : ""}`);
