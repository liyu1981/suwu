package install

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"suwu/pkg/extension"
)

// fakeGitHub serves the two endpoints the catalog uses: the recursive tree and
// raw file downloads.
type fakeGitHub struct {
	// tree is the JSON body of the tree endpoint.
	tree string
	// files maps a repository path to its body.
	files map[string]string
	// status, when non-zero, is returned for the tree endpoint.
	status int
	// lastToken records the Authorization header of the last tree request.
	lastToken string
	// requests counts raw file downloads.
	requests int
}

func (f *fakeGitHub) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/", func(w http.ResponseWriter, r *http.Request) {
		f.lastToken = r.Header.Get("Authorization")
		if f.status != 0 {
			w.WriteHeader(f.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(f.tree))
	})
	mux.HandleFunc("/raw/", func(w http.ResponseWriter, r *http.Request) {
		f.requests++
		// /raw/<owner>/<repo>/<ref>/<path…>
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/raw/"), "/", 4)
		if len(parts) < 4 {
			http.NotFound(w, r)
			return
		}
		body, ok := f.files[parts[3]]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// newTestClient points a client at the fake server.
func newTestClient(srv *httptest.Server, token string) *Client {
	c := NewClient("liyu1981/suwu", "master", token)
	c.BaseURL = srv.URL
	c.RawBaseURL = srv.URL + "/raw"
	return c
}

// treeJSON builds a tree response from repository paths.
func treeJSON(paths ...string) string {
	type node struct {
		Path string `json:"path"`
		Type string `json:"type"`
		Size int64  `json:"size"`
	}
	body := struct {
		Sha  string `json:"sha"`
		Tree []node `json:"tree"`
	}{Sha: "abc"}
	for i, p := range paths {
		body.Tree = append(body.Tree, node{Path: p, Type: "blob", Size: int64(100 + i)})
	}
	out, _ := json.Marshal(body)
	return string(out)
}

// sampleTree mirrors the real repository layout for both kinds.
func sampleTree() string {
	return treeJSON(
		"README.md",
		"examples/extension/eye/index.js",
		"examples/extension/eye/package.json",
		"examples/extension/eye/public/style.css",
		"examples/extension/note/index.js",
		"examples/extension/note/package.json",
		"examples/background/webgpu/matrix-rain/background.json",
		"examples/background/webgpu/matrix-rain/scene.js",
		"examples/background/webgpu/matrix-rain/shaders/matrix.wgsl",
		"examples/background/webgpu/matrix-rain/shaders/matrix.shader.js",
		"examples/background/webgpu/matrix-rain/shaders/common.wgsl",
		"examples/background/README.md",
	)
}

func sampleFiles() map[string]string {
	return map[string]string{
		"examples/extension/eye/index.js":                                 validExtension()["index.js"],
		"examples/extension/eye/package.json":                             validExtension()[extension.PackageFile],
		"examples/extension/eye/public/style.css":                         validExtension()["public/style.css"],
		"examples/extension/note/index.js":                                validExtension()["index.js"],
		"examples/extension/note/package.json":                            `{"name":"Note","description":"sticky notes"}`,
		"examples/background/webgpu/matrix-rain/background.json":          `{"id":"matrix-rain","label":"Matrix Rain","engine":"webgpu-render-engine"}`,
		"examples/background/webgpu/matrix-rain/scene.js":                 "export default function create(){ return { start(){} }; }",
		"examples/background/webgpu/matrix-rain/shaders/matrix.wgsl":      "@fragment fn main() {}",
		"examples/background/webgpu/matrix-rain/shaders/matrix.shader.js": "export default { version: 1, wgsl: '' };",
		"examples/background/webgpu/matrix-rain/shaders/common.wgsl":      "fn helper() {}",
	}
}

func TestLoadCatalogGroupsByKind(t *testing.T) {
	f := &fakeGitHub{tree: sampleTree(), files: sampleFiles()}
	c := newTestClient(f.server(t), "")

	cat, err := c.LoadCatalog(context.Background(), "", false)
	if err != nil {
		t.Fatalf("LoadCatalog: %v", err)
	}
	if got := len(cat.OfKind(KindExtension)); got != 2 {
		t.Errorf("extensions = %d, want 2", got)
	}
	if got := len(cat.OfKind(KindBackground)); got != 1 {
		t.Errorf("backgrounds = %d, want 1", got)
	}

	eye, ok := cat.Find(KindExtension, "eye")
	if !ok {
		t.Fatal("eye not in the catalog")
	}
	if eye.Name != "Demo" || eye.Description != "a demo" {
		t.Errorf("eye manifest not read: name=%q description=%q", eye.Name, eye.Description)
	}
	if len(eye.Files) != 3 {
		t.Errorf("eye files = %d, want 3: %+v", len(eye.Files), eye.Files)
	}
	// Paths are relative to the item root, not the repository root.
	if eye.Files[0].Path != "index.js" {
		t.Errorf("first file = %q, want index.js", eye.Files[0].Path)
	}

	rain, _ := cat.Find(KindBackground, "matrix-rain")
	if rain.Name != "Matrix Rain" {
		t.Errorf("background name = %q, want Matrix Rain", rain.Name)
	}
	if len(rain.Files) != 5 {
		t.Errorf("background files = %d, want 5: %+v", len(rain.Files), rain.Files)
	}
}

// TestLoadCatalogDropsHostilePaths is the important one: a tree listing is
// remote input, so a path that tries to escape must be dropped, not fetched.
func TestLoadCatalogDropsHostilePaths(t *testing.T) {
	f := &fakeGitHub{
		tree: treeJSON(
			"examples/extension/../evil/package.json",
			"examples/extension/ok/package.json",
			"examples/extension/ok/index.js",
		),
		files: sampleFiles(),
	}
	c := newTestClient(f.server(t), "")

	cat, err := c.LoadCatalog(context.Background(), "", false)
	if err != nil {
		t.Fatalf("LoadCatalog: %v", err)
	}
	if _, ok := cat.Find(KindExtension, "evil"); ok {
		t.Error("a traversing path produced a catalog entry")
	}
	if _, ok := cat.Find(KindExtension, "ok"); !ok {
		t.Errorf("the valid entry was dropped too: %+v", cat.Entries)
	}
}

func TestLoadCatalogIgnoresNonExamplePaths(t *testing.T) {
	f := &fakeGitHub{
		tree: treeJSON(
			"website/docs/pages/eye/package.json",
			"docs/EXTENSION_TILE_PLAN.md",
			"examples/background/webgpu/rainforest/background.json",
		),
		files: map[string]string{
			"examples/background/webgpu/rainforest/background.json": `{"id":"rainforest","label":"Rainforest"}`,
		},
	}
	c := newTestClient(f.server(t), "")
	cat, err := c.LoadCatalog(context.Background(), "", false)
	if err != nil {
		t.Fatalf("LoadCatalog: %v", err)
	}
	if len(cat.Entries) != 1 {
		t.Fatalf("entries = %+v, want only the examples entry", cat.Entries)
	}
	if _, ok := cat.Find(KindBackground, "rainforest"); !ok {
		t.Errorf("rainforest missing: %+v", cat.Entries)
	}
}

func TestLoadCatalogSkipsInvalidIDs(t *testing.T) {
	f := &fakeGitHub{
		tree:   treeJSON("examples/extension/Bad.ID/package.json", "examples/extension/ok/package.json"),
		files:  sampleFiles(),
		status: 0,
	}
	c := newTestClient(f.server(t), "")
	cat, err := c.LoadCatalog(context.Background(), "", false)
	if err != nil {
		t.Fatalf("LoadCatalog: %v", err)
	}
	if _, ok := cat.Find(KindExtension, "Bad.ID"); ok {
		t.Error("an invalid id produced a catalog entry")
	}
}

// TestLoadCatalogManifestFailureDegrades covers a manifest that will not
// download: the entry keeps its id and still installs, because the install
// path validates the real files.
func TestLoadCatalogManifestFailureDegrades(t *testing.T) {
	f := &fakeGitHub{tree: sampleTree(), files: map[string]string{}} // no files at all
	c := newTestClient(f.server(t), "")
	cat, err := c.LoadCatalog(context.Background(), "", false)
	if err != nil {
		t.Fatalf("LoadCatalog: %v", err)
	}
	eye, ok := cat.Find(KindExtension, "eye")
	if !ok {
		t.Fatal("eye missing from the catalog")
	}
	if eye.Name != "" {
		t.Errorf("Name = %q, want empty after a failed manifest fetch", eye.Name)
	}
	if len(eye.Files) != 3 {
		t.Errorf("files = %d, want the tree-derived 3", len(eye.Files))
	}
}

func TestLoadCatalogSendsToken(t *testing.T) {
	f := &fakeGitHub{tree: sampleTree(), files: sampleFiles()}
	c := newTestClient(f.server(t), "ghp_secret")
	if _, err := c.LoadCatalog(context.Background(), "", false); err != nil {
		t.Fatalf("LoadCatalog: %v", err)
	}
	if f.lastToken != "Bearer ghp_secret" {
		t.Errorf("Authorization = %q, want a Bearer token", f.lastToken)
	}
}

func TestLoadCatalogSurfacesHTTPErrors(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusForbidden, http.StatusInternalServerError} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := &fakeGitHub{status: status}
			c := newTestClient(f.server(t), "")
			_, err := c.LoadCatalog(context.Background(), "", false)
			if err == nil || !strings.Contains(err.Error(), fmt.Sprint(status)) {
				t.Fatalf("err = %v, want the HTTP status surfaced", err)
			}
		})
	}
}

func TestLoadCatalogRejectsTruncatedTree(t *testing.T) {
	f := &fakeGitHub{tree: `{"truncated":true,"tree":[]}`}
	c := newTestClient(f.server(t), "")
	_, err := c.LoadCatalog(context.Background(), "", false)
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("err = %v, want a truncated-tree error", err)
	}
}

func TestCatalogCache(t *testing.T) {
	cacheDir := t.TempDir()

	// First load populates the cache.
	f1 := &fakeGitHub{tree: sampleTree(), files: sampleFiles()}
	c1 := newTestClient(f1.server(t), "")
	if _, err := c1.LoadCatalog(context.Background(), cacheDir, false); err != nil {
		t.Fatalf("first load: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cacheDir, "github-catalog.json")); err != nil {
		t.Fatalf("cache not written: %v", err)
	}

	// Second load with a broken network still renders a picker.
	f2 := &fakeGitHub{status: http.StatusInternalServerError}
	c2 := newTestClient(f2.server(t), "")
	cat, err := c2.LoadCatalog(context.Background(), cacheDir, false)
	if err != nil {
		t.Fatalf("cached load: %v", err)
	}
	if _, ok := cat.Find(KindExtension, "eye"); !ok {
		t.Errorf("the cached catalog lost its entries: %+v", cat.Entries)
	}

	// --refresh bypasses a fresh cache and surfaces the error.
	if _, err := c2.LoadCatalog(context.Background(), cacheDir, true); err == nil {
		t.Error("refresh did not bypass the cache")
	}
}

func TestCatalogCacheIgnoresOtherRepos(t *testing.T) {
	cacheDir := t.TempDir()
	f := &fakeGitHub{tree: sampleTree(), files: sampleFiles()}
	c := newTestClient(f.server(t), "")
	if _, err := c.LoadCatalog(context.Background(), cacheDir, false); err != nil {
		t.Fatal(err)
	}

	// A different repo must not be served from the previous repo's cache.
	otherFake := &fakeGitHub{status: http.StatusNotFound}
	other := newTestClient(otherFake.server(t), "")
	other.Repo = "someone/else"
	if _, err := other.LoadCatalog(context.Background(), cacheDir, false); err == nil {
		t.Error("a foreign repo was served from the local cache")
	}
}

func TestCatalogCacheExpiry(t *testing.T) {
	cacheDir := t.TempDir()
	path := filepath.Join(cacheDir, "github-catalog.json")
	stale := catalogCache{
		Repo: DefaultRepo, Ref: DefaultRef,
		FetchedAt: time.Now().Add(-2 * catalogCacheTTL),
		Entries:   []CatalogEntry{{Kind: KindExtension, ID: "old"}},
	}
	data, _ := json.Marshal(stale)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	// Stale plus a failing network is the documented fallback…
	f := &fakeGitHub{status: http.StatusInternalServerError}
	c := newTestClient(f.server(t), "")
	cat, err := c.LoadCatalog(context.Background(), cacheDir, false)
	if err != nil {
		t.Fatalf("stale fallback: %v", err)
	}
	if len(cat.Entries) != 1 {
		t.Errorf("entries = %d, want the stale cache", len(cat.Entries))
	}
}

func TestInstallCatalogEntry(t *testing.T) {
	f := &fakeGitHub{tree: sampleTree(), files: sampleFiles()}
	c := newTestClient(f.server(t), "")
	cat, err := c.LoadCatalog(context.Background(), "", false)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()

	entry, _ := cat.Find(KindExtension, "eye")
	item, err := c.InstallCatalogEntry(context.Background(), entry, Options{DataDir: dir})
	if err != nil {
		t.Fatalf("install extension: %v", err)
	}
	if item.Name != "Demo" || item.Files != 3 {
		t.Errorf("item = %+v, want Demo with 3 files", item)
	}
	if _, err := extension.Resolve(extension.Dir(dir), "eye"); err != nil {
		t.Errorf("the server cannot resolve the install: %v", err)
	}
	// The nested static asset must have kept its path.
	if _, err := os.Stat(filepath.Join(item.Dir, "public", "style.css")); err != nil {
		t.Errorf("nested asset missing: %v", err)
	}
	assertNoResidue(t, dir)

	bentry, _ := cat.Find(KindBackground, "matrix-rain")
	bitem, err := c.InstallCatalogEntry(context.Background(), bentry, Options{DataDir: dir})
	if err != nil {
		t.Fatalf("install background: %v", err)
	}
	if bitem.Name != "Matrix Rain" {
		t.Errorf("background name = %q, want Matrix Rain", bitem.Name)
	}
	if len(bitem.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none (every entry shader is compiled)", bitem.Warnings)
	}
}

func TestInstallCatalogEntryRejectsPathEscape(t *testing.T) {
	f := &fakeGitHub{tree: sampleTree(), files: sampleFiles()}
	c := newTestClient(f.server(t), "")
	dir := t.TempDir()

	// A hand-built entry with a traversing file path, as a poisoned cache or a
	// compromised listing would produce.
	entry := CatalogEntry{
		Kind: KindExtension, ID: "eye",
		Files: []CatalogFile{{Path: "../escape.js", RepoPath: "examples/extension/eye/index.js"}},
	}
	if _, err := c.InstallCatalogEntry(context.Background(), entry, Options{DataDir: dir}); err == nil {
		t.Fatal("a traversing file path was installed")
	}
	assertNoResidue(t, dir)
	assertNotInstalled(t, dir, KindExtension, "eye")
}

func TestInstallCatalogEntryReportsDownloadFailure(t *testing.T) {
	f := &fakeGitHub{tree: sampleTree(), files: map[string]string{}}
	c := newTestClient(f.server(t), "")
	dir := t.TempDir()
	entry := CatalogEntry{
		Kind: KindExtension, ID: "eye",
		Files: []CatalogFile{{Path: "index.js", RepoPath: "examples/extension/eye/index.js"}},
	}
	_, err := c.InstallCatalogEntry(context.Background(), entry, Options{DataDir: dir})
	if err == nil || !strings.Contains(err.Error(), "download") {
		t.Fatalf("err = %v, want a download failure", err)
	}
	assertNoResidue(t, dir)
}

func TestClientDefaults(t *testing.T) {
	c := NewClient("", "", "")
	if c.Repo != DefaultRepo || c.Ref != DefaultRef {
		t.Errorf("defaults = %s@%s, want %s@%s", c.Repo, c.Ref, DefaultRepo, DefaultRef)
	}
	if c.Source() != DefaultRepo+"@"+DefaultRef {
		t.Errorf("Source = %q", c.Source())
	}
}
