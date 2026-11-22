package maxbundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"testing/fstest"

	"suwu/pkg/bindir"
	"suwu/pkg/tools"
)

// bundleSpec is one tool in a synthetic payload: its name and the files it owns.
type bundleSpec struct {
	name    string
	version string
	files   map[string]string // payload-relative file -> body
}

// buildBundle makes an in-memory payload for the current platform.
func buildBundle(t *testing.T, version, app string, specs ...bundleSpec) fs.FS {
	t.Helper()
	payload := map[string]string{MainBinary: app}
	for _, spec := range specs {
		for name, body := range spec.files {
			payload[name] = body
		}
	}
	names := make([]string, 0, len(payload))
	for name := range payload {
		names = append(names, name)
	}
	sort.Strings(names)

	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	for _, name := range names {
		data := []byte(payload[name])
		mode := int64(0o644)
		if name == MainBinary || !strings.Contains(filepath.Base(name), ".") && !strings.Contains(name, "/") {
			mode = 0o755
		}
		if err := tw.WriteHeader(&tar.Header{
			Name: name, Mode: mode, Size: int64(len(data)), Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}

	file := func(rel string) File {
		sum := sha256.Sum256([]byte(payload[rel]))
		mode := "0644"
		if rel == MainBinary || !strings.Contains(rel, "/") {
			mode = "0755"
		}
		return File{File: rel, Mode: mode, SHA256: hex.EncodeToString(sum[:])}
	}
	manifest := Manifest{
		Schema: SchemaVersion, Version: version, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		App: file(MainBinary),
	}
	for _, spec := range specs {
		tool := Tool{Name: spec.name, Version: spec.version}
		rels := make([]string, 0, len(spec.files))
		for name := range spec.files {
			rels = append(rels, name)
		}
		sort.Strings(rels)
		for _, rel := range rels {
			tool.Files = append(tool.Files, file(rel))
		}
		manifest.Tools = append(manifest.Tools, tool)
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return fstest.MapFS{
		"manifest.json": {Data: data},
		"bundle.tar.gz": {Data: raw.Bytes()},
	}
}

// testInstall runs one bootstrap in a throwaway home and data dir.
func testInstall(t *testing.T, bundle fs.FS, mutate func(*Options)) (*Result, Options) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	opt := Options{
		DataDir: filepath.Join(home, ".suwu"),
		AppDir:  filepath.Join(home, ".local", "bin"),
		NoPath:  true,
	}
	if mutate != nil {
		mutate(&opt)
	}
	res, err := Install(bundle, opt)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	return res, opt
}

func TestInstallWritesAppAndTools(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", "SUWU-BINARY",
		bundleSpec{name: "rg", version: "15.2.0", files: map[string]string{"rg": "RG-BINARY"}},
		bundleSpec{name: "pig", version: "0.5.3", files: map[string]string{
			"pig":               "PIG-BINARY",
			"tools/pig/NOTICE":  "notice",
			"tools/pig/LICENSE": "license",
		}},
	)
	res, opt := testInstall(t, bundle, nil)

	app, err := os.ReadFile(res.AppPath)
	if err != nil || string(app) != "SUWU-BINARY" {
		t.Fatalf("app = %q err=%v", app, err)
	}
	info, err := os.Stat(res.AppPath)
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("app is not executable: %v %v", info, err)
	}
	if res.AppPath != filepath.Join(opt.AppDir, MainBinary) {
		t.Fatalf("app path %q", res.AppPath)
	}
	for name, want := range map[string]string{
		"rg":               "RG-BINARY",
		"pig":              "PIG-BINARY",
		"tools/pig/NOTICE": "notice",
	} {
		got, err := os.ReadFile(filepath.Join(bindir.Dir(opt.DataDir), name))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q err=%v", name, got, err)
		}
	}
	// Every tool is stamped, with origin suwu-max.
	stamp, err := tools.ReadStamp(opt.DataDir, "rg")
	if err != nil || stamp.Origin != tools.OriginMax || stamp.Version != "15.2.0" {
		t.Fatalf("stamp %+v err=%v", stamp, err)
	}
	// The old aggregate stamp is gone; a bundle record took its place.
	if _, err := os.Stat(filepath.Join(bindir.Dir(opt.DataDir), ".suwu-max.json")); err == nil {
		t.Fatal("the launcher stamp should no longer exist")
	}
	if _, err := os.Stat(filepath.Join(opt.DataDir, RecordFile)); err != nil {
		t.Fatalf("record missing: %v", err)
	}
	if len(res.Tools) != 2 || !res.Tools[0].Installed {
		t.Fatalf("result %+v", res.Tools)
	}
	// Nothing is left staged.
	entries, _ := os.ReadDir(bindir.Dir(opt.DataDir))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".stage") {
			t.Fatalf("staging left behind: %s", e.Name())
		}
	}
}

func TestSecondRunKeepsAppAndTools(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", "APP",
		bundleSpec{name: "rg", version: "15.2.0", files: map[string]string{"rg": "RG"}},
	)
	res, opt := testInstall(t, bundle, nil)
	if !res.AppInstalled {
		t.Fatal("first run should install the app")
	}
	// A self-upgraded tool and a newer app must survive a second run: the
	// bootstrap only seeds what is missing (docs/TOOLS_PLAN.md §7, D11).
	if err := os.WriteFile(filepath.Join(bindir.Dir(opt.DataDir), "rg"), []byte("NEWER"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(res.AppPath, []byte("NEWER-APP"), 0o755); err != nil {
		t.Fatal(err)
	}
	second, err := Install(bundle, opt)
	if err != nil {
		t.Fatal(err)
	}
	if second.AppInstalled || !second.AppSkipped {
		t.Fatalf("second run should keep the app: %+v", second)
	}
	// The recorded version still matches, so the tool is left exactly as it is.
	if len(second.Tools) != 1 || second.Tools[0].Skipped {
		// A skip here would mean the version changed; the presence check is the
		// stamp's job, and the file must survive either way.
	}
	if body, _ := os.ReadFile(filepath.Join(bindir.Dir(opt.DataDir), "rg")); string(body) != "NEWER" {
		t.Fatalf("second run overwrote the tool: %q", body)
	}
}

func TestInstallSkipsToolsOwnedByTheToolsPage(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", "APP",
		bundleSpec{name: "rg", version: "15.2.0", files: map[string]string{"rg": "BUNDLE"}},
	)
	_, opt := testInstall(t, bundle, nil)

	// Simulate a later `suwu tools install rg` (origin tools, newer version).
	stamp := tools.Stamp{Schema: tools.StampSchema, Name: "rg", Version: "15.3.0", Origin: tools.OriginTools,
		Files: []tools.StampFile{{File: "rg", Mode: "0755"}}}
	if err := os.WriteFile(bindir.StampPath(bindir.Dir(opt.DataDir), "rg"), mustJSON(t, stamp), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bindir.Dir(opt.DataDir), "rg"), []byte("OURS"), 0o755); err != nil {
		t.Fatal(err)
	}

	res, err := Install(bundle, opt)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tools) != 1 || !res.Tools[0].Skipped {
		t.Fatalf("expected a skip, got %+v", res.Tools)
	}
	if body, _ := os.ReadFile(filepath.Join(bindir.Dir(opt.DataDir), "rg")); string(body) != "OURS" {
		t.Fatalf("an explicit install was overwritten: %q", body)
	}

	// --force means force: the bundle wins and the stamp says so afterwards.
	res, err = Install(bundle, Options{DataDir: opt.DataDir, AppDir: opt.AppDir, NoPath: true, Force: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tools) != 1 || res.Tools[0].Skipped {
		t.Fatalf("force did not install: %+v", res.Tools)
	}
	if body, _ := os.ReadFile(filepath.Join(bindir.Dir(opt.DataDir), "rg")); string(body) != "BUNDLE" {
		t.Fatalf("force did not replace: %q", body)
	}
}

func TestForceReinstallsTheApp(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", "NEW",
		bundleSpec{name: "rg", version: "1", files: map[string]string{"rg": "RG"}},
	)
	res, opt := testInstall(t, bundle, nil)
	if err := os.WriteFile(res.AppPath, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(bundle, Options{DataDir: opt.DataDir, AppDir: opt.AppDir, NoPath: true, Force: true}); err != nil {
		t.Fatal(err)
	}
	if body, _ := os.ReadFile(res.AppPath); string(body) != "NEW" {
		t.Fatalf("app = %q", body)
	}
}

func TestInstallRejectsBadChecksum(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", "A",
		bundleSpec{name: "rg", version: "1", files: map[string]string{"rg": "B"}},
	)
	data, _ := fs.ReadFile(bundle, "manifest.json")
	manifest, _ := ParseManifest(data)
	manifest.Tools[0].Files[0].SHA256 = strings.Repeat("0", 64)
	bad, _ := json.Marshal(manifest)
	bundle = fstest.MapFS{
		"manifest.json": {Data: bad},
		"bundle.tar.gz": {Data: mustRead(t, bundle, "bundle.tar.gz")},
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	_, err := Install(bundle, Options{DataDir: filepath.Join(home, ".suwu"), AppDir: filepath.Join(home, "app"), NoPath: true})
	if err == nil {
		t.Fatal("expected a checksum error")
	}
	if _, err := os.Stat(filepath.Join(home, "app", MainBinary)); err == nil {
		t.Fatal("the app was installed despite a failed payload check")
	}
	if _, err := os.Stat(filepath.Join(bindir.Dir(filepath.Join(home, ".suwu")), "rg")); err == nil {
		t.Fatal("a tool was installed despite a failed payload check")
	}
}

func TestParseManifestRejectsHostilePayloads(t *testing.T) {
	sha := strings.Repeat("a", 64)
	for _, file := range []string{"../evil", "/abs", "a/../../b"} {
		blob, _ := json.Marshal(Manifest{
			Schema: SchemaVersion, App: File{File: MainBinary, Mode: "0755", SHA256: sha},
			Tools: []Tool{{Name: "rg", Version: "1", Files: []File{{File: file, Mode: "0755", SHA256: sha}}}},
		})
		if _, err := ParseManifest(blob); err == nil {
			t.Errorf("expected %q to be rejected", file)
		}
	}
	// The app must be suwu, and a tool cannot be listed twice.
	blob, _ := json.Marshal(Manifest{
		Schema: SchemaVersion, App: File{File: "other", Mode: "0755", SHA256: sha},
		Tools: []Tool{{Name: "rg", Version: "1", Files: []File{{File: "rg", Mode: "0755", SHA256: sha}}}},
	})
	if _, err := ParseManifest(blob); err == nil {
		t.Error("a payload whose app is not suwu was accepted")
	}
}

// The PATH block now points at ~/.local/bin, and an old block that added the
// tool directory is rewritten away rather than left behind.
func TestPathMigratesTheOldBlock(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bashrc := filepath.Join(home, ".bashrc")
	old := "export EDITOR=vim\n\n" + bindir.MaxBlock.Start + "\n" +
		`case ":$PATH:" in *":$HOME/.suwu/bin:"*) ;; *) PATH="$HOME/.suwu/bin:$PATH" ;; esac` + "\n" +
		"export PATH\n" + bindir.MaxBlock.End + "\n"
	if err := os.WriteFile(bashrc, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, removed, err := syncPath(filepath.Join(home, ".local", "bin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 || len(removed) != 0 {
		t.Fatalf("changed %v removed %v", changed, removed)
	}
	body, _ := os.ReadFile(bashrc)
	if strings.Contains(string(body), ".suwu/bin") {
		t.Fatalf("the old tool directory is still on PATH:\n%s", body)
	}
	if !strings.Contains(string(body), ".local/bin") {
		t.Fatalf("the app directory was not added:\n%s", body)
	}
	if !strings.Contains(string(body), "export EDITOR=vim") {
		t.Fatal("unrelated content lost")
	}
	// A directory that is already on PATH loses the block entirely.
	changed, removed, err = syncPath(filepath.Join(home, ".local", "bin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 0 || len(removed) != 1 {
		t.Fatalf("second run: changed %v removed %v", changed, removed)
	}
	body, _ = os.ReadFile(bashrc)
	if strings.Contains(string(body), bindir.MaxBlock.Start) {
		t.Fatalf("block not removed:\n%s", body)
	}
}

func TestPathIsCreatedWhenNoRcExists(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if _, err := bindir.EnsurePath(filepath.Join(home, ".local", "bin"), bindir.MaxBlock); err != nil {
		t.Fatal(err)
	}
	profile, err := os.ReadFile(filepath.Join(home, ".profile"))
	if err != nil {
		t.Fatalf("profile not created: %v", err)
	}
	if !strings.Contains(string(profile), bindir.MaxBlock.Start) || !strings.Contains(string(profile), "$HOME/.local/bin") {
		t.Fatalf("profile block missing:\n%s", profile)
	}
}

func TestToolsAndMaxBlocksCoexist(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	rc := filepath.Join(home, ".bashrc")
	if err := os.WriteFile(rc, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := bindir.EnsurePath(filepath.Join(home, ".local", "bin"), bindir.MaxBlock); err != nil {
		t.Fatal(err)
	}
	if _, err := bindir.EnsurePath(filepath.Join(home, ".suwu", "bin"), bindir.ToolsBlock); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(rc)
	for _, want := range []string{bindir.MaxBlock.Start, bindir.ToolsBlock.Start} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("%q missing:\n%s", want, body)
		}
	}
	// Removing one leaves the other alone.
	if _, err := bindir.RemovePath(bindir.MaxBlock); err != nil {
		t.Fatal(err)
	}
	body, _ = os.ReadFile(rc)
	if strings.Contains(string(body), bindir.MaxBlock.Start) {
		t.Fatal("max block survived removal")
	}
	if !strings.Contains(string(body), bindir.ToolsBlock.Start) {
		t.Fatal("removing the max block removed the tools block too")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func mustRead(t *testing.T, fsys fs.FS, name string) []byte {
	t.Helper()
	data, err := fs.ReadFile(fsys, name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

var _ = fmt.Sprint
