package server

// Tests for login sessions: two devices with the same password, renewal,
// rotation, revocation, persistence across a restart, and the "sign out
// everywhere" path.

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"suwu/pkg/assets"
	"suwu/pkg/auth"
	"suwu/pkg/forward"
	"suwu/pkg/session"
)

// sessionServer builds a server on a real data dir (sessions persist there) with
// a password.
func sessionServer(t *testing.T, dataDir string) (*httptest.Server, *auth.Config) {
	t.Helper()
	cfg := &auth.Config{
		Token:        "legacy-token",
		TokenExpiry:  timeNowPlusHour(),
		SigningKey:   auth.GenerateSigningKey("legacy-token"),
		BindHost:     "127.0.0.1",
		AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
		PasswordHash: auth.HashPassword("secret"),
		Sessions:     auth.NewRegistry(),
	}
	sub, err := fs.Sub(assets.FS, "web")
	if err != nil {
		t.Fatal(err)
	}
	mgr, err := session.NewManager()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mgr.Close() })
	srv := New(cfg, sub, mgr, nil, forward.NewManager(), dataDir)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, cfg
}

// login mints a session with the password, as a device does on its first visit.
func login(t *testing.T, ts *httptest.Server, ua string) (token, id string) {
	t.Helper()
	req, _ := http.NewRequest("GET", ts.URL+"/api/token", nil)
	req.Header.Set("Authorization", "Basic "+basic("user", "secret"))
	req.Header.Set("User-Agent", ua)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("login: %d %s", resp.StatusCode, body)
	}
	var body struct {
		Token   string `json:"token"`
		Session struct {
			ID    string `json:"id"`
			Label string `json:"label"`
		} `json:"session"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Token, body.Session.ID
}

func basic(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}

func timeNowPlusHour() time.Time { return time.Now().Add(time.Hour) }

func apiGet(t *testing.T, ts *httptest.Server, path, token string) int {
	t.Helper()
	req, _ := http.NewRequest("GET", ts.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

// The reported bug: a phone logging in logged the desktop out. With sessions,
// two devices hold two credentials and neither renewal touches the other.
func TestTwoDevicesKeepTheirOwnSessions(t *testing.T) {
	ts, _ := sessionServer(t, t.TempDir())
	desktop, desktopID := login(t, ts, "Mozilla/5.0 (Macintosh) Chrome/120")
	phone, phoneID := login(t, ts, "Mozilla/5.0 (iPhone) Safari/604")

	if desktopID == phoneID {
		t.Fatal("two logins produced one session")
	}
	if !strings.Contains(desktop, auth.TokenPrefix) || !strings.Contains(phone, auth.TokenPrefix) {
		t.Fatalf("tokens are not sessions: %q %q", desktop, phone)
	}
	if code := apiGet(t, ts, "/api/extensions", desktop); code != http.StatusOK {
		t.Fatalf("desktop token: %d", code)
	}
	if code := apiGet(t, ts, "/api/extensions", phone); code != http.StatusOK {
		t.Fatalf("phone token: %d", code)
	}

	// The phone renews; the desktop must still work, and vice versa.
	req, _ := http.NewRequest("GET", ts.URL+"/api/token", nil)
	req.Header.Set("Authorization", "Bearer "+phone)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var renewed struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&renewed)
	if renewed.Token != phone {
		t.Fatalf("renewal changed the token: %q -> %q", phone, renewed.Token)
	}
	if code := apiGet(t, ts, "/api/extensions", desktop); code != http.StatusOK {
		t.Fatalf("the desktop was logged out by the phone's renewal: %d", code)
	}

	// The list labels both devices and marks neither as current for this token.
	req, _ = http.NewRequest("GET", ts.URL+"/api/sessions", nil)
	req.Header.Set("Authorization", "Bearer "+desktop)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp2.Body.Close() }()
	var list struct {
		Sessions []struct {
			ID      string `json:"id"`
			Label   string `json:"label"`
			Current bool   `json:"current"`
		} `json:"sessions"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Sessions) != 2 {
		t.Fatalf("sessions: %+v", list.Sessions)
	}
	labels := map[string]string{}
	for _, s := range list.Sessions {
		labels[s.ID] = s.Label
		if s.ID == desktopID && !s.Current {
			t.Error("the caller's own session is not marked current")
		}
	}
	if !strings.Contains(labels[desktopID], "Mac") || !strings.Contains(labels[phoneID], "iPhone") {
		t.Fatalf("labels: %v", labels)
	}
}

func TestRevokeOneDeviceLeavesTheOther(t *testing.T) {
	ts, _ := sessionServer(t, t.TempDir())
	desktop, _ := login(t, ts, "Chrome on Linux")
	phone, phoneID := login(t, ts, "iPhone Safari")

	req, _ := http.NewRequest("DELETE", ts.URL+"/api/sessions/"+phoneID, nil)
	req.Header.Set("Authorization", "Bearer "+desktop)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("revoke: %d", resp.StatusCode)
	}
	if code := apiGet(t, ts, "/api/extensions", phone); code != http.StatusUnauthorized {
		t.Fatalf("the revoked phone still works: %d", code)
	}
	if code := apiGet(t, ts, "/api/extensions", desktop); code != http.StatusOK {
		t.Fatalf("revoking the phone logged the desktop out: %d", code)
	}
	// Revoking an unknown session is a 404, not a silent success.
	req, _ = http.NewRequest("DELETE", ts.URL+"/api/sessions/nope", nil)
	req.Header.Set("Authorization", "Bearer "+desktop)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp2.Body.Close() }()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown session: %d", resp2.StatusCode)
	}
}

func TestRotateInvalidatesOnlyThatToken(t *testing.T) {
	ts, _ := sessionServer(t, t.TempDir())
	desktop, _ := login(t, ts, "desktop")
	phone, _ := login(t, ts, "phone")

	req, _ := http.NewRequest("POST", ts.URL+"/api/token/rotate", nil)
	req.Header.Set("Authorization", "Bearer "+desktop)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rotate: %d", resp.StatusCode)
	}
	var body struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if body.Token == desktop || !strings.HasPrefix(body.Token, auth.TokenPrefix) {
		t.Fatalf("rotate token %q", body.Token)
	}
	if code := apiGet(t, ts, "/api/extensions", desktop); code != http.StatusUnauthorized {
		t.Fatalf("the old token survived rotation: %d", code)
	}
	if code := apiGet(t, ts, "/api/extensions", body.Token); code != http.StatusOK {
		t.Fatalf("the rotated token does not work: %d", code)
	}
	if code := apiGet(t, ts, "/api/extensions", phone); code != http.StatusOK {
		t.Fatalf("rotating the desktop logged the phone out: %d", code)
	}
}

func TestRevokeAllKeepsOrDropsTheCaller(t *testing.T) {
	ts, _ := sessionServer(t, t.TempDir())
	desktop, _ := login(t, ts, "desktop")
	phone, _ := login(t, ts, "phone")

	post := func(body string, token string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", ts.URL+"/api/sessions/revoke-all", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	if code, out := post(`{"keepCurrent":true}`, desktop); code != http.StatusOK || out["revoked"] != float64(1) {
		t.Fatalf("keep current: %d %v", code, out)
	}
	if code := apiGet(t, ts, "/api/extensions", phone); code != http.StatusUnauthorized {
		t.Fatalf("phone survived revoke-all: %d", code)
	}
	if code := apiGet(t, ts, "/api/extensions", desktop); code != http.StatusOK {
		t.Fatalf("the caller was signed out despite keepCurrent: %d", code)
	}

	// Signing out everywhere re-mints for the caller.
	code, out := post(`{"keepCurrent":false}`, desktop)
	if code != http.StatusOK {
		t.Fatalf("hard revoke: %d", code)
	}
	fresh, _ := out["token"].(string)
	if fresh == "" || fresh == desktop {
		t.Fatalf("no fresh token after signing out everywhere: %v", out)
	}
	if code := apiGet(t, ts, "/api/extensions", desktop); code != http.StatusUnauthorized {
		t.Fatalf("the old token survived: %d", code)
	}
	if code := apiGet(t, ts, "/api/extensions", fresh); code != http.StatusOK {
		t.Fatalf("the fresh token does not work: %d", code)
	}
}

// A restart must not sign every device out: that is half of what sessions are
// for (the other half is `suwu upgrade` restarting the daemon).
func TestSessionsSurviveARestart(t *testing.T) {
	dataDir := t.TempDir()
	first, _ := sessionServer(t, dataDir)
	token, id := login(t, first, "desktop")
	path := filepath.Join(dataDir, "auth", "sessions.json")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("sessions not persisted: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("session file mode %o, want 0600", info.Mode().Perm())
	}
	first.Close()

	second, _ := sessionServer(t, dataDir)
	if code := apiGet(t, second, "/api/extensions", token); code != http.StatusOK {
		t.Fatalf("a restart logged the device out: %d", code)
	}
	if id == "" {
		t.Fatal("no session id")
	}
	if second == nil {
		t.Fatal("no server")
	}
}

// A password change voids every stored session: "change the password" has to
// mean "sign every device out", or it means nothing.
func TestPasswordChangeVoidsStoredSessions(t *testing.T) {
	dataDir := t.TempDir()
	ts, _ := sessionServer(t, dataDir)
	token, _ := login(t, ts, "desktop")
	ts.Close()

	// A second server on the same data dir with a different password.
	cfg := &auth.Config{
		Token: "legacy", TokenExpiry: timeNowPlusHour(), SigningKey: auth.GenerateSigningKey("legacy"),
		BindHost: "127.0.0.1", AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
		PasswordHash: auth.HashPassword("a different password"),
		Sessions:     auth.NewRegistry(),
	}
	sub, _ := fs.Sub(assets.FS, "web")
	mgr, err := session.NewManager()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mgr.Close() })
	srv := New(cfg, sub, mgr, nil, forward.NewManager(), dataDir)
	other := httptest.NewServer(srv.Handler())
	t.Cleanup(other.Close)

	if code := apiGet(t, other, "/api/extensions", token); code != http.StatusUnauthorized {
		t.Fatalf("a session from before the password change still works: %d", code)
	}
}
