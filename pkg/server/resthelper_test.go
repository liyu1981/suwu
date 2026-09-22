package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRESTRequestBasic(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer target.Close()

	s := &Server{}
	resp := s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: target.URL})

	if resp.Status != http.StatusTeapot {
		t.Fatalf("status = %d, want 418", resp.Status)
	}
	body, _ := base64.StdEncoding.DecodeString(resp.BodyB64)
	if string(body) != `{"ok":true}` {
		t.Fatalf("body = %q", body)
	}
	if got := resp.Headers["Content-Type"]; len(got) == 0 || got[0] != "application/json" {
		t.Fatalf("content-type headers = %v", got)
	}
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
}

func TestRESTRequestHeadersAndBody(t *testing.T) {
	type echo struct {
		method string
		values []string
		body   string
		ct     string
	}
	got := make(chan echo, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got <- echo{method: r.Method, values: r.Header.Values("X-Multi"), body: string(b), ct: r.Header.Get("Content-Type")}
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	s := &Server{}
	resp := s.executeRESTRequest(context.Background(), &restRequest{
		Method:   "POST",
		URL:      target.URL,
		BodyType: "json",
		Body:     `{"a":1}`,
		Headers: []restHeader{
			{Key: "X-Multi", Value: "one", Enabled: true},
			{Key: "X-Multi", Value: "two", Enabled: true},
			{Key: "X-Skip", Value: "no", Enabled: false},
			{Key: "Content-Type", Value: "application/json", Enabled: true},
		},
	})
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	e := <-got
	if e.method != "POST" || e.body != `{"a":1}` || e.ct != "application/json" {
		t.Fatalf("echo = %+v", e)
	}
	if len(e.values) != 2 || e.values[0] != "one" || e.values[1] != "two" {
		t.Fatalf("duplicate headers not preserved: %v", e.values)
	}
}

func TestRESTSetCookieMultiValue(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "a", Value: "1", Path: "/"})
		http.SetCookie(w, &http.Cookie{Name: "b", Value: "2", Path: "/"})
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	s := &Server{}
	resp := s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: target.URL})
	if got := len(resp.Headers["Set-Cookie"]); got != 2 {
		t.Fatalf("Set-Cookie count = %d, want 2 (%v)", got, resp.Headers["Set-Cookie"])
	}
}

func TestRESTUserAgentModes(t *testing.T) {
	seen := make(chan string, 4)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	s := &Server{}
	cases := []struct {
		name     string
		req      *restRequest
		want     string
		explicit bool
	}{
		{"default", &restRequest{Method: "GET", URL: target.URL}, "SuwuREST/", false},
		{"browser", &restRequest{Method: "GET", URL: target.URL, UserAgentMode: "browser", BrowserUserAgent: "Browser/1.0"}, "Browser/1.0", false},
		{"custom", &restRequest{Method: "GET", URL: target.URL, UserAgentMode: "custom", CustomUserAgent: "MyAgent/2"}, "MyAgent/2", false},
		{"explicit-overrides", &restRequest{Method: "GET", URL: target.URL, UserAgentMode: "browser", BrowserUserAgent: "Browser/1.0", Headers: []restHeader{{Key: "User-Agent", Value: "Explicit/3", Enabled: true}}}, "Explicit/3", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := s.executeRESTRequest(context.Background(), tc.req)
			if resp.Error != "" {
				t.Fatalf("error: %s", resp.Error)
			}
			ua := <-seen
			if tc.explicit {
				if ua != tc.want {
					t.Fatalf("UA = %q, want %q", ua, tc.want)
				}
				return
			}
			if !strings.HasPrefix(ua, tc.want) {
				t.Fatalf("UA = %q, want prefix %q", ua, tc.want)
			}
		})
	}
}

func TestRESTRedirects(t *testing.T) {
	var targetURL string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, targetURL+"/end", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("done"))
	}))
	defer target.Close()
	targetURL = target.URL

	s := &Server{}
	follow := true
	resp := s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: target.URL + "/start", FollowRedirects: &follow})
	if resp.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	if len(resp.Redirects) != 1 || !strings.HasSuffix(resp.Redirects[0], "/end") {
		t.Fatalf("redirects = %v", resp.Redirects)
	}
	body, _ := base64.StdEncoding.DecodeString(resp.BodyB64)
	if string(body) != "done" {
		t.Fatalf("body = %q", body)
	}

	no := false
	resp = s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: target.URL + "/start", FollowRedirects: &no})
	if resp.Status != http.StatusFound {
		t.Fatalf("no-follow status = %d, want 302", resp.Status)
	}
}

func TestRESTInsecureTLS(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("secure"))
	}))
	defer target.Close()

	s := &Server{}
	resp := s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: target.URL})
	if resp.ErrorKind != "tls" {
		t.Fatalf("expected tls error, got kind=%q err=%q", resp.ErrorKind, resp.Error)
	}

	resp = s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: target.URL, InsecureTLS: true})
	if resp.Error != "" || resp.Status != http.StatusOK {
		t.Fatalf("insecure TLS failed: status=%d err=%q", resp.Status, resp.Error)
	}
	if !resp.InsecureTLS {
		t.Fatal("InsecureTLS flag not echoed")
	}
}

func TestRESTTruncation(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 2048)))
	}))
	defer target.Close()

	s := &Server{}
	resp := s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: target.URL, MaxResponseBytes: 100})
	if !resp.Truncated {
		t.Fatal("expected truncated=true")
	}
	if resp.BodySize != 100 {
		t.Fatalf("bodySize = %d, want 100", resp.BodySize)
	}
}

func TestRESTTimeout(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	s := &Server{}
	start := time.Now()
	resp := s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: target.URL, TimeoutMs: 1000})
	if resp.ErrorKind != "timeout" {
		t.Fatalf("errorKind = %q, want timeout (err=%q)", resp.ErrorKind, resp.Error)
	}
	if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
		t.Fatalf("timeout took too long: %s", elapsed)
	}
}

func TestRESTConnectionRefused(t *testing.T) {
	// Bind then immediately close to obtain a definitely-unused port.
	l := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := l.URL
	l.Close()

	s := &Server{}
	resp := s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: url})
	if resp.ErrorKind != "refused" {
		t.Fatalf("errorKind = %q, want refused (err=%q)", resp.ErrorKind, resp.Error)
	}
}

func TestRESTFormDataAndURLEncoded(t *testing.T) {
	cases := []struct {
		name     string
		bodyType string
		wantCT   string
	}{
		{"form-data", "form-data", "multipart/form-data"},
		{"urlencoded", "urlencoded", "application/x-www-form-urlencoded"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := make(chan string, 1)
			body := make(chan string, 1)
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				body <- string(b)
				got <- r.Header.Get("Content-Type")
				w.WriteHeader(http.StatusOK)
			}))
			defer target.Close()

			s := &Server{}
			resp := s.executeRESTRequest(context.Background(), &restRequest{
				Method:   "POST",
				URL:      target.URL,
				BodyType: tc.bodyType,
				FormData: []restFormEntry{
					{Key: "field", Value: "value", Type: "text", Enabled: true},
					{Key: "file", Type: "file", Filename: "hello.txt", ContentB64: base64.StdEncoding.EncodeToString([]byte("file-content")), Enabled: true},
					{Key: "off", Value: "ignored", Type: "text", Enabled: false},
				},
			})
			if resp.Error != "" {
				t.Fatalf("error: %s", resp.Error)
			}
			if ct := <-got; !strings.HasPrefix(ct, tc.wantCT) {
				t.Fatalf("content-type = %q, want prefix %q", ct, tc.wantCT)
			}
			b := <-body
			if !strings.Contains(b, "value") {
				t.Fatalf("body missing field value: %q", b)
			}
			if tc.bodyType == "form-data" && !strings.Contains(b, "file-content") {
				t.Fatalf("body missing file content: %q", b)
			}
		})
	}
}

func TestRESTHandlerRejectsBadRequests(t *testing.T) {
	ts, cfg := testServer(t)

	post := func(t *testing.T, payload string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "http://localhost/api/rest/request", strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		ts.Config.Handler.ServeHTTP(w, req)
		return w
	}

	t.Run("missing-url", func(t *testing.T) {
		w := post(t, `{"method":"GET"}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
	})

	t.Run("wrong-method", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "http://localhost/api/rest/request", nil)
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
		w := httptest.NewRecorder()
		ts.Config.Handler.ServeHTTP(w, req)
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", w.Code)
		}
	})

	t.Run("unauthorized", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "http://localhost/api/rest/request", strings.NewReader(`{"method":"GET","url":"http://example.com"}`))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		ts.Config.Handler.ServeHTTP(w, req)
		if w.Code == http.StatusOK {
			t.Fatalf("unauthenticated request was allowed")
		}
	})
}

func TestRESTHandlerRoundTrip(t *testing.T) {
	ts, cfg := testServer(t)

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"hello":"world"}`))
	}))
	defer target.Close()

	payload := `{"method":"GET","url":"` + target.URL + `","headers":[],"bodyType":"none"}`
	req := httptest.NewRequest(http.MethodPost, "http://localhost/api/rest/request", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	ts.Config.Handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", w.Code, w.Body.String())
	}
	var resp restResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if resp.Status != http.StatusOK {
		t.Fatalf("response status = %d, want 200", resp.Status)
	}
	body, _ := base64.StdEncoding.DecodeString(resp.BodyB64)
	if string(body) != `{"hello":"world"}` {
		t.Fatalf("body = %q", body)
	}
}

func TestRESTRedirectsEmptyNotNull(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	s := &Server{}
	resp := s.executeRESTRequest(context.Background(), &restRequest{Method: "GET", URL: target.URL})
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"redirects":[]`) {
		t.Fatalf("redirects must serialize as [] not null: %s", b)
	}
}

func TestRESTEnvelopeJSONRoundTrip(t *testing.T) {
	resp := restResponse{Status: 200, Headers: map[string][]string{"A": {"b"}}, BodyB64: "eA=="}
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var back restResponse
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.Headers["A"][0] != "b" || back.BodyB64 != "eA==" {
		t.Fatalf("round trip = %+v", back)
	}
}
