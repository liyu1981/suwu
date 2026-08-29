package auth

import (
	"encoding/base64"
	"testing"
)

func TestParseHostHeader(t *testing.T) {
	cases := []struct {
		in       string
		wantOK   bool
		hostname string
		port     string
	}{
		{"localhost", true, "localhost", ""},
		{"127.0.0.1:8080", true, "127.0.0.1", "8080"},
		{"[::1]:8080", true, "::1", "8080"},
		{"[::1]", true, "::1", ""},
		{"EXAMPLE.com", true, "example.com", ""},
		{"host:80", true, "host", "80"},
		{"host:0", false, "", ""},
		{"host:70000", false, "", ""},
		{"host:", false, "", ""},
		{"", false, "", ""},
		{"bad host", false, "", ""},
		{"a/b", false, "", ""},
		{"[::1", false, "", ""},
	}
	for _, c := range cases {
		h, ok := ParseHostHeader(c.in)
		if ok != c.wantOK {
			t.Errorf("ParseHostHeader(%q) ok=%v want %v", c.in, ok, c.wantOK)
			continue
		}
		if ok && (h.Hostname != c.hostname || h.Port != c.port) {
			t.Errorf("ParseHostHeader(%q) = %+v want %s/%s", c.in, h, c.hostname, c.port)
		}
	}
}

func TestLoopbackWildcard(t *testing.T) {
	for _, h := range []string{"localhost", "127.0.0.1", "::1"} {
		if !IsLoopbackHost(h) {
			t.Errorf("IsLoopbackHost(%q) = false", h)
		}
	}
	if IsLoopbackHost("example.com") {
		t.Error("IsLoopbackHost(example.com) = true")
	}
	for _, h := range []string{"0.0.0.0", "::", "*"} {
		if !IsWildcardBindHost(h) {
			t.Errorf("IsWildcardBindHost(%q) = false", h)
		}
	}
}

func TestCreateConfigAllowsLocalMachineHosts(t *testing.T) {
	t.Setenv("HOST", "0.0.0.0")
	t.Setenv("AUTH_PASS", HashPassword("test"))
	cfg, err := CreateConfig(nil)
	if err != nil {
		t.Fatal(err)
	}

	// Every detected name of this machine must be accepted as a
	// browser-visible host, without any extra configuration.
	for _, h := range localMachineHosts() {
		normalized := normalizeHostname(h)
		if normalized == "" {
			continue
		}
		if !contains(cfg.AllowedHosts, normalized) {
			t.Errorf("local host %q missing from allowed hosts %v", normalized, cfg.AllowedHosts)
		}
	}
	if !contains(cfg.AllowedHosts, "localhost") {
		t.Errorf("localhost missing from allowed hosts %v", cfg.AllowedHosts)
	}
}

func TestValidateWebSocketRequest(t *testing.T) {
	cfg := &Config{Token: "secret", AllowedHosts: []string{"localhost", "127.0.0.1"}}

	// Valid: host + matching origin + correct token.
	d := ValidateWebSocketRequest(cfg, "127.0.0.1:8080", "http://127.0.0.1:8080", "secret")
	if !d.OK {
		t.Errorf("valid request rejected: %+v", d)
	}

	// Wrong token -> 401.
	d = ValidateWebSocketRequest(cfg, "127.0.0.1:8080", "http://127.0.0.1:8080", "wrong")
	if d.OK || d.Status != 401 {
		t.Errorf("wrong token: got %+v want 401", d)
	}

	// Mismatched origin -> 403.
	d = ValidateWebSocketRequest(cfg, "127.0.0.1:8080", "http://evil.example", "secret")
	if d.OK || d.Status != 403 {
		t.Errorf("bad origin: got %+v want 403", d)
	}

	// Disallowed host -> 403.
	d = ValidateWebSocketRequest(cfg, "example.com", "http://example.com", "secret")
	if d.OK || d.Status != 403 {
		t.Errorf("bad host: got %+v want 403", d)
	}

	// Token request origin optional.
	d = ValidateTokenRequest(cfg, "127.0.0.1:8080", "", "")
	if !d.OK {
		t.Errorf("token request without origin rejected: %+v", d)
	}
}

func TestValidateTokenRequestNoPassword(t *testing.T) {
	cfg := &Config{Token: "tok", AllowedHosts: []string{"localhost"}}

	// No password required: any request passes.
	d := ValidateTokenRequest(cfg, "localhost", "", "")
	if !d.OK {
		t.Errorf("no-password request rejected: %+v", d)
	}
}

func TestValidateTokenRequestWithPassword(t *testing.T) {
	hash := HashPassword("secret123")
	cfg := &Config{Token: "tok", AllowedHosts: []string{"localhost"}, PasswordHash: hash}

	// No auth header -> 401.
	d := ValidateTokenRequest(cfg, "localhost", "", "")
	if d.OK || d.Status != 401 {
		t.Errorf("no auth header: got %+v want 401", d)
	}

	// Wrong password -> 401.
	cred := base64.StdEncoding.EncodeToString([]byte("user:wrong"))
	d = ValidateTokenRequest(cfg, "localhost", "", "Basic "+cred)
	if d.OK || d.Status != 401 {
		t.Errorf("wrong password: got %+v want 401", d)
	}

	// Correct password -> 200.
	cred = base64.StdEncoding.EncodeToString([]byte("user:secret123"))
	d = ValidateTokenRequest(cfg, "localhost", "", "Basic "+cred)
	if !d.OK {
		t.Errorf("correct password rejected: %+v", d)
	}
}

func TestHashPassword(t *testing.T) {
	// Same input produces same hash.
	h1 := HashPassword("hello")
	h2 := HashPassword("hello")
	if h1 != h2 {
		t.Errorf("HashPassword('hello') not deterministic: %s != %s", h1, h2)
	}
	// Different input produces different hash.
	h3 := HashPassword("world")
	if h1 == h3 {
		t.Error("HashPassword('hello') == HashPassword('world')")
	}
}

func TestCreateConfigExplicitHostWithoutAuthPass(t *testing.T) {
	// Explicit host without AUTH_PASS: valid, no password required.
	t.Setenv("HOST", "0.0.0.0")
	t.Setenv("AUTH_PASS", "")
	cfg, err := CreateConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PasswordHash != "" {
		t.Errorf("no AUTH_PASS should mean no password, got PasswordHash=%q", cfg.PasswordHash)
	}
}

func TestCreateConfigAutoNoPassword(t *testing.T) {
	t.Setenv("HOST", "auto")
	t.Setenv("AUTH_PASS", "")
	cfg, err := CreateConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PasswordHash != "" {
		t.Errorf("HOST=auto should not require password, got PasswordHash=%q", cfg.PasswordHash)
	}
}

func TestCreateConfigAuthPassWithDefaultHost(t *testing.T) {
	// AUTH_PASS set with default HOST: password is required.
	hash := HashPassword("mypass")
	t.Setenv("HOST", "")
	t.Setenv("AUTH_PASS", hash)
	cfg, err := CreateConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BindHost != "127.0.0.1" {
		t.Errorf("bind host = %q, want 127.0.0.1", cfg.BindHost)
	}
	if cfg.PasswordHash != hash {
		t.Errorf("PasswordHash = %q, want %q", cfg.PasswordHash, hash)
	}
}

func TestCreateConfigAuthPassWithAutoHost(t *testing.T) {
	// AUTH_PASS set with HOST=auto: password is required.
	hash := HashPassword("mypass")
	t.Setenv("HOST", "auto")
	t.Setenv("AUTH_PASS", hash)
	cfg, err := CreateConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PasswordHash != hash {
		t.Errorf("PasswordHash = %q, want %q", cfg.PasswordHash, hash)
	}
}

func TestCreateConfigDefaultNoPassword(t *testing.T) {
	t.Setenv("HOST", "")
	t.Setenv("AUTH_PASS", "")
	cfg, err := CreateConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BindHost != "127.0.0.1" {
		t.Errorf("default bind host = %q, want 127.0.0.1", cfg.BindHost)
	}
	if cfg.PasswordHash != "" {
		t.Error("default config should not require password")
	}
}
