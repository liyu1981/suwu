package server

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"suwu/pkg/assets"
	"suwu/pkg/auth"
	"suwu/pkg/forward"
	"suwu/pkg/session"
)

const backupSlot = "abcdefghijklmnopqrstuvwxyz"

// backupContainer builds the byte shape the browser produces: magic, header
// length, JSON header, opaque ciphertext. The server checks only the prologue,
// so the payload here stands in for a real encrypted blob.
func backupContainer(gen int) []byte {
	header := []byte(`{"v":1,"gen":` + strconv.Itoa(gen) + `}`)
	out := append([]byte("SUWUBK1"), 0, 0, 0, 0)
	binary.BigEndian.PutUint32(out[len("SUWUBK1"):], uint32(len(header)))
	out = append(out, header...)
	return append(out, []byte("encrypted-payload")...)
}

// backupServer starts a server with a real data dir, so the backup store is
// actually on disk.
func backupServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	cfg := &auth.Config{
		Token:        "testtoken",
		BindHost:     "127.0.0.1",
		AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
	}
	sub, err := fs.Sub(assets.FS, "web")
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := session.NewManager()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sessions.Close() })
	srv := New(cfg, sub, sessions, nil, forward.NewManager(), dir)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, dir
}

// putBackup uploads one generation and returns the decoded response.
func putBackup(t *testing.T, ts *httptest.Server, query string, body []byte) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/backup"+query, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer testtoken")
	req.Header.Set(backupSlotHeader, backupSlot)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	decoded := map[string]any{}
	_ = json.Unmarshal(raw, &decoded)
	return resp, decoded
}

func getBackup(t *testing.T, ts *httptest.Server, path string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer testtoken")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp, raw
}

func TestBackupPutAndDownload(t *testing.T) {
	ts, dir := backupServer(t)
	blob := backupContainer(1)

	resp, decoded := putBackup(t, ts, "", blob)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if decoded["gen"].(float64) != 1 {
		t.Fatalf("gen = %v, want 1", decoded["gen"])
	}

	resp, got := getBackup(t, ts, "/api/backup/blob?slot="+backupSlot+"&gen=1")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !bytes.Equal(got, blob) {
		t.Fatal("downloaded bytes differ from what was uploaded")
	}
	if cd := resp.Header.Get("Content-Disposition"); !bytes.Contains([]byte(cd), []byte("attachment")) {
		t.Fatalf("content-disposition = %q, want an attachment", cd)
	}

	// The blob is on disk under the data dir, and it is the ciphertext.
	onDisk := filepath.Join(dir, "backup", backupSlot, "g00000001.bin")
	data, err := os.ReadFile(onDisk)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, blob) {
		t.Fatal("stored blob differs from what was uploaded")
	}
}

func TestBackupMetaListsGenerations(t *testing.T) {
	ts, _ := backupServer(t)
	for i := 0; i < 3; i++ {
		if resp, _ := putBackup(t, ts, "", backupContainer(i+1)); resp.StatusCode != http.StatusOK {
			t.Fatalf("put %d: status %d", i, resp.StatusCode)
		}
	}
	resp, raw := getBackup(t, ts, "/api/backup/meta?slot="+backupSlot)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var meta struct {
		Slot        string `json:"slot"`
		Generations []struct {
			Gen  int64  `json:"gen"`
			Size int64  `json:"size"`
			// The plaintext must never appear in the index.
			Plain string `json:"plaintext"`
		} `json:"generations"`
		Bytes int64 `json:"bytes"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Slot != backupSlot || len(meta.Generations) != 3 {
		t.Fatalf("meta = %s", raw)
	}
	for i, g := range meta.Generations {
		if g.Gen != int64(i+1) {
			t.Fatalf("gen[%d] = %d", i, g.Gen)
		}
		if g.Plain != "" {
			t.Fatal("index carries a plaintext field")
		}
	}
	if meta.Bytes == 0 {
		t.Fatal("bytes = 0")
	}
}

func TestBackupMetaOnEmptySlotIsNotAnError(t *testing.T) {
	ts, _ := backupServer(t)
	resp, raw := getBackup(t, ts, "/api/backup/meta?slot="+backupSlot)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !bytes.Contains(raw, []byte(`"generations":[]`)) {
		t.Fatalf("body = %s, want an empty generation list", raw)
	}
}

func TestBackupConflictOnStaleBase(t *testing.T) {
	ts, _ := backupServer(t)
	if resp, _ := putBackup(t, ts, "", backupContainer(1)); resp.StatusCode != http.StatusOK {
		t.Fatalf("first put: status %d", resp.StatusCode)
	}
	// Another browser wrote generation 1; this one still thinks the slot is
	// empty, so its upload must not silently win.
	resp, decoded := putBackup(t, ts, "?base=0", backupContainer(2))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", resp.StatusCode)
	}
	if decoded["error"] != "conflict" || decoded["currentGen"].(float64) != 1 {
		t.Fatalf("decoded = %v", decoded)
	}
	// With the right base it goes through as generation 2.
	if resp, _ := putBackup(t, ts, "?base=1", backupContainer(2)); resp.StatusCode != http.StatusOK {
		t.Fatalf("matching base: status %d", resp.StatusCode)
	}
}

func TestBackupRejectsBadInput(t *testing.T) {
	ts, _ := backupServer(t)

	cases := []struct {
		name  string
		query string
		slot  string
		body  []byte
		want  int
	}{
		{"missing slot", "", "", backupContainer(1), http.StatusBadRequest},
		{"traversal slot", "", "../../etc", backupContainer(1), http.StatusBadRequest},
		{"short slot", "", "abc", backupContainer(1), http.StatusBadRequest},
		{"bad base", "?base=abc", backupSlot, backupContainer(1), http.StatusBadRequest},
		{"negative base", "?base=-4", backupSlot, backupContainer(1), http.StatusBadRequest},
		{"garbage body", "", backupSlot, []byte("not a container at all"), http.StatusBadRequest},
		{"empty body", "", backupSlot, nil, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/backup"+tc.query, bytes.NewReader(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer testtoken")
			if tc.slot != "" {
				req.Header.Set(backupSlotHeader, tc.slot)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.want)
			}
		})
	}
}

func TestBackupRequiresAuth(t *testing.T) {
	ts, _ := backupServer(t)
	for _, path := range []string{
		"/api/backup/meta?slot=" + backupSlot,
		"/api/backup/blob?slot=" + backupSlot + "&gen=1",
	} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s: status = %d, want 401", path, resp.StatusCode)
		}
	}

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/backup", bytes.NewReader(backupContainer(1)))
	req.Header.Set(backupSlotHeader, backupSlot)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("upload without auth: status = %d, want 401", resp.StatusCode)
	}
}

func TestBackupDeleteRequiresConfirm(t *testing.T) {
	ts, _ := backupServer(t)
	if resp, _ := putBackup(t, ts, "", backupContainer(1)); resp.StatusCode != http.StatusOK {
		t.Fatalf("put: status %d", resp.StatusCode)
	}

	doDelete := func(query string) int {
		req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/backup"+query, nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if got := doDelete("?slot=" + backupSlot); got != http.StatusBadRequest {
		t.Fatalf("delete without confirm: status = %d, want 400", got)
	}
	if got := doDelete("?slot=" + backupSlot + "&confirm=" + backupSlot + "x"); got != http.StatusBadRequest {
		t.Fatalf("delete with wrong confirm: status = %d, want 400", got)
	}
	// Still there after the refused attempts.
	resp, _ := getBackup(t, ts, "/api/backup/meta?slot="+backupSlot)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("meta after refused deletes: status %d", resp.StatusCode)
	}
	if got := doDelete("?slot=" + backupSlot + "&confirm=" + backupSlot); got != http.StatusOK {
		t.Fatalf("delete: status = %d, want 200", got)
	}
	resp, raw := getBackup(t, ts, "/api/backup/meta?slot="+backupSlot)
	if resp.StatusCode != http.StatusOK || !bytes.Contains(raw, []byte(`"generations":[]`)) {
		t.Fatalf("slot survived delete: %d %s", resp.StatusCode, raw)
	}
}

func TestBackupBlobNotFound(t *testing.T) {
	ts, _ := backupServer(t)
	resp, _ := getBackup(t, ts, "/api/backup/blob?slot="+backupSlot+"&gen=7")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	resp, _ = getBackup(t, ts, "/api/backup/blob?slot="+backupSlot+"&gen=0")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("gen=0: status = %d, want 400", resp.StatusCode)
	}
}

func TestBackupRejectsOversizedUpload(t *testing.T) {
	ts, _ := backupServer(t)
	huge := backupContainer(1)
	huge = append(huge, make([]byte, 16<<20)...)
	resp, _ := putBackup(t, ts, "", huge)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
}

func TestBackupMethodNotAllowed(t *testing.T) {
	ts, _ := backupServer(t)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/backup", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.StatusCode)
	}
	if allow := resp.Header.Get("Allow"); allow != "POST, DELETE" {
		t.Fatalf("allow = %q", allow)
	}
}

// A server with no data directory keeps serving everything else; only the
// backup endpoints report the missing store.
func TestBackupWithoutDataDir(t *testing.T) {
	ts, _ := testServer(t)
	resp, _ := getBackup(t, ts, "/api/backup/meta?slot="+backupSlot)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	resp, err := http.Get(ts.URL + "/api/server-info")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusOK {
		t.Fatalf("server-info status = %d", resp.StatusCode)
	}
}
