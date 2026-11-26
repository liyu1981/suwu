package tools

import (
	"runtime"
	"strings"
	"testing"
)

// The shipped catalog is the thing every other test and every release depends
// on, so it earns a test of its own: parse it, and check the invariants the
// installer relies on that a JSON schema cannot express.
func TestBuiltinCatalog(t *testing.T) {
	c, err := Builtin()
	if err != nil {
		t.Fatalf("embedded catalog does not validate: %v", err)
	}
	for _, name := range []string{"rg", "fzf", "asdf", "pig", "herdr", "herdr-core"} {
		if _, ok := c.Find(name); !ok {
			t.Errorf("catalog is missing %q", name)
		}
	}
	// rg is what /api/files/search needs, so it must ship everywhere Suwu does.
	rg, _ := c.Find("rg")
	for _, key := range []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"} {
		if _, ok := rg.Platforms[key]; !ok {
			t.Errorf("rg has no %s asset", key)
		}
	}
	// A tool with no asset for this machine must still parse — that is how the
	// page says "not available here" instead of offering a broken download.
	witr, ok := c.Find("witr")
	if !ok {
		t.Fatal("catalog is missing witr")
	}
	if _, ok := witr.Platforms[PlatformKey(runtime.GOOS, runtime.GOARCH)]; !ok && runtime.GOOS != "linux" {
		t.Logf("witr correctly has no %s asset", PlatformKey(runtime.GOOS, runtime.GOARCH))
	}
}

func TestParseRejectsHostileCatalogs(t *testing.T) {
	valid := `{"schema":1,"tools":[{"name":"rg","version":"1.0.0",
		"platforms":{"linux-amd64":{"archive":"none","url":"https://example.test/rg",
		"sha256":"` + strings.Repeat("a", 64) + `","strip":0,
		"entries":[{"file":"rg","mode":"0755"}]}}}]}`

	if _, err := Parse([]byte(valid)); err != nil {
		t.Fatalf("valid catalog rejected: %v", err)
	}

	cases := map[string]string{
		"schema":         strings.Replace(valid, `"schema":1`, `"schema":2`, 1),
		"http url":       strings.Replace(valid, "https://example.test/rg", "http://example.test/rg", 1),
		"short sha":      strings.Replace(valid, strings.Repeat("a", 64), "abc", 1),
		"traversal":      strings.Replace(valid, `"file":"rg"`, `"file":"../rg"`, 1),
		"absolute":       strings.Replace(valid, `"file":"rg"`, `"file":"/usr/bin/rg"`, 1),
		"metadata dir":   strings.Replace(valid, `"file":"rg"`, `"file":".tools/rg.json"`, 1),
		"setuid":         strings.Replace(valid, `"mode":"0755"`, `"mode":"4755"`, 1),
		"world-writable": strings.Replace(valid, `"mode":"0755"`, `"mode":"0777"`, 1),
		"bad name":       strings.Replace(valid, `"name":"rg"`, `"name":"../rg"`, 1),
		"bad platform":   strings.Replace(valid, `"linux-amd64"`, `"linux-386"`, 1),
		"bad archive":    strings.Replace(valid, `"archive":"none"`, `"archive":"rar"`, 1),
		"no entries":     strings.Replace(valid, `[{"file":"rg","mode":"0755"}]`, `[]`, 1),
		"bare strip":     strings.Replace(valid, `"strip":0`, `"strip":1`, 1),
	}
	for name, body := range cases {
		if _, err := Parse([]byte(body)); err == nil {
			t.Errorf("%s: catalog accepted, want an error", name)
		}
	}
}

func TestParseRejectsDuplicateOwnership(t *testing.T) {
	platform := func(name string) string {
		return `{"archive":"none","url":"https://example.test/` + name + `",
			"sha256":"` + strings.Repeat("a", 64) + `","strip":0,
			"entries":[{"file":"` + name + `","mode":"0755"}]}`
	}
	// Two tools claiming the same file would make install order decide which
	// binary wins; the catalog is refused instead.
	body := `{"schema":1,"tools":[
		{"name":"a","version":"1","platforms":{"linux-amd64":` + platform("a") + `}},
		{"name":"b","version":"1","platforms":{"linux-amd64":{"archive":"none",
			"url":"https://example.test/b","sha256":"` + strings.Repeat("b", 64) + `","strip":0,
			"entries":[{"file":"a","mode":"0755"}]}}}]}`
	if _, err := Parse([]byte(body)); err == nil || !strings.Contains(err.Error(), "also owned by a") {
		t.Fatalf("duplicate ownership: got %v, want a collision error", err)
	}
}

func TestBundledSelection(t *testing.T) {
	c, err := Builtin()
	if err != nil {
		t.Fatal(err)
	}
	max := c.Bundled(BundledMax)
	if len(max) < 5 {
		t.Fatalf("want the bundle tools, got %d", len(max))
	}
	for _, t2 := range max {
		if t2.Name == "herdr-core" {
			t.Error("herdr-core belongs to the binary payload, not suwu-max")
		}
	}
	hc := c.Bundled(BundledHCBin)
	if len(hc) != 1 || hc[0].Name != "herdr-core" {
		t.Fatalf("want exactly herdr-core in hcbin, got %v", hc)
	}
}

// The non-installable tools live in the same catalog file, so an edit that
// forgets the instruction or the detection rule is caught here.
func TestBuiltinManualTools(t *testing.T) {
	c, err := Builtin()
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]ManualTool{}
	for _, m := range c.Manual {
		byName[m.Name] = m
	}
	for _, name := range []string{"git", "vim", "nodejs", "pnpm", "pi", "opencode"} {
		m, ok := byName[name]
		if !ok {
			t.Errorf("catalog manual list is missing %s", name)
			continue
		}
		if m.Command == "" || m.CheckBinary == "" {
			t.Errorf("%s: command=%q check_binary=%q", name, m.Command, m.CheckBinary)
		}
	}
}

func TestParseRejectsBadManualTools(t *testing.T) {
	valid := `{"schema":1,"tools":[{"name":"rg","version":"1","platforms":{
		"linux-amd64":{"archive":"none","url":"https://example.test/rg",
		"sha256":"` + strings.Repeat("a", 64) + `","strip":0,
		"entries":[{"file":"rg","mode":"0755"}]}}}],
		"manual":[{"name":"git","check_binary":"git","command":"apt install git"}]}`
	if _, err := Parse([]byte(valid)); err != nil {
		t.Fatalf("valid manual entry rejected: %v", err)
	}
	cases := map[string]string{
		"no command": strings.Replace(valid, `"command":"apt install git"`, `"command":""`, 1),
		"no check":   strings.Replace(valid, `"check_binary":"git",`, ``, 1),
		"bad name":   strings.Replace(valid, `"name":"git"`, `"name":"../git"`, 1),
		"collides":   strings.Replace(valid, `"name":"git"`, `"name":"rg"`, 1),
		"path check": strings.Replace(valid, `"check_binary":"git"`, `"check_binary":"../git"`, 1),
	}
	for name, body := range cases {
		if _, err := Parse([]byte(body)); err == nil {
			t.Errorf("%s: catalog accepted, want an error", name)
		}
	}
}
