package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"suwu/pkg/bindir"
	"suwu/pkg/tools"
)

// installFakeTool writes a script and a stamp into the data dir's bin directory.
func installFakeTool(t *testing.T, dataDir, name, version, body string) string {
	t.Helper()
	bin, err := bindir.Ensure(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(bin, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	stamp := tools.Stamp{
		Schema: tools.StampSchema, Name: name, Version: version,
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH, Origin: tools.OriginTools,
		Files: []tools.StampFile{{File: name, Mode: "0755"}},
	}
	data, err := json.Marshal(stamp)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(bindir.StampDir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bindir.StampPath(bin, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// The managed copy wins, and PATH is only consulted with --system: an agent that
// calls `suwu exec rg` must not get whatever happens to be first on PATH.
func TestResolveExecTargetPrefersTheManagedCopy(t *testing.T) {
	dataDir := t.TempDir()
	pathDir := t.TempDir()
	// A same-named script earlier on PATH must lose.
	system := filepath.Join(pathDir, "rg")
	if err := os.WriteFile(system, []byte("#!/bin/sh\necho system\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", pathDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	if _, ok := resolveExecTarget(dataDir, "rg", false); ok {
		t.Fatal("resolved something before it was installed")
	}
	managed := installFakeTool(t, dataDir, "rg", "15.2.0", "#!/bin/sh\necho managed\n")

	got, ok := resolveExecTarget(dataDir, "rg", false)
	if !ok || got != managed {
		t.Fatalf("got %q ok=%v, want the managed copy %q", got, ok, managed)
	}
	got, ok = resolveExecTarget(dataDir, "rg", true)
	if !ok || got != managed {
		t.Fatalf("--system should still prefer the managed copy, got %q", got)
	}
	// With --system and nothing managed, PATH answers.
	got, ok = resolveExecTarget(dataDir, "definitely-not-managed", true)
	if ok {
		t.Fatalf("unexpected resolution %q", got)
	}

	// A non-executable file is not a tool.
	os.Chmod(managed, 0o644)
	if _, ok := resolveExecTarget(dataDir, "rg", false); ok {
		t.Fatal("a non-executable file resolved")
	}
}

func TestExecPathAndListDoNotExecute(t *testing.T) {
	dataDir := t.TempDir()
	managed := installFakeTool(t, dataDir, "rg", "15.2.0", "#!/bin/sh\nexit 9\n")

	var out bytes.Buffer
	stdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	code := execMain([]string{"--data-dir", dataDir, "--path", "rg"})
	_ = w.Close()
	os.Stdout = stdout
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if _, err := out.ReadFrom(r); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != managed {
		t.Fatalf("--path printed %q", out.String())
	}

	out.Reset()
	r, w, _ = os.Pipe()
	os.Stdout = w
	code = execMain([]string{"--data-dir", dataDir, "--list"})
	_ = w.Close()
	os.Stdout = stdout
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if _, err := out.ReadFrom(r); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "rg\t15.2.0\t") {
		t.Fatalf("--list printed %q", out.String())
	}
}

func TestExecMissingToolExits127(t *testing.T) {
	dataDir := t.TempDir()
	if code := execMain([]string{"--data-dir", dataDir, "nope"}); code != 127 {
		t.Fatalf("exit %d, want 127", code)
	}
}

func TestExecFlagParsingStopsAtTheTool(t *testing.T) {
	dataDir := t.TempDir()
	// `-n` and `--json` belong to the tool, not to suwu: nothing after the tool
	// name is parsed. A missing tool + 127 proves we got that far without a
	// usage error.
	if code := execMain([]string{"--data-dir", dataDir, "nope", "-n", "--json"}); code != 127 {
		t.Fatalf("exit %d, want 127", code)
	}
	if code := execMain([]string{"--data-dir", dataDir, "--", "-weird-name"}); code != 127 {
		t.Fatalf("exit %d, want 127", code)
	}
	if code := execMain([]string{"--bogus"}); code != 64 {
		t.Fatalf("exit %d, want 64", code)
	}
	if code := execMain(nil); code != 64 {
		t.Fatalf("exit %d, want 64", code)
	}
}

func TestWithBinPath(t *testing.T) {
	dir := filepath.Join(string(os.PathSeparator), "managed", "bin")
	sep := string(os.PathListSeparator)
	got := withBinPath([]string{"HOME=/x", "PATH=/usr/bin"}, dir)
	if !containsStr(got, "PATH="+dir+sep+"/usr/bin") {
		t.Fatalf("PATH not prefixed: %v", got)
	}
	// Already there: no duplicate entry.
	got = withBinPath([]string{"PATH=" + dir + sep + "/usr/bin"}, dir)
	if !containsStr(got, "PATH="+dir+sep+"/usr/bin") {
		t.Fatalf("PATH rewritten needlessly: %v", got)
	}
	// No PATH at all still yields one.
	got = withBinPath([]string{"HOME=/x"}, dir)
	if !containsStr(got, "PATH="+dir) {
		t.Fatalf("PATH not created: %v", got)
	}
}

func TestToolsUsageIsAPathNotADownload(t *testing.T) {
	if code := toolsMain(nil); code != 64 {
		t.Fatalf("exit %d", code)
	}
	if code := toolsMain([]string{"nonsense"}); code != 64 {
		t.Fatalf("exit %d", code)
	}
}

func TestToolsPathIsNotOptional(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte("export EDITOR=vim\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	// There is no enable/disable switch: the command always ensures the block
	// naming the managed directory.
	if code := toolsPath([]string{"--data-dir", dataDir}); code != 0 {
		t.Fatalf("path exit %d", code)
	}
	body, _ := os.ReadFile(filepath.Join(home, ".bashrc"))
	if !strings.Contains(string(body), bindir.ToolsBlock.Start) || !strings.Contains(string(body), bindir.Dir(dataDir)) {
		t.Fatalf("block missing:\n%s", body)
	}
	// Idempotent: a second run neither duplicates the block nor loses content.
	if code := toolsPath([]string{"--data-dir", dataDir}); code != 0 {
		t.Fatalf("second path exit %d", code)
	}
	body, _ = os.ReadFile(filepath.Join(home, ".bashrc"))
	if strings.Count(string(body), bindir.ToolsBlock.Start) != 1 {
		t.Fatalf("duplicate block:\n%s", body)
	}
	if !strings.Contains(string(body), "export EDITOR=vim") {
		t.Fatal("unrelated content lost")
	}
	// The old opt-out must not silently keep working.
	if code := toolsPath([]string{"--disable", "--data-dir", dataDir}); code != 64 {
		t.Fatalf("removed --disable: exit %d", code)
	}
}

func TestStateLabels(t *testing.T) {
	cases := map[tools.State]string{
		tools.StateInstalled:   "installed",
		tools.StateUpdate:      "update",
		tools.StateMissing:     "available",
		tools.StateUnsupported: "not for this platform",
		tools.StateUnmanaged:   "unmanaged file",
		tools.StateManual:      "manual install",
	}
	for state, want := range cases {
		if got := stateLabel(tools.Status{State: state}); got != want {
			t.Errorf("%s: %q, want %q", state, got, want)
		}
	}
}

func containsStr(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
