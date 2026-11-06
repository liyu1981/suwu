package extension

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeCSP(t *testing.T) {
	got, err := normalizeCSP(map[string][]string{
		"script-src":  {"https://unpkg.com", "'unsafe-eval'", "https://unpkg.com"},
		"worker-src":  {"blob:", "data:"},
		"connect-src": {"blob:"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]string{
		"script-src":  {"'unsafe-eval'", "https://unpkg.com"},
		"worker-src":  {"blob:", "data:"},
		"connect-src": {"blob:"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeCSP = %#v, want %#v", got, want)
	}
}

func TestNormalizeCSPRejectsUnsafe(t *testing.T) {
	for name, csp := range map[string]map[string][]string{
		"fixed directive":   {"sandbox": {"allow-same-origin"}},
		"unknown directive": {"xss-src": {"https://example.com"}},
		"bare wildcard":     {"script-src": {"*"}},
		"scheme wildcard":   {"img-src": {"https://*"}},
		"unsafe inline":     {"script-src": {"'unsafe-inline'"}},
		"quoted unknown":    {"script-src": {"'strict-dynamic'"}},
		"space":             {"script-src": {"https://example.com "}},
		"query":             {"connect-src": {"https://example.com/?x=1"}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := normalizeCSP(csp); err == nil {
				t.Fatalf("normalizeCSP(%v) accepted an unsafe policy", csp)
			}
		})
	}
}

func TestNormalizeSandbox(t *testing.T) {
	got, err := normalizeSandbox([]string{"allow-downloads", "allow-downloads"})
	if err != nil || !reflect.DeepEqual(got, []string{"allow-downloads"}) {
		t.Fatalf("normalizeSandbox = %v, %v", got, err)
	}
	for _, token := range []string{"allow-same-origin", "allow-top-navigation", "unknown"} {
		if _, err := normalizeSandbox([]string{token}); err == nil {
			t.Errorf("normalizeSandbox accepted %q", token)
		}
	}
}

func TestResolveReadsCSPAndSandbox(t *testing.T) {
	dir := t.TempDir()
	extDir := filepath.Join(dir, "demo")
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extDir, EntryFile), []byte("function handler(){}"), 0o644); err != nil {
		t.Fatal(err)
	}
	pkg := `{"name":"Demo","suwu":{"static":"public","csp":{"worker-src":["blob:"]},"sandbox":["allow-downloads"]}}`
	if err := os.WriteFile(filepath.Join(extDir, PackageFile), []byte(pkg), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(extDir, "public"), 0o755); err != nil {
		t.Fatal(err)
	}
	ext, err := Resolve(dir, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ext.CSP, map[string][]string{"worker-src": {"blob:"}}) {
		t.Fatalf("CSP = %#v", ext.CSP)
	}
	if !reflect.DeepEqual(ext.Sandbox, []string{"allow-downloads"}) {
		t.Fatalf("Sandbox = %#v", ext.Sandbox)
	}
}

func TestResolveRejectsBadCSP(t *testing.T) {
	dir := t.TempDir()
	extDir := filepath.Join(dir, "demo")
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extDir, EntryFile), []byte("function handler(){}"), 0o644); err != nil {
		t.Fatal(err)
	}
	pkg := `{"name":"Demo","suwu":{"csp":{"frame-ancestors":["https://evil.example"]}}}`
	if err := os.WriteFile(filepath.Join(extDir, PackageFile), []byte(pkg), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Resolve(dir, "demo")
	if err == nil || !strings.Contains(err.Error(), "fixed by Suwu") {
		t.Fatalf("Resolve error = %v, want a fixed-directive rejection", err)
	}
}

func TestExampleCapabilitiesResolve(t *testing.T) {
	dir := filepath.Join("..", "..", "examples", "extension")

	hn, err := Resolve(dir, "hn-top-stories")
	if err != nil {
		t.Fatal(err)
	}
	// The HN example crawls server-side (suwu.net) and polls its own API from
	// a local module: it declares no CDN, so there is no CSP to append.
	if len(hn.CSP) != 0 {
		t.Errorf("hn-top-stories CSP = %#v, want none", hn.CSP)
	}
	if !hn.Net {
		t.Error("hn-top-stories needs suwu.net for the server-side fetch")
	}

	ex, err := Resolve(dir, "excalidraw")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ex.CSP["script-src"], []string{"'unsafe-eval'", "https://esm.sh"}) {
		t.Errorf("excalidraw script-src = %#v", ex.CSP["script-src"])
	}
	if !reflect.DeepEqual(ex.CSP["worker-src"], []string{"blob:", "data:", "https://esm.sh"}) {
		t.Errorf("excalidraw worker-src = %#v", ex.CSP["worker-src"])
	}
	if !reflect.DeepEqual(ex.Sandbox, []string{"allow-downloads"}) {
		t.Errorf("excalidraw sandbox = %#v", ex.Sandbox)
	}
}
