package server

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"suwu/pkg/assets"
	"suwu/pkg/auth"
	"suwu/pkg/forward"
)

// countingFS wraps the embedded assets so a test can see exactly how many bytes
// the server reads from them. The property under test is that a cached
// compressed body is served *without* touching the file.
type countingFS struct {
	inner fs.FS
	opens atomic.Int64
	reads atomic.Int64
}

func (c *countingFS) Open(name string) (fs.File, error) {
	f, err := c.inner.Open(name)
	if err != nil {
		return nil, err
	}
	c.opens.Add(1)
	return &countingFile{File: f, parent: c}, nil
}

type countingFile struct {
	fs.File
	parent *countingFS
}

func (f *countingFile) Read(p []byte) (int, error) {
	n, err := f.File.Read(p)
	f.parent.reads.Add(int64(n))
	return n, err
}

// assetServer starts a server over the embedded web tree, with a nil session
// manager: nothing in these handlers needs one, and skipping it keeps the test
// off the wasm compile path.
func assetServer(t *testing.T, fsys fs.FS) *httptest.Server {
	t.Helper()
	cfg := &auth.Config{
		Token:        "testtoken",
		BindHost:     "127.0.0.1",
		AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
	}
	srv := New(cfg, fsys, nil, nil, forward.NewManager(), "")
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// bigAsset returns the largest compressible asset in the tree: the property only
// shows up on files above the gzip threshold.
func bigAsset(t *testing.T, fsys fs.FS) string {
	t.Helper()
	var best string
	var bestSize int64
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !compressible(name) {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() >= gzipMinBytes && info.Size() > bestSize {
			best, bestSize = name, info.Size()
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if best == "" {
		t.Skip("no compressible asset in the embedded tree; build the frontend first")
	}
	return best
}

// testClient never adds Accept-Encoding on its own and never decompresses: the
// tests here are about what the *server* sends, and http.Transport would
// otherwise inject "Accept-Encoding: gzip" into every request and silently
// decode the response.
var testClient = &http.Client{Transport: &http.Transport{DisableCompression: true}}

func get(t *testing.T, url string, header http.Header) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := testClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return resp, body
}

// A page load pulls megabytes of assets and the browser cannot cache them
// (Cache-Control: no-store), so a reload used to re-read every file from the
// embed and allocate it. Once the compressed body is cached, the file must not
// be read again at all.
func TestServeAssetServesFromCacheWithoutReading(t *testing.T) {
	sub, err := fs.Sub(assets.FS, "web")
	if err != nil {
		t.Fatal(err)
	}
	name := bigAsset(t, sub)
	counted := &countingFS{inner: sub}
	ts := assetServer(t, counted)
	url := ts.URL + "/" + name
	gzip := http.Header{"Accept-Encoding": {"gzip"}}

	first, firstBody := get(t, url, gzip)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first request status = %d", first.StatusCode)
	}
	if got := first.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("first request Content-Encoding = %q, want gzip", got)
	}
	if len(firstBody) == 0 {
		t.Fatal("first request returned no body")
	}
	readAfterFirst := counted.reads.Load()
	if readAfterFirst == 0 {
		t.Fatal("first request did not read the asset; the test measures nothing")
	}

	second, secondBody := get(t, url, gzip)
	if second.StatusCode != http.StatusOK {
		t.Fatalf("second request status = %d", second.StatusCode)
	}
	if got := counted.reads.Load(); got != readAfterFirst {
		t.Fatalf("second request read %d more bytes from the asset; it should have been served from the cache",
			got-readAfterFirst)
	}
	if string(secondBody) != string(firstBody) {
		t.Fatal("cached body differs from the first response")
	}
	// The negotiation is still advertised, or a shared proxy could hand gzip
	// bytes to a client that never asked for them.
	if !strings.Contains(second.Header.Get("Vary"), "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", second.Header.Get("Vary"))
	}
	if got := second.Header.Get("Content-Length"); got == "" {
		t.Error("cached response has no Content-Length")
	}

	// A HEAD from the cache must not read the file either.
	headReq, err := http.NewRequest(http.MethodHead, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	headReq.Header = gzip
	head, err := testClient.Do(headReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = head.Body.Close()
	if got := counted.reads.Load(); got != readAfterFirst {
		t.Fatalf("HEAD read %d bytes; a cached body needs no file read", got-readAfterFirst)
	}
}

// Identity clients cannot use the compressed cache, so they keep the old path:
// read the file, write it raw, and still advertise the negotiation.
func TestServeAssetIdentityStillReads(t *testing.T) {
	sub, err := fs.Sub(assets.FS, "web")
	if err != nil {
		t.Fatal(err)
	}
	name := bigAsset(t, sub)
	counted := &countingFS{inner: sub}
	ts := assetServer(t, counted)
	url := ts.URL + "/" + name

	first, body := get(t, url, nil)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", first.StatusCode)
	}
	if got := first.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("identity request Content-Encoding = %q, want none", got)
	}
	if len(body) < gzipMinBytes {
		t.Fatalf("identity body is %d bytes, want the raw asset", len(body))
	}
	readAfterFirst := counted.reads.Load()
	if readAfterFirst == 0 {
		t.Fatal("identity request did not read the asset")
	}
	if !strings.Contains(first.Header.Get("Vary"), "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", first.Header.Get("Vary"))
	}

	// And again for the second identity request: no compressed entry exists, so
	// it reads again (unchanged behaviour).
	_, second := get(t, url, nil)
	if got := counted.reads.Load(); got <= readAfterFirst {
		t.Fatalf("second identity request read %d bytes, want a fresh read", got-readAfterFirst)
	}
	if string(second) != string(body) {
		t.Fatal("identity responses differ")
	}
}
