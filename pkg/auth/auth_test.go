package auth

import "testing"

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
	d = ValidateTokenRequest(cfg, "127.0.0.1:8080", "")
	if !d.OK {
		t.Errorf("token request without origin rejected: %+v", d)
	}
}
