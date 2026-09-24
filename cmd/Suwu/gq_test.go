package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeGqScript writes a temp .js file and returns its path.
func writeGqScript(t *testing.T, src string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "script.js")
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// runGq invokes gqMain with stdout/stderr silenced so usage text and script
// output do not pollute the test log.
func runGq(t *testing.T, args ...string) int {
	t.Helper()
	oldOut, oldErr := os.Stdout, os.Stderr
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout, os.Stderr = devNull, devNull
	defer func() {
		os.Stdout, os.Stderr = oldOut, oldErr
		_ = devNull.Close()
	}()
	return gqMain(args)
}

func TestBuildGqEnv(t *testing.T) {
	env, err := buildGqEnv(
		2*time.Second,
		gqStringList{"/app=./examples"},
		true,
		gqStringList{"A=1", "B=two"},
		`{"n":21}`,
		"",
		"/work",
		gqStringList{"--flag", "x"},
		"script.js",
	)
	if err != nil {
		t.Fatal(err)
	}
	if env.Timeout != 2*time.Second {
		t.Errorf("timeout = %v", env.Timeout)
	}
	if env.CWD != "/work" {
		t.Errorf("cwd = %q", env.CWD)
	}
	if env.Vars["A"] != "1" || env.Vars["B"] != "two" {
		t.Errorf("vars = %v", env.Vars)
	}
	if env.FS.Roots["/app"] != "./examples" || !env.FS.ReadOnly {
		t.Errorf("fs = %+v", env.FS)
	}
	if string(env.InputJSON) != `{"n":21}` {
		t.Errorf("input = %s", env.InputJSON)
	}
	wantArgs := []string{"script.js", "--flag", "x"}
	if len(env.Args) != len(wantArgs) {
		t.Fatalf("args = %v", env.Args)
	}
	for i := range wantArgs {
		if env.Args[i] != wantArgs[i] {
			t.Fatalf("args = %v, want %v", env.Args, wantArgs)
		}
	}
}

func TestBuildGqEnvErrors(t *testing.T) {
	cases := []struct {
		name string
		vars gqStringList
		root gqStringList
		in   string
	}{
		{name: "bad env", vars: gqStringList{"NOEQUALS"}},
		{name: "bad root", root: gqStringList{"noequals"}},
		{name: "bad input", in: "not json"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := buildGqEnv(0, tc.root, false, tc.vars, tc.in, "", "/", nil, "s.js"); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestGqExitCodes(t *testing.T) {
	if code := runGq(t); code != 64 {
		t.Errorf("no script: code = %d, want 64", code)
	}

	ok := writeGqScript(t, `console.log("hi"); 1 + 1;`)
	// Use a generous timeout: the race detector slows the Wasm interpreter
	// enough that the 5s default can trip on a cold first run.
	if code := runGq(t, "--timeout", "60s", ok); code != 0 {
		t.Errorf("success: code = %d, want 0", code)
	}

	fail := writeGqScript(t, `throw new Error("boom");`)
	if code := runGq(t, "--timeout", "60s", fail); code != 1 {
		t.Errorf("script error: code = %d, want 1", code)
	}

	hang := writeGqScript(t, `while (true) {}`)
	if code := runGq(t, "--timeout", "100ms", hang); code != 2 {
		t.Errorf("timeout: code = %d, want 2", code)
	}

	// Emit well over the 1 MiB default output cap.
	big := writeGqScript(t, `for (let i = 0; i < 20000; i++) console.log("x".repeat(100));`)
	if code := runGq(t, "--timeout", "60s", big); code != 3 {
		t.Errorf("output limit: code = %d, want 3", code)
	}
}

func TestGqResultFile(t *testing.T) {
	out := filepath.Join(t.TempDir(), "result.json")
	src := writeGqScript(t, `function handler(input){ return { doubled: input.n * 2 }; }`)

	if code := runGq(t, "--timeout", "60s", "--input", `{"n":21}`, "--result-file", out, src); code != 0 {
		t.Fatalf("success: code = %d, want 0", code)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(data)); got != `{"doubled":42}` {
		t.Errorf("result file = %q, want {\"doubled\":42}", got)
	}
}
