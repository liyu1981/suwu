package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func requireRG(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("rg")
	if err != nil {
		t.Skip("ripgrep not installed")
	}
	return path
}

func TestSearchExtension(t *testing.T) {
	for raw, want := range map[string]string{"": "", "  ": "", "ts": "ts", " .tsx ": "tsx", "d.ts": "d.ts", "c++": "c++"} {
		got, err := normalizeSearchExtension(raw)
		if err != nil || got != want {
			t.Fatalf("normalize %q: %q %v", raw, got, err)
		}
	}
	for _, raw := range []string{".", "*.ts", "ts,go", "../ts", "ts/go", "ts\\go", "ts\n--hidden", "{ts,go}", strings.Repeat("x", 65)} {
		if _, err := normalizeSearchExtension(raw); err == nil {
			t.Fatalf("accepted invalid extension %q", raw)
		}
	}
	rg := requireRG(t)
	dir := t.TempDir()
	for name, text := range map[string]string{
		"a.ts": "needle", "b.tsx": "needle", "c.go": "needle", "noextension": "needle",
		"nested/deep.ts": "needle", ".hidden.ts": "needle", "ignored.ts": "needle", ".ignore": "ignored.ts\n",
	} {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for extension, want := range map[string]int{"ts": 2, "tsx": 1, "go": 1, "": 5, "rs": 0} {
		result, err := runFileSearch(context.Background(), rg, dir, "needle", extension)
		if err != nil || result.Truncated || result.ReturnedMatches != want {
			t.Fatalf("extension %q: %+v %v", extension, result, err)
		}
	}
}

func TestSearchPosition(t *testing.T) {
	for _, tc := range []struct {
		text                 string
		offset, line, column int
	}{
		{"中😀target", len("中😀"), 7, 4},
		{"abc\r\n😀target", len("abc\r\n😀"), 8, 3},
		{"abc\n", 4, 8, 1},
	} {
		line, col := searchPosition(tc.text, tc.offset, 7)
		if line != tc.line || col != tc.column {
			t.Fatalf("%q: got %d:%d want %d:%d", tc.text, line, col, tc.line, tc.column)
		}
	}
}

func TestSearchLiteralAndMultiline(t *testing.T) {
	rg := requireRG(t)
	dir := t.TempDir()
	files := map[string]string{
		"a file.ts":         "中😀-a.b[0] -a.b[0]\nhello\nworld\n",
		"crlf.ts":           "hello\r\nworld\r\n",
		"hidden/.hidden.ts": "-a.b[0]",
		"ignored.ts":        "-a.b[0]",
		".ignore":           "ignored.ts\n",
	}
	for name, text := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Even ambient configuration must not change matching/ignore behavior.
	config := filepath.Join(t.TempDir(), "rg-config")
	if err := os.WriteFile(config, []byte("--hidden\n--ignore-case\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RIPGREP_CONFIG_PATH", config)
	result, err := runFileSearch(context.Background(), rg, dir, "-a.b[0]", "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Truncated || result.ReturnedMatches != 2 || len(result.Files) != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	first := result.Files[0].Matches[0]
	if first.Line != 1 || first.Column != 4 || first.EndColumn != 11 || first.PreviewStart != 3 || first.PreviewEnd != 10 {
		t.Fatalf("bad position: %+v", first)
	}
	for _, query := range []string{"hello\nworld", "hello\r\nworld"} {
		result, err = runFileSearch(context.Background(), rg, dir, query, "")
		if err != nil || result.ReturnedMatches != 2 || result.Truncated {
			t.Fatalf("multiline %q: %+v, %v", query, result, err)
		}
		for _, file := range result.Files {
			m := file.Matches[0]
			if m.EndLine != m.Line+1 || m.EndColumn != 6 {
				t.Fatalf("multiline location: %+v", m)
			}
		}
	}
	result, err = runFileSearch(context.Background(), rg, dir, "HELLO", "")
	if err != nil || result.Truncated || result.ReturnedMatches != 0 {
		t.Fatalf("no matches: %+v %v", result, err)
	}
}

func TestSearchLimitsAndCancellation(t *testing.T) {
	rg := requireRG(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "many.txt"), []byte(strings.Repeat("match\n", searchMaxMatches+10)), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := runFileSearch(context.Background(), rg, dir, "match", "")
	if err != nil || !result.Truncated || result.ReturnedMatches != searchMaxMatches {
		t.Fatalf("limit: %+v %v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	_, _ = runFileSearch(ctx, rg, dir, "match", "")
	if time.Since(start) > time.Second {
		t.Fatal("cancelled search did not stop promptly")
	}

	// Child exits nonzero after partial output: retain results, mark incomplete.
	fake := filepath.Join(t.TempDir(), "fake-rg")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 2\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err = runFileSearch(context.Background(), fake, dir, "match", "")
	if err != nil || !result.Truncated || len(result.Warnings) == 0 {
		t.Fatalf("exit 2: %+v %v", result, err)
	}

	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start = time.Now()
	result, err = runFileSearch(ctx, fake, dir, "match", "")
	if err != nil || !result.Truncated || time.Since(start) > 2*time.Second {
		t.Fatalf("timeout: %+v %v", result, err)
	}
}

func TestSearchParser(t *testing.T) {
	encoded := `{"type":"match","data":{"path":{"bytes":"/w=="},"lines":{"text":"match"},"line_number":1,"submatches":[{"start":0,"end":5}]}}` + "\n"
	result := parseSearchOutput(strings.NewReader(encoded), "/tmp")
	if result.ReturnedMatches != 0 || len(result.Warnings) != 1 || result.Warnings[0] != "unsupportedEncoding" {
		t.Fatalf("encoding: %+v", result)
	}
	result = parseSearchOutput(strings.NewReader("not json\n"), "/tmp")
	if !result.Truncated {
		t.Fatal("malformed output must be marked incomplete")
	}
	result = parseSearchOutput(strings.NewReader(strings.Repeat("x", searchMaxRecord+1)), "/tmp")
	if !result.Truncated {
		t.Fatal("long records must be bounded")
	}
	result = parseSearchOutput(strings.NewReader(strings.Repeat("{\"type\":\"begin\"}\n", searchMaxOutput/17+10)), "/tmp")
	if !result.Truncated {
		t.Fatal("total output must be bounded")
	}
	text := strings.Repeat("中😀", 300) + "needle" + strings.Repeat("x", 800)
	preview, start, end := searchPreview(text, len(strings.Repeat("中😀", 300)), len(strings.Repeat("中😀", 300))+6)
	if len(preview) > 560 || end-start != 6 || !strings.Contains(preview, "needle") {
		t.Fatalf("preview: %q %d %d", preview, start, end)
	}
}

func TestFileSearchEndpoint(t *testing.T) {
	requireRG(t)
	ts, _ := testServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "test.txt"), []byte("needle"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, method, body, token string
		status                    int
	}{
		{"ok", "POST", fmt.Sprintf(`{"query":"needle","directory":%q}`, dir), "testtoken", 200},
		{"extension", "POST", fmt.Sprintf(`{"query":"needle","directory":%q,"extension":".txt"}`, dir), "testtoken", 200},
		{"invalid-extension", "POST", fmt.Sprintf(`{"query":"needle","directory":%q,"extension":"*.txt"}`, dir), "testtoken", 400},
		{"empty", "POST", fmt.Sprintf(`{"query":"","directory":%q}`, dir), "testtoken", 400},
		{"relative", "POST", `{"query":"needle","directory":"."}`, "testtoken", 400},
		{"missing", "POST", fmt.Sprintf(`{"query":"needle","directory":%q}`, filepath.Join(dir, "absent")), "testtoken", 400},
		{"file", "POST", fmt.Sprintf(`{"query":"needle","directory":%q}`, filepath.Join(dir, "test.txt")), "testtoken", 400},
		{"method", "GET", "", "testtoken", 405},
		{"unauthorized", "POST", `{}`, "wrong", 401},
		{"trailing", "POST", fmt.Sprintf(`{"query":"needle","directory":%q} {}`, dir), "testtoken", 400},
		{"oversize", "POST", fmt.Sprintf(`{"query":%q,"directory":%q}`, strings.Repeat("x", 4097), dir), "testtoken", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(tc.method, ts.URL+"/api/files/search", bytes.NewBufferString(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+tc.token)
			req.Header.Set("Content-Type", "application/json")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != tc.status {
				t.Fatalf("status %d want %d", res.StatusCode, tc.status)
			}
			if tc.status == 200 {
				var result searchResponse
				if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
					t.Fatal(err)
				}
				if result.ReturnedMatches != 1 {
					t.Fatalf("result %+v", result)
				}
			}
		})
	}
	t.Setenv("PATH", t.TempDir())
	req, _ := http.NewRequest("POST", ts.URL+"/api/files/search", strings.NewReader(fmt.Sprintf(`{"query":"needle","directory":%q}`, dir)))
	req.Header.Set("Authorization", "Bearer testtoken")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 503 {
		t.Fatalf("missing rg status: %d", res.StatusCode)
	}
}
