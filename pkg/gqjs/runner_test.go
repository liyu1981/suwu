package gqjs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testRun runs a script with a generous default timeout so the race detector's
// slowdown does not trip the production default. Timeout tests set their own.
func testRun(t *testing.T, src string, env Env) (*Result, error) {
	t.Helper()
	if env.Timeout == 0 {
		env.Timeout = 60 * time.Second
	}
	return New().Run(context.Background(), src, env)
}

func TestTopLevelResult(t *testing.T) {
	res, err := testRun(t, `
		const a = 1 + 2;
		({ sum: a, list: [1, 2, 3], ok: true, name: "gqjs" });
	`, Env{})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	got, ok := res.Value.(map[string]any)
	if !ok {
		t.Fatalf("result type = %T (%s)", res.Value, res.JSON)
	}
	if got["sum"].(float64) != 3 {
		t.Fatalf("sum = %v", got["sum"])
	}
	if got["name"].(string) != "gqjs" {
		t.Fatalf("name = %v", got["name"])
	}
}

func TestHandlerWithInput(t *testing.T) {
	res, err := testRun(t, `
		function handler(input) {
			return { doubled: input.n * 2, label: input.label.toUpperCase() };
		}
	`, Env{Input: map[string]any{"n": 21, "label": "hi"}})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	got := res.Value.(map[string]any)
	if got["doubled"].(float64) != 42 {
		t.Fatalf("doubled = %v", got["doubled"])
	}
	if got["label"].(string) != "HI" {
		t.Fatalf("label = %v", got["label"])
	}
}

func TestAsyncFSFacade(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("from-disk"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := testRun(t, `
		async function handler(input) {
			const text = await fs.promises.readFile(input.path);
			const [st, entries] = await Promise.all([
				fs.promises.stat(input.path),
				fs.promises.readdir("/data"),
			]);
			return {
				text,
				size: st.size,
				isFile: st.isFile(),
				entries,
				joined: path.join("/data", "sub", "..", "hello.txt"),
			};
		}
	`, Env{
		FS:    FSConfig{Roots: map[string]string{"/data": dir}},
		Input: map[string]any{"path": "/data/hello.txt"},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	got := res.Value.(map[string]any)
	if got["text"].(string) != "from-disk" {
		t.Fatalf("text = %q", got["text"])
	}
	if got["size"].(float64) != 9 {
		t.Fatalf("size = %v", got["size"])
	}
	if got["isFile"].(bool) != true {
		t.Fatalf("isFile = %v", got["isFile"])
	}
	if !strings.Contains(got["joined"].(string), "hello.txt") {
		t.Fatalf("joined = %v", got["joined"])
	}
}

func TestConsoleCapture(t *testing.T) {
	res, err := testRun(t, `
		console.log("out", 1, { a: 2 });
		console.error("err");
		"done";
	`, Env{})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !strings.Contains(res.Stdout, "out 1") || !strings.Contains(res.Stdout, `"a":2`) {
		t.Fatalf("stdout = %q", res.Stdout)
	}
	if !strings.Contains(res.Stderr, "err") {
		t.Fatalf("stderr = %q", res.Stderr)
	}
	if res.Value.(string) != "done" {
		t.Fatalf("value = %v", res.Value)
	}
}

func TestProcessEnvAndArgv(t *testing.T) {
	res, err := testRun(t, `
		({
			key: process.env.MY_KEY,
			argv: process.argv,
			platform: process.platform,
			cwd: process.cwd(),
		});
	`, Env{
		Args: []string{"script.js", "--flag"},
		Vars: map[string]string{"MY_KEY": "secret"},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	got := res.Value.(map[string]any)
	if got["key"].(string) != "secret" {
		t.Fatalf("key = %v", got["key"])
	}
	argv := got["argv"].([]any)
	if len(argv) != 2 || argv[1].(string) != "--flag" {
		t.Fatalf("argv = %v", argv)
	}
}

func TestModuleExports(t *testing.T) {
	res, err := testRun(t, `
		module.exports = { from: "cjs", value: 7 };
	`, Env{})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	got := res.Value.(map[string]any)
	if got["from"].(string) != "cjs" || got["value"].(float64) != 7 {
		t.Fatalf("value = %v", got)
	}
}

func TestIsolationBetweenRuns(t *testing.T) {
	r := New()
	if _, err := r.Run(context.Background(), `globalThis.leak = 42; 1`, Env{Timeout: 60 * time.Second}); err != nil {
		t.Fatalf("run 1: %v", err)
	}
	res, err := r.Run(context.Background(), `typeof globalThis.leak`, Env{Timeout: 60 * time.Second})
	if err != nil {
		t.Fatalf("run 2: %v", err)
	}
	if res.Value.(string) != "undefined" {
		t.Fatalf("state leaked across runs: %v", res.Value)
	}
}

func TestTimeoutInfiniteLoop(t *testing.T) {
	start := time.Now()
	_, err := testRun(t, `while (true) {}`, Env{Timeout: 300 * time.Millisecond})
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("timeout took too long: %s", elapsed)
	}
}

func TestTimeoutSlowHost(t *testing.T) {
	_, err := testRun(t, `
		await new Promise((resolve) => resolve());
		__gqjs.sleep(5000);
		1;
	`, Env{Timeout: 300 * time.Millisecond})
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
}

func TestFSEscapeDenied(t *testing.T) {
	dir := t.TempDir()
	_, err := testRun(t, `
		fs.readFileSync("/data/../etc/passwd");
	`, Env{FS: FSConfig{Roots: map[string]string{"/data": dir}}})
	if err == nil {
		t.Fatal("expected error reading outside root")
	}
	if !strings.Contains(err.Error(), "EACCES") {
		t.Fatalf("err = %v, want EACCES", err)
	}
}

func TestOutputLimit(t *testing.T) {
	_, err := testRun(t, `console.log("x".repeat(5000)); 1`, Env{MaxOutputBytes: 100})
	if !errors.Is(err, ErrOutputLimit) {
		t.Fatalf("err = %v, want ErrOutputLimit", err)
	}
}

func TestScriptError(t *testing.T) {
	_, err := testRun(t, `throw new Error("boom")`, Env{})
	var se *ScriptError
	if !errors.As(err, &se) {
		t.Fatalf("err = %v (%T), want *ScriptError", err, err)
	}
	if !strings.Contains(se.Message, "boom") {
		t.Fatalf("message = %q", se.Message)
	}
}

// TestStringResultIntegrity is a regression test for a use-after-free in
// qjs's native QJS_JSONStringify helper (worked around via JSON.stringify).
func TestStringResultIntegrity(t *testing.T) {
	for n := 1; n <= 64; n++ {
		s := strings.Repeat("a", n)
		res, err := testRun(t, `"`+s+`"`, Env{})
		if err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		if res.Value.(string) != s {
			t.Fatalf("n=%d: got %q want %q", n, res.Value, s)
		}
	}
}
