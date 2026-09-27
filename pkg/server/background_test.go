package server

// Tests for /api/backgrounds (authenticated list, disk ∪ embedded with disk
// overriding) and /backgrounds/webgpu/<id>/<path> (deliberately unauthenticated
// module/shader serving, allow-listed extensions, fail-closed 404s).

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// installBackground lays a background into the data dir the way a user copies
// an example in.
func installBackground(t *testing.T, dataDir string, files map[string]string) {
	t.Helper()
	for path, content := range files {
		full := filepath.Join(dataDir, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func getBackgroundList(t *testing.T, base, query string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(base + "/api/backgrounds" + query)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp.StatusCode, out
}

func listIDs(body map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	if body == nil {
		return out
	}
	items, _ := body["backgrounds"].([]any)
	for _, item := range items {
		m, _ := item.(map[string]any)
		id, _ := m["id"].(string)
		out[id] = m
	}
	return out
}

func TestBackgroundsList(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)

	t.Run("requires auth", func(t *testing.T) {
		status, _ := getBackgroundList(t, ts.URL, "")
		if status == http.StatusOK {
			t.Fatal("expected a 401 without a token")
		}
	})

	t.Run("builtin seascape is listed", func(t *testing.T) {
		status, body := getBackgroundList(t, ts.URL, "?token=testtoken")
		if status != http.StatusOK {
			t.Fatalf("status %d", status)
		}
		items := listIDs(body)
		seascape, ok := items["seascape"]
		if !ok {
			t.Fatalf("builtin seascape missing from %v", items)
		}
		if seascape["label"] != "Seascape" || seascape["engine"] != "webgpu-render-engine" {
			t.Errorf("unexpected seascape manifest: %+v", seascape)
		}
		params, _ := seascape["params"].([]any)
		if len(params) != 1 {
			t.Errorf("expected the speed parameter, got %+v", seascape["params"])
		}
	})

	t.Run("data-dir copy overrides the builtin", func(t *testing.T) {
		installBackground(t, dataDir, map[string]string{
			"background/webgpu/seascape/background.json": `{
			  "id": "seascape",
			  "label": "Seascape (overridden)",
			  "engine": "webgpu-render-engine",
			  "params": [
			    { "kind": "number", "key": "speed", "label": "Speed", "default": 1, "min": 0, "max": 3, "decimals": 1 }
			  ]
			}`,
			"background/webgpu/seascape/scene.js": "export default function create() { return { start() {} }; }",
		})
		_, body := getBackgroundList(t, ts.URL, "?token=testtoken")
		items := listIDs(body)
		if items["seascape"]["label"] != "Seascape (overridden)" {
			t.Errorf("expected the disk copy to win, got %+v", items["seascape"])
		}
	})

	t.Run("external background is listed too", func(t *testing.T) {
		installBackground(t, dataDir, map[string]string{
			"background/webgpu/demo/background.json": `{
			  "id": "demo", "label": "Demo", "engine": "webgpu-render-engine",
			  "credit": { "author": "someone", "url": "https://example.com" }
			}`,
			"background/webgpu/demo/scene.js": "export default {};",
		})
		_, body := getBackgroundList(t, ts.URL, "?token=testtoken")
		items := listIDs(body)
		if _, ok := items["demo"]; !ok {
			t.Errorf("external background missing: %v", items)
		}
	})
}

func TestBackgroundStaticServing(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)

	// Deliberate: no credentials — module imports cannot carry an Authorization
	// header (mirrors /gqjs/static).
	get := func(t *testing.T, method, path string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = resp.Body.Close() })
		return resp
	}

	t.Run("builtin module and shader serve without credentials", func(t *testing.T) {
		resp := get(t, http.MethodGet, "/backgrounds/webgpu/seascape/scene.js")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("scene.js status %d", resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
			t.Errorf("content type %q", ct)
		}
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Error("missing nosniff")
		}
		body, _ := io.ReadAll(resp.Body)
		if !strings.Contains(string(body), "create(") {
			t.Errorf("unexpected scene.js body: %.80s", body)
		}

		resp = get(t, http.MethodGet, "/backgrounds/webgpu/seascape/shaders/seascape.shader.js")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("shader status %d", resp.StatusCode)
		}
		body, _ = io.ReadAll(resp.Body)
		if !strings.Contains(string(body), "export default { version: 1") {
			t.Errorf("unexpected artifact body: %.80s", body)
		}
	})

	t.Run("disk copy wins over the embedded file", func(t *testing.T) {
		installBackground(t, dataDir, map[string]string{
			"background/webgpu/seascape/background.json": `{"id":"seascape","label":"Seascape","engine":"webgpu-render-engine"}`,
			"background/webgpu/seascape/scene.js":        "// from disk\nexport default {};",
		})
		resp := get(t, http.MethodGet, "/backgrounds/webgpu/seascape/scene.js")
		body, _ := io.ReadAll(resp.Body)
		if !strings.Contains(string(body), "from disk") {
			t.Errorf("expected the data-dir copy, got: %.80s", body)
		}
		// The artifact was not copied to the data dir, so it falls back to the
		// embedded one.
		resp = get(t, http.MethodGet, "/backgrounds/webgpu/seascape/shaders/seascape.shader.js")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("embedded fallback status %d", resp.StatusCode)
		}
	})

	t.Run("fail closed", func(t *testing.T) {
		for _, tc := range []struct{ name, method, path string }{
			{"unknown extension", http.MethodGet, "/backgrounds/webgpu/seascape/scene.txt"},
			{"unknown id", http.MethodGet, "/backgrounds/webgpu/nope/scene.js"},
			{"missing file", http.MethodGet, "/backgrounds/webgpu/seascape/shaders/none.shader.js"},
			{"traversal", http.MethodGet, "/backgrounds/webgpu/../../../etc/passwd"},
			{"no id", http.MethodGet, "/backgrounds/webgpu/"},
			{"method", http.MethodPost, "/backgrounds/webgpu/seascape/scene.js"},
		} {
			resp := get(t, tc.method, tc.path)
			if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
				t.Errorf("%s: got status %d, want 404/405", tc.name, resp.StatusCode)
			}
		}
	})

	t.Run("head omits the body", func(t *testing.T) {
		resp := get(t, http.MethodHead, "/backgrounds/webgpu/seascape/shaders/blit.wgsl")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d", resp.StatusCode)
		}
		body, _ := io.ReadAll(resp.Body)
		if len(body) != 0 {
			t.Errorf("HEAD returned a body: %q", body)
		}
	})
}
