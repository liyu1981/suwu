#!/usr/bin/env python3
"""Read tools/catalog.json for the release builders.

The catalog is the single source of truth for every pinned tool: version, URL,
sha256, archive layout and the files a tool owns. The build scripts ask this
script instead of keeping a second copy of the pins.

  tool-payload.py list  --goos linux --goarch amd64 [--bundled max]
      One line per tool: name|version|archive|url|sha256|strip|entries|keep|docs
      where entries is "file:mode,..." and docs is "name:url,...".

  tool-payload.py extract --archive X --out DIR --strip N --entries ...
                          [--keep ...] --name NAME
      Unpack only the declared entries (and the declared license files under
      DIR/tools/NAME/) out of the archive, with the declared modes.

  tool-payload.py pin --goarch amd64 --name rg=sha256 [--name ...]
      Write computed digests back into the catalog (build-max.sh --update-pins).

Extraction is deliberately narrow: a member is written only when its
strip-normalised path matches a declared entry, so an unexpected file in a
release archive cannot end up in the bundle.
"""

import argparse
import json
import os
import shutil
import sys
import tarfile
import tempfile
import zipfile


def load(path):
    with open(path) as f:
        return json.load(f)


def platform_of(tool, goos, goarch):
    return tool["platforms"].get(f"{goos}-{goarch}")


def cmd_list(args):
    data = load(args.catalog)
    for tool in data["tools"]:
        if args.bundled and tool.get("bundled") != args.bundled:
            continue
        p = platform_of(tool, args.goos, args.goarch)
        if p is None:
            # A tool that does not ship for this target is not an error: the
            # bundle simply carries the ones that do.
            continue
        entries = ",".join(f"{e['file']}:{e['mode']}" for e in p["entries"])
        keep = ",".join(tool.get("keep") or [])
        docs = ",".join(f"{k}:{v}" for k, v in (p.get("docs") or {}).items())
        print("|".join([
            tool["name"], tool["version"], p["archive"], p["url"], p["sha256"],
            str(p["strip"]), entries, keep, docs,
        ]))


def stripped(name, strip):
    parts = name.split("/")
    if len(parts) <= strip:
        return None
    return "/".join(parts[strip:])


def write_member(reader_factory, dest, mode):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".tmp"
    with reader_factory() as src, open(tmp, "wb") as out:
        shutil.copyfileobj(src, out)
    os.chmod(tmp, mode)
    os.replace(tmp, dest)


def cmd_extract(args):
    entries = {}
    for spec in filter(None, args.entries.split(",")):
        name, mode = spec.split(":")
        entries[name] = int(mode, 8)
    if not entries:
        sys.exit("extract: no entries declared")

    out = args.out
    written = set()
    if args.archive == "none":
        # The download is the binary itself.
        (only,) = entries
        write_member(lambda: open(args.source, "rb"), os.path.join(out, only), entries[only])
        written.add(only)
    elif args.archive == "tar.gz":
        with tarfile.open(args.source) as tf:
            for m in tf:
                if not m.isfile():
                    continue
                rel = stripped(m.name.lstrip("./"), args.strip)
                if rel in entries and rel not in written:
                    write_member(lambda m=m: tf.extractfile(m), os.path.join(out, rel), entries[rel])
                    written.add(rel)
    elif args.archive == "zip":
        with zipfile.ZipFile(args.source) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                rel = stripped(info.filename.lstrip("./"), args.strip)
                if rel in entries and rel not in written:
                    write_member(lambda i=info: zf.open(i), os.path.join(out, rel), entries[rel])
                    written.add(rel)
    else:
        sys.exit(f"extract: unknown archive {args.archive}")

    missing = set(entries) - written
    if missing:
        sys.exit(f"extract: {args.name}: not found in the archive: {', '.join(sorted(missing))}")

    # Licenses and notices ride beside the binary, under tools/<name>/.
    for keep in filter(None, args.keep.split(",")):
        collect_keep(args, keep)


def collect_keep(args, keep):
    dest_root = os.path.join(args.out, "tools", args.name)
    if args.archive == "tar.gz":
        with tarfile.open(args.source) as tf:
            for m in tf:
                rel = stripped(m.name.lstrip("./"), args.strip)
                if rel != keep and not (rel or "").startswith(keep + "/"):
                    continue
                dest = os.path.join(dest_root, rel)
                if m.isdir():
                    os.makedirs(dest, exist_ok=True)
                elif m.isfile():
                    write_member(lambda m=m: tf.extractfile(m), dest, 0o644)
    elif args.archive == "zip":
        with zipfile.ZipFile(args.source) as zf:
            for info in zf.infolist():
                rel = stripped(info.filename.lstrip("./"), args.strip)
                if rel is None:
                    continue
                if rel != keep and not rel.startswith(keep + "/"):
                    continue
                dest = os.path.join(dest_root, rel)
                if info.is_dir():
                    os.makedirs(dest, exist_ok=True)
                else:
                    write_member(lambda i=info: zf.open(i), dest, 0o644)


def cmd_pin(args):
    data = load(args.catalog)
    wanted = dict(spec.split("=", 1) for spec in args.name)
    for tool in data["tools"]:
        digest = wanted.get(tool["name"])
        if not digest:
            continue
        p = tool["platforms"].get(f"{args.goos}-{args.goarch}")
        if p is None:
            continue
        p["sha256"] = digest
    with open(args.catalog, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default="tools/catalog.json")
    sub = ap.add_subparsers(dest="cmd", required=True)

    ls = sub.add_parser("list")
    ls.add_argument("--goos", required=True)
    ls.add_argument("--goarch", required=True)
    ls.add_argument("--bundled", default="")
    ls.set_defaults(func=cmd_list)

    ex = sub.add_parser("extract")
    ex.add_argument("--source", required=True, help="the downloaded asset")
    ex.add_argument("--archive", default="tar.gz")
    ex.add_argument("--out", required=True)
    ex.add_argument("--strip", type=int, default=0)
    ex.add_argument("--entries", required=True)
    ex.add_argument("--keep", default="")
    ex.add_argument("--name", required=True)
    ex.set_defaults(func=cmd_extract)

    pin = sub.add_parser("pin")
    pin.add_argument("--goos", required=True)
    pin.add_argument("--goarch", required=True)
    pin.add_argument("--name", action="append", default=[])
    pin.set_defaults(func=cmd_pin)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
