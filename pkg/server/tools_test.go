package server

// Tests for /api/tools: the list (catalog ∪ installed, per-platform states), the
// install/uninstall actions, the always-on PATH block and the optional shell
// setups. The installer itself is
// covered in pkg/tools; here the contract with the browser is what matters —
// authentication, status codes, and that a failed install leaves no stamp.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"suwu/pkg/bindir"
	"suwu/pkg/tools"
)

func postJSON(t *testing.T, url string, body any) (int, map[string]any) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func getTools(t *testing.T, base, query string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(base + "/api/tools" + query)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var out map[string]any
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatalf("decode: %v", err)
		}
	}
	return resp.StatusCode, out
}

func toolByName(body map[string]any, name string) map[string]any {
	items, _ := body["tools"].([]any)
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m["name"] == name {
			return m
		}
	}
	return nil
}

// stageFakeTool installs a tool through pkg/tools so the API sees a real stamp.
func stageFakeTool(t *testing.T, dataDir, name, version string) {
	t.Helper()
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, name), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	spec := tools.Spec{
		Name: name, Version: version, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		Entries: []tools.Entry{{File: name, Mode: "0755"}},
	}
	if _, err := tools.InstallFromFiles(spec, tools.Options{DataDir: dataDir}, src); err != nil {
		t.Fatal(err)
	}
}

func TestToolsListRequiresAuth(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	if status, _ := getTools(t, ts.URL, ""); status != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", status)
	}
}

func TestToolsListReportsEveryState(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)
	// The catalog's own version for fzf, whatever it is: hard-coding one makes
	// this test fail on every bump instead of on a real regression.
	_, before := getTools(t, ts.URL, "?token=testtoken")
	fzfRow := toolByName(before, "fzf")
	catalogVersion, _ := fzfRow["version"].(string)
	stageFakeTool(t, dataDir, "fzf", catalogVersion) // matches the catalog
	stageFakeTool(t, dataDir, "rg", "0.0.0")         // older than the catalog
	// An unmanaged file with a catalog name.
	bin, err := bindir.Ensure(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "asdf"), []byte("hand made"), 0o755); err != nil {
		t.Fatal(err)
	}

	status, body := getTools(t, ts.URL, "?token=testtoken")
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	if body["binDir"] != bin {
		t.Errorf("binDir %v, want %s", body["binDir"], bin)
	}
	if body["os"] != runtime.GOOS || body["arch"] != runtime.GOARCH {
		t.Errorf("platform %v/%v", body["os"], body["arch"])
	}
	if fzf := toolByName(body, "fzf"); fzf["state"] != "installed" {
		t.Errorf("fzf state %v", fzf["state"])
	}
	if rg := toolByName(body, "rg"); rg["state"] != "update" {
		t.Errorf("rg state %v", rg["state"])
	}
	if asdf := toolByName(body, "asdf"); asdf["state"] != "unmanaged" {
		t.Errorf("asdf state %v", asdf["state"])
	}
	if pig := toolByName(body, "pig"); pig["state"] != "missing" {
		t.Errorf("pig state %v", pig["state"])
	}
	// The page needs the catalog metadata to render a row.
	if rg := toolByName(body, "rg"); rg["homepage"] == "" || rg["license"] == "" || rg["summary"] == "" {
		t.Errorf("rg row is missing catalog metadata: %v", rg)
	}
	// A platform the catalog does not cover is reported, not hidden.
	if runtime.GOOS != "linux" {
		if witr := toolByName(body, "witr"); witr["state"] != "unsupported" || witr["available"] != false {
			t.Errorf("witr row %v", witr)
		}
	}
	// The install button needs a URL and an archive kind.
	if rg := toolByName(body, "rg"); rg["available"] != true || rg["url"] == "" || rg["archive"] == "" {
		t.Errorf("rg row is not installable: %v", rg)
	}
}

func TestToolsInstallRejectsUnknownAndUnsupported(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	status, body := postJSON(t, ts.URL+"/api/tools/install?token=testtoken", map[string]any{"name": "nope"})
	if status != http.StatusNotFound {
		t.Fatalf("status %d (%v)", status, body)
	}
	if status, _ := postJSON(t, ts.URL+"/api/tools/install?token=testtoken", map[string]any{}); status != http.StatusBadRequest {
		t.Fatalf("empty name: status %d", status)
	}
	if status, _ := postJSON(t, ts.URL+"/api/tools/install?token=testtoken", map[string]any{"name": "../rg"}); status != http.StatusNotFound {
		t.Fatalf("traversing name: status %d", status)
	}
}

func TestToolsInstallRequiresAuth(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	if status, _ := postJSON(t, ts.URL+"/api/tools/install", map[string]any{"name": "rg"}); status != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", status)
	}
}

func TestToolsUninstallRemovesAStampedTool(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)
	stageFakeTool(t, dataDir, "rg", "15.2.0")

	status, body := postJSON(t, ts.URL+"/api/tools/uninstall?token=testtoken", map[string]any{"name": "rg"})
	if status != http.StatusOK {
		t.Fatalf("status %d (%v)", status, body)
	}
	removed, _ := body["removed"].([]any)
	if len(removed) != 1 || removed[0] != "rg" {
		t.Fatalf("removed %v", removed)
	}
	if _, err := os.Stat(filepath.Join(bindir.Dir(dataDir), "rg")); !os.IsNotExist(err) {
		t.Fatal("rg is still there")
	}
	// A second uninstall is a conflict, not a silent success.
	if status, _ := postJSON(t, ts.URL+"/api/tools/uninstall?token=testtoken", map[string]any{"name": "rg"}); status != http.StatusConflict {
		t.Fatalf("second uninstall: status %d", status)
	}
}

func TestToolsPathIsAlwaysOn(t *testing.T) {
	_, _, dataDir := extTestServerDir(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte("export EDITOR=vim\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The directory must exist before the block is written; the server calls
	// this at startup and after every successful install.
	stageFakeTool(t, dataDir, "rg", "15.2.0")
	ensureToolsPath(dataDir)
	rc, _ := os.ReadFile(filepath.Join(home, ".bashrc"))
	if !strings.Contains(string(rc), bindir.ToolsBlock.Start) || !strings.Contains(string(rc), bindir.Dir(dataDir)) {
		t.Fatalf("block missing:\n%s", rc)
	}
	// The list reports it, so the page renders a notice rather than a toggle.
	ts, _, _ := extTestServerDir(t, nil)
	_, list := getTools(t, ts.URL, "?token=testtoken")
	path, _ := list["path"].(map[string]any)
	if path["enabled"] != true {
		t.Fatalf("list does not report the block: %v", path)
	}
}

func TestToolsSetupToggle(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte("export EDITOR=vim\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Only fzf and asdf have shell setup; anything else is a 404.
	if status, _ := postJSON(t, ts.URL+"/api/tools/setup?token=testtoken", map[string]any{"name": "rg", "enabled": true}); status != http.StatusNotFound {
		t.Fatalf("rg setup: status %d", status)
	}
	status, body := postJSON(t, ts.URL+"/api/tools/setup?token=testtoken", map[string]any{"name": "fzf", "enabled": true})
	if status != http.StatusOK || body["enabled"] != true {
		t.Fatalf("enable: %d %v", status, body)
	}
	rc, _ := os.ReadFile(filepath.Join(home, ".bashrc"))
	if !strings.Contains(string(rc), bindir.FzfBlock.Start) || !strings.Contains(string(rc), `eval "$(fzf --bash)"`) {
		t.Fatalf("fzf block missing:\n%s", rc)
	}
	_, list := getTools(t, ts.URL, "?token=testtoken")
	setup, _ := list["setup"].(map[string]any)
	fzf, _ := setup["fzf"].(map[string]any)
	if fzf["enabled"] != true {
		t.Fatalf("list does not report the fzf setup: %v", fzf)
	}

	status, body = postJSON(t, ts.URL+"/api/tools/setup?token=testtoken", map[string]any{"name": "fzf", "enabled": false})
	if status != http.StatusOK || body["enabled"] != false {
		t.Fatalf("disable: %d %v", status, body)
	}
	rc, _ = os.ReadFile(filepath.Join(home, ".bashrc"))
	if strings.Contains(string(rc), bindir.FzfBlock.Start) {
		t.Fatalf("fzf block not removed:\n%s", rc)
	}
	if !strings.Contains(string(rc), "export EDITOR=vim") {
		t.Fatal("unrelated content lost")
	}
}

func TestToolsMethodsArePost(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	resp, err := http.Get(ts.URL + "/api/tools/install?token=testtoken")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestToolsListSurvivesAnUnreachableCatalog(t *testing.T) {
	// Point the catalog at an address nothing listens on: the test must not
	// depend on whether tools/catalog.json is published yet.
	t.Setenv(tools.RawBaseEnv, "http://127.0.0.1:1")
	ts, _, _ := extTestServerDir(t, nil)
	// The list must still answer, from the embedded catalog, and say it is not
	// fresh.
	status, body := getTools(t, ts.URL, "?token=testtoken")
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	source, _ := body["source"].(map[string]any)
	if source["stale"] != true {
		t.Fatalf("expected a stale catalog, got %v", source)
	}
	if toolByName(body, "rg") == nil {
		t.Fatal("the embedded catalog produced no rg row")
	}
}

// A Go nil slice marshals to JSON `null`, and the page reads `.length` (and
// joins) these arrays — which is how an empty rc state crashed the Tools tab.
// The API must always answer with arrays.
func TestToolsArraysAreNeverNull(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home) // no rc file has the block

	_, body := getTools(t, ts.URL, "?token=testtoken")
	path, _ := body["path"].(map[string]any)
	if files, ok := path["files"].([]any); !ok || files == nil {
		t.Fatalf("path.files is not an array: %#v", path["files"])
	}
	for _, name := range []string{"tools", "path", "setup"} {
		if raw, exists := body[name]; !exists || raw == nil {
			t.Errorf("%s is null", name)
		}
	}

	// The setup action answers with arrays too, on both directions.
	for _, enabled := range []bool{true, false} {
		status, out := postJSON(t, ts.URL+"/api/tools/setup?token=testtoken", map[string]any{"name": "asdf", "enabled": enabled})
		if status != http.StatusOK {
			t.Fatalf("enabled=%v: status %d (%v)", enabled, status, out)
		}
		if _, ok := out["files"].([]any); !ok {
			t.Errorf("enabled=%v: files is not an array: %#v", enabled, out["files"])
		}
		if _, ok := out["changed"].([]any); !ok {
			t.Errorf("enabled=%v: changed is not an array: %#v", enabled, out["changed"])
		}
	}
}

// The stale answer must carry the reason, so the page can tell "no network"
// from "this build cannot read that catalog" — the second one bit a released
// binary reading master's catalog.
func TestToolsListReportsWhyTheCatalogIsStale(t *testing.T) {
	t.Setenv(tools.RawBaseEnv, "http://127.0.0.1:1")
	ts, _, _ := extTestServerDir(t, nil)
	_, body := getTools(t, ts.URL, "?token=testtoken&refresh=1")
	source, _ := body["source"].(map[string]any)
	if source["stale"] != true {
		t.Fatalf("expected stale, got %v", source)
	}
	reason, _ := source["error"].(string)
	if reason == "" || !strings.Contains(reason, "fetch catalog") {
		t.Fatalf("no reason in the stale source: %v", source)
	}
}

// Tools Suwu cannot install still appear on the screen: detection plus the
// command to run, and no install action.
func TestToolsListIncludesManualTools(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	status, body := getTools(t, ts.URL, "?token=testtoken")
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	for _, name := range []string{"git", "vim", "nodejs", "pnpm", "pi", "opencode"} {
		row := toolByName(body, name)
		if row == nil {
			t.Errorf("%s is missing from the tools list", name)
			continue
		}
		if row["manual"] != true {
			t.Errorf("%s manual = %v, want true", name, row["manual"])
		}
		if row["available"] != false {
			t.Errorf("%s available = %v, want false", name, row["available"])
		}
		if instruction, _ := row["instruction"].(string); instruction == "" {
			t.Errorf("%s has no instruction", name)
		}
	}
}
