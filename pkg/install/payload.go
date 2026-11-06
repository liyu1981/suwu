package install

// The install payload: what actually lands in the data directory.
//
// An extension used to be a handful of hand-written files, so copying an archive
// or a repository subtree wholesale was correct. Now that an extension is a
// normal JS project (Vite → dist/, package.json, src/, node_modules/) the source
// tree contains a lot of things the server must never see — and, for a catalog
// install, a lot of things that would each cost one HTTP GET.
//
// So every install path (archive, catalog, local directory) filters through the
// single rule below. One definition, so the three cannot drift.

import (
	"fmt"
	"path"
	"strings"
)

// payloadAlways are the files every extension must ship, plus the small
// documentation that belongs with an installed item.
var payloadAlways = map[string]bool{
	"package.json":           true,
	"index.js":               true,
	"README.md":              true,
	"LICENSE":                true,
	"NOTICE":                 true,
	"THIRD_PARTY_NOTICES":    true,
	"THIRD_PARTY_NOTICES.md": true,
}

// payloadSkipPrefixes are never part of an install: build inputs, dependency
// trees, VCS data, and caches.
var payloadSkipPrefixes = []string{
	"node_modules/",
	"src/",
	".git/",
	".github/",
	".vscode/",
	".idea/",
}

// payloadSkipFiles are never part of an install: lockfiles, editor and build
// configuration, ignore rules. They describe how to build the thing, not the
// thing itself.
var payloadSkipFiles = map[string]bool{
	"pnpm-lock.yaml":      true,
	"package-lock.json":   true,
	"yarn.lock":           true,
	"bun.lockb":           true,
	"pnpm-workspace.yaml": true,
	"tsconfig.json":       true,
	".gitignore":          true,
	".gitattributes":      true,
	".npmrc":              true,
	"vite.config.ts":      true,
	"vite.config.js":      true,
	"vite.config.mjs":     true,
	"pack-static.mjs":     true,
	"build.mjs":           true,
	"rollup.config.js":    true,
	"tsconfig.node.json":  true,
}

// SkipPayload reports whether rel (a payload-relative, slash-separated path)
// is excluded from an install, with a short reason for the summary line.
//
// The rule is deliberately an ignore list rather than an allow-list: an
// extension is allowed to ship anything else it likes (templates, wasm, fonts,
// handler scripts), and only the known build inputs are dropped. The declared
// asset tree (`suwu.static`, i.e. dist/) is never in the skip list, so a built
// extension's payload comes through intact.
func SkipPayload(rel string) (reason string, skip bool) {
	rel = strings.TrimPrefix(path.Clean("/"+rel), "/")
	if rel == "" || rel == "." {
		return "", false
	}
	if strings.HasPrefix(rel, "..") {
		return "outside the item", true
	}
	for _, p := range payloadSkipPrefixes {
		// Both the directory itself ("node_modules", needed so a walk can skip
		// descending into it) and everything under it.
		if rel == strings.TrimSuffix(p, "/") || strings.HasPrefix(rel, p) {
			return strings.TrimSuffix(p, "/"), true
		}
	}
	base := path.Base(rel)
	if payloadSkipFiles[base] {
		return base, true
	}
	// Any remaining build config at any depth (a nested package for a worker,
	// for example) is still a build input.
	if strings.HasPrefix(base, "tsconfig.") && strings.HasSuffix(base, ".json") {
		return "tsconfig", true
	}
	return "", false
}

// PayloadIncluded reports whether rel is part of the install payload.
func PayloadIncluded(rel string) bool {
	_, skip := SkipPayload(rel)
	return !skip
}

// skipTally counts what the payload rule dropped, for the install summary.
type skipTally struct {
	files   int
	reasons map[string]int
}

func newSkipTally() *skipTally { return &skipTally{reasons: map[string]int{}} }

func (t *skipTally) add(reason string) {
	t.files++
	t.reasons[reason]++
}

func (t *skipTally) empty() bool { return t.files == 0 }

// String renders the tally for the summary line, e.g.
// "node_modules 1342, src 6, pnpm-lock.yaml 1".
func (t *skipTally) String() string {
	if t.files == 0 {
		return ""
	}
	// Stable order, biggest first.
	type kv struct {
		k string
		v int
	}
	var all []kv
	for k, v := range t.reasons {
		all = append(all, kv{k, v})
	}
	for i := 1; i < len(all); i++ {
		for j := i; j > 0 && (all[j].v > all[j-1].v || (all[j].v == all[j-1].v && all[j].k < all[j-1].k)); j-- {
			all[j], all[j-1] = all[j-1], all[j]
		}
	}
	parts := make([]string, 0, len(all))
	for _, e := range all {
		parts = append(parts, fmt.Sprintf("%s %d", e.k, e.v))
	}
	return strings.Join(parts, ", ")
}
