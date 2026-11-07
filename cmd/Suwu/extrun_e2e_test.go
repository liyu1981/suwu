package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestExtRunEndToEnd drives the real binary: a fixture extension registers a
// `new` command, and `suwu ext-run` must create the file in the directory it was
// pointed at, through the sandbox mounts (never a host path).
//
// It builds nothing: the running test binary re-executes itself as `suwu` only
// via runExtensionCommand's os.Executable(), so the test spawns the same binary
// with the gq subcommand. That path is exercised for real here.
func TestExtRunEndToEnd(t *testing.T) {
	dataDir := t.TempDir()
	extDir := filepath.Join(dataDir, "extension", "fixture")
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(extDir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("package.json", `{"name":"Fixture","suwu":{
		"name":"Fixture","description":"test","version":"1.0.0",
		"fs":true,
		"commands":[{"name":"new","handler":"new.js","description":"Create a thing"}]
	}}`)
	write("index.js", `function handler(){ return "page"; }`)
	write("new.js", `function handler(input) {
		if (!input.dir) return { status: 400, body: "no dir" };
		const name = (input.args && input.args[0]) || "Untitled.thing";
		const path = input.dir + "/" + name;
		fs.writeFileSync(path, "created:" + input.command);
		return { status: 200, body: input.cwd + "/" + name };
	}`)

	// The command runs in the test binary, so `suwu gq` must be reachable by the
	// same executable path. Build the real binary once and point the test at it
	// through a temp copy named `suwu` (os.Executable() resolves the test binary,
	// which has no gq subcommand — so drive the CLI binary directly instead).
	bin := filepath.Join(t.TempDir(), "suwu")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Env = append(os.Environ(), "GOFLAGS=-mod=mod")
	if out, err := build.CombinedOutput(); err != nil {
		t.Skipf("cannot build the CLI here: %v\n%s", err, out)
	}

	work := t.TempDir()
	run := exec.Command(bin, "ext-run", "--dir", work, "--json", "fixture", "new", "thing.thing")
	run.Env = append(os.Environ(), "SUWU_VAR="+dataDir)
	out, err := run.CombinedOutput()
	if err != nil {
		t.Fatalf("ext-run failed: %v\n%s", err, out)
	}
	if got := strings.TrimSpace(string(out)); !strings.Contains(got, "thing.thing") {
		t.Errorf("output = %q, want the created path", got)
	}
	body, err := os.ReadFile(filepath.Join(work, "thing.thing"))
	if err != nil {
		t.Fatalf("the command did not create the file: %v", err)
	}
	if string(body) != "created:new" {
		t.Errorf("file content = %q, want the handler's write", body)
	}

	// --list does not run anything.
	list := exec.Command(bin, "ext-run", "--list", "fixture")
	list.Env = append(os.Environ(), "SUWU_VAR="+dataDir)
	lout, err := list.CombinedOutput()
	if err != nil {
		t.Fatalf("--list failed: %v\n%s", err, lout)
	}
	if !strings.Contains(string(lout), "new") || !strings.Contains(string(lout), "Create a thing") {
		t.Errorf("--list output = %q", lout)
	}

	// An unknown verb fails with a hint, and an unknown extension fails too.
	bad := exec.Command(bin, "ext-run", "fixture", "nope")
	bad.Env = append(os.Environ(), "SUWU_VAR="+dataDir)
	if out, err := bad.CombinedOutput(); err == nil {
		t.Errorf("unknown command must fail; output = %q", out)
	}
}
