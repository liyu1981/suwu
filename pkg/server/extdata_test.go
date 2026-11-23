package server

// Tests for /api/ext/data/<id>[/<key>]: the server half of the extension storage
// bridge. The interesting cases are namespacing (one extension cannot reach
// another), the value contract (JSON, capped) and that a missing record is a 404
// rather than an empty success — the note app distinguishes "no server copy yet"
// from "the server says nothing".

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func extDataURL(base, suffix string) string {
	return base + "/api/ext/data/" + suffix
}

func doExtData(t *testing.T, method, url string, body any) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func TestExtDataRoundTrip(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)
	url := extDataURL(ts.URL, "note/v2?token=testtoken")

	// Nothing stored yet: a 404, not an empty value.
	if status, _ := doExtData(t, http.MethodGet, url, nil); status != http.StatusNotFound {
		t.Fatalf("missing record: status %d", status)
	}
	doc := map[string]any{"v": 2, "active": 1, "notes": []any{"a", "b"}}
	if status, body := doExtData(t, http.MethodPut, url, doc); status != http.StatusOK || body["ok"] != true {
		t.Fatalf("PUT: %d %v", status, body)
	}
	status, body := doExtData(t, http.MethodGet, url, nil)
	if status != http.StatusOK {
		t.Fatalf("GET: %d", status)
	}
	value, _ := body["value"].(map[string]any)
	if value["v"] != float64(2) || value["active"] != float64(1) {
		t.Fatalf("value round-trip: %v", body["value"])
	}
	// It is on disk where the layout says, so a backup/tar of the data dir has it.
	if _, err := os.Stat(filepath.Join(dataDir, "extension-data", "note", "v2.json")); err != nil {
		t.Fatalf("record not on disk: %v", err)
	}
	// A bare JSON body is accepted as well as {"value": …}.
	raw, _ := http.NewRequest(http.MethodPut, url, strings.NewReader(`{"v":2}`))
	raw.Header.Set("Content-Type", "application/json")
	if resp, err := http.DefaultClient.Do(raw); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("bare body: %v %v", resp, err)
	}
	if status, _ := doExtData(t, http.MethodDelete, url, nil); status != http.StatusOK {
		t.Fatalf("DELETE: %d", status)
	}
	if status, _ := doExtData(t, http.MethodGet, url, nil); status != http.StatusNotFound {
		t.Fatalf("after DELETE: %d", status)
	}
}

func TestExtDataNamesAreEnforced(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)
	for _, suffix := range []string{
		"../note/v2?token=testtoken",
		"note/../v2?token=testtoken",
		"note/a%20b?token=testtoken",
		"note/" + strings.Repeat("a", 65) + "?token=testtoken",
	} {
		if status, _ := doExtData(t, http.MethodPut, extDataURL(ts.URL, suffix), map[string]any{"x": 1}); status != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", suffix, status)
		}
	}
	if _, err := os.Stat(filepath.Join(dataDir, "extension-data")); !os.IsNotExist(err) {
		t.Fatal("a rejected request created the tree")
	}
}

func TestExtDataIsNamespacedPerExtension(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	if status, _ := doExtData(t, http.MethodPut, extDataURL(ts.URL, "note/v2?token=testtoken"), map[string]any{"v": 2}); status != http.StatusOK {
		t.Fatalf("PUT: %d", status)
	}
	if status, _ := doExtData(t, http.MethodGet, extDataURL(ts.URL, "eye/v2?token=testtoken"), nil); status != http.StatusNotFound {
		t.Fatalf("another extension saw the record: %d", status)
	}
	status, body := doExtData(t, http.MethodGet, extDataURL(ts.URL, "note?token=testtoken"), nil)
	if status != http.StatusOK {
		t.Fatalf("list: %d", status)
	}
	keys, _ := body["keys"].([]any)
	if len(keys) != 1 || keys[0] != "v2" {
		t.Fatalf("keys %v", body["keys"])
	}
	if status, body := doExtData(t, http.MethodGet, extDataURL(ts.URL, "eye?token=testtoken"), nil); status != http.StatusOK {
		t.Fatalf("empty list: %d %v", status, body)
	} else if keys, ok := body["keys"].([]any); !ok || len(keys) != 0 {
		t.Fatalf("empty list is not an empty array: %v", body["keys"])
	}
}

func TestExtDataRequiresAuthAndValidJSON(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	if status, _ := doExtData(t, http.MethodPut, extDataURL(ts.URL, "note/v2"), map[string]any{"v": 2}); status != http.StatusUnauthorized {
		t.Fatalf("no token: %d", status)
	}
	req, _ := http.NewRequest(http.MethodPut, extDataURL(ts.URL, "note/v2?token=testtoken"), strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("non-JSON body: %d", resp.StatusCode)
	}
	// Oversized values are refused with 413, and nothing is written.
	big := `{"v":2,"pad":"` + strings.Repeat("x", 512_001) + `"}`
	req, _ = http.NewRequest(http.MethodPut, extDataURL(ts.URL, "note/v2?token=testtoken"), strings.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized: %d", resp.StatusCode)
	}
	if status, _ := doExtData(t, http.MethodGet, extDataURL(ts.URL, "note/v2?token=testtoken"), nil); status != http.StatusNotFound {
		t.Fatal("an oversized value was stored")
	}
}

func TestExtDataMethods(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)
	req, _ := http.NewRequest(http.MethodPost, extDataURL(ts.URL, "note/v2?token=testtoken"), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", resp.StatusCode)
	}
}
