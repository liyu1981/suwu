package install

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/extension"
)

// writeTree creates files under dir from a relpath→content map.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// builtExtensionTree is a realistic post-build layout: a Vite project whose
// payload is package.json + index.js + dist/.
func builtExtensionTree(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"package.json": `{"name":"suwu-demo","private":true,"scripts":{"build":"vite build"},` +
			`"suwu":{"name":"Demo","description":"demo tile","version":"1.0.0","static":"dist"}}`,
		"index.js":                    `function handler(){return "page"}`,
		"save.js":                     `function handler(){return "ok"}`,
		"README.md":                   "# Demo",
		"dist/.vite/manifest.json":    `{"index.js":{"file":"assets/app.js","isEntry":true}}`,
		"dist/assets/app-abc123.js":   "export const x = 1;",
		"dist/assets/app-abc123.css":  "body{}",
		"dist/fonts/Excalifont.woff2": "wOF2",
		"src/main.js":                 "import './style.css';",
		"src/style.css":               "body{}",
		"node_modules/react/index.js": "module.exports={}",
		"node_modules/.bin/vite":      "#!/bin/sh",
		"vite.config.ts":              "export default {}",
		"tsconfig.json":               "{}",
		"pnpm-lock.yaml":              "lockfileVersion: 9",
		".gitignore":                  "dist\n",
	})
	return dir
}

func TestSkipPayload(t *testing.T) {
	keep := []string{
		"package.json", "index.js", "save.js", "README.md", "LICENSE",
		"THIRD_PARTY_NOTICES",
		"dist/assets/app-abc123.js", "dist/fonts/Excalifont.woff2",
		"dist/.vite/manifest.json", // read at render time by index.js
		"public/page.css",          // source-only extensions still ship public/
		"test/commands.test.mjs",
	}
	for _, rel := range keep {
		if reason, skip := SkipPayload(rel); skip {
			t.Errorf("SkipPayload(%q) = skipped (%s), want kept", rel, reason)
		}
	}

	drop := map[string]string{
		"node_modules/react/index.js": "node_modules",
		"node_modules":                "node_modules",
		"src/main.js":                 "src",
		".git/config":                 ".git",
		"pnpm-lock.yaml":              "pnpm-lock.yaml",
		"package-lock.json":           "package-lock.json",
		"tsconfig.json":               "tsconfig.json",

		"vite.config.ts": "vite.config.ts",
		".gitignore":     ".gitignore",
	}
	for rel, wantReason := range drop {
		reason, skip := SkipPayload(rel)
		if !skip {
			t.Errorf("SkipPayload(%q) = kept, want skipped", rel)
			continue
		}
		if reason != wantReason {
			t.Errorf("SkipPayload(%q) reason = %q, want %q", rel, reason, wantReason)
		}
	}
}

func TestFromLocalDirStagesPayload(t *testing.T) {
	src := builtExtensionTree(t)
	dataDir := t.TempDir()

	item, err := FromLocalDir(src, LocalOptions{Options: Options{DataDir: dataDir}})
	if err != nil {
		t.Fatal(err)
	}
	if item.ID != filepath.Base(src) {
		t.Errorf("id = %q, want the directory name", item.ID)
	}
	if item.Name != "Demo" {
		t.Errorf("name = %q, want Demo (from suwu.name)", item.Name)
	}

	root := filepath.Join(extension.Dir(dataDir), item.ID)
	for _, want := range []string{
		"package.json", "index.js", "save.js", "README.md",
		"dist/assets/app-abc123.js", "dist/.vite/manifest.json", "dist/fonts/Excalifont.woff2",
	} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(want))); err != nil {
			t.Errorf("%s missing from the install: %v", want, err)
		}
	}
	for _, unwanted := range []string{"node_modules", "src", "vite.config.ts", "tsconfig.json", "pnpm-lock.yaml"} {
		if _, err := os.Stat(filepath.Join(root, unwanted)); err == nil {
			t.Errorf("%s must not be installed", unwanted)
		}
	}
	if !strings.Contains(item.Skipped, "node_modules") {
		t.Errorf("Skipped = %q, want it to mention node_modules", item.Skipped)
	}
}

// A built extension without its dist/ is the most common mistake; installing it
// anyway would leave a tile that renders nothing.
func TestFromLocalDirRequiresBuiltAssets(t *testing.T) {
	src := t.TempDir()
	writeTree(t, src, map[string]string{
		"package.json": `{"name":"suwu-demo","suwu":{"name":"Demo","static":"dist"}}`,
		"index.js":     `function handler(){return "page"}`,
		"src/main.js":  "import './x';",
	})
	dataDir := t.TempDir()

	_, err := FromLocalDir(src, LocalOptions{Options: Options{DataDir: dataDir}})
	if err == nil {
		t.Fatal("a missing suwu.static directory must fail the install")
	}
	if !strings.Contains(err.Error(), "build it first") {
		t.Errorf("error = %v, want a \"build it first\" hint", err)
	}
}

func TestFromLocalDirRejectsBadInput(t *testing.T) {
	dataDir := t.TempDir()

	t.Run("missing package.json", func(t *testing.T) {
		if _, err := FromLocalDir(t.TempDir(), LocalOptions{Options: Options{DataDir: dataDir}}); err == nil {
			t.Error("a directory without package.json must be refused")
		}
	})

	t.Run("missing index.js", func(t *testing.T) {
		dir := t.TempDir()
		writeTree(t, dir, map[string]string{"package.json": `{"name":"x"}`})
		if _, err := FromLocalDir(dir, LocalOptions{Options: Options{DataDir: dataDir}}); err == nil {
			t.Error("a directory without index.js must be refused")
		}
	})

	t.Run("symlink", func(t *testing.T) {
		dir := t.TempDir()
		writeTree(t, dir, map[string]string{"package.json": `{"name":"x"}`, "index.js": `x`})
		if err := os.Symlink("/etc/passwd", filepath.Join(dir, "leak.txt")); err != nil {
			t.Skip("symlinks unsupported here")
		}
		if _, err := FromLocalDir(dir, LocalOptions{Options: Options{DataDir: dataDir}}); err == nil {
			t.Error("a symlinked payload file must be refused")
		}
	})

	t.Run("invalid id", func(t *testing.T) {
		dir := t.TempDir()
		writeTree(t, dir, map[string]string{"package.json": `{"name":"x"}`, "index.js": `x`})
		if _, err := FromLocalDir(dir, LocalOptions{Options: Options{DataDir: dataDir}, ID: "../escape"}); err == nil {
			t.Error("an invalid id must be refused")
		}
	})
}

// The archive path must apply the same rule: an exporter that zips a project
// checkout should not install node_modules/.
func TestArchiveAppliesPayloadRule(t *testing.T) {
	dir := t.TempDir()
	dataDir := t.TempDir()
	zipPath := filepath.Join(dir, "demo.zip")
	// package.json + index.js must exist for Resolve; dist/ carries the payload.
	data, _ := buildZip(t, [][2]string{
		{"demo/package.json", `{"name":"suwu-demo","suwu":{"name":"Demo","static":"dist"}}`},
		{"demo/index.js", `function handler(){return "page"}`},
		{"demo/dist/assets/app.js", "export const x = 1;"},
		{"demo/node_modules/a/b.js", "module.exports={}"},
		{"demo/src/main.js", "import x"},
		{"demo/pnpm-lock.yaml", "lockfileVersion: 9"},
	})
	if err := os.WriteFile(zipPath, data, 0o644); err != nil {
		t.Fatal(err)
	}

	item, err := FromArchiveFile(KindExtension, zipPath, Options{DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(extension.Dir(dataDir), "demo")
	if _, err := os.Stat(filepath.Join(root, "dist", "assets", "app.js")); err != nil {
		t.Errorf("dist payload missing: %v", err)
	}
	for _, unwanted := range []string{"node_modules", "src", "pnpm-lock.yaml"} {
		if _, err := os.Stat(filepath.Join(root, unwanted)); err == nil {
			t.Errorf("%s must not be installed from an archive", unwanted)
		}
	}
	if !strings.Contains(item.Skipped, "node_modules") {
		t.Errorf("Skipped = %q", item.Skipped)
	}
}
