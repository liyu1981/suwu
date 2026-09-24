package gqjs

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newFetchServer starts an echo server for fetch integration tests.
// Everything listens on 127.0.0.1, so tests need AllowPrivate as well as
// AllowNet — which is exactly the policy being exercised.
func newFetchServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("X-Test", "gqjs")
		fmt.Fprint(w, `{"hello":"world","n":42}`)
	})
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"method":  r.Method,
			"xTest":   r.Header.Get("X-Test"),
			"accept":  r.Header.Get("Accept"),
			"bodyB64": base64.StdEncoding.EncodeToString(b),
		})
	})
	mux.HandleFunc("/utf8", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "héllo 世界 🚀 café")
	})
	// Deliberately invalid UTF-8: one stray byte + one truncated sequence.
	mux.HandleFunc("/bad", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte{0x48, 0x69, 0xff, 0xe2, 0x82}) // "Hi" ff e2 82
	})
	mux.HandleFunc("/bytes", func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i < 256; i++ {
			_, _ = w.Write([]byte{byte(i)})
		}
	})
	mux.HandleFunc("/big", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 200)))
	})
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/final", http.StatusFound)
	})
	mux.HandleFunc("/final", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "reached-final")
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(1500 * time.Millisecond)
		fmt.Fprint(w, "ok")
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// fetchResult runs a script and returns its JSON object result.
func fetchResult(t *testing.T, src string, env Env) map[string]any {
	t.Helper()
	res, err := testRun(t, src, env)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	got, ok := res.Value.(map[string]any)
	if !ok {
		t.Fatalf("result type = %T (%s)", res.Value, res.JSON)
	}
	return got
}

// catchBlock wraps a fetch call and reports the rejection (or a marker for a
// surprising fulfillment) as a JSON object.
const catchBlock = `
		let out = { threw: false };
		try { %s } catch (e) {
			out = { threw: true, type: e.constructor.name, msg: e.message };
		}
		out;
`

func TestFetchExistsButDisabledByDefault(t *testing.T) {
	res, err := testRun(t, `typeof fetch`, Env{})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Value.(string) != "function" {
		t.Fatalf("typeof fetch = %v, want function", res.Value)
	}

	got := fetchResult(t, fmt.Sprintf(catchBlock, `await fetch("https://example.com/");`), Env{})
	if got["threw"] != true {
		t.Fatal("fetch fulfilled without AllowNet")
	}
	if got["type"] != "Error" {
		t.Errorf("error type = %v, want Error (policy failures are not TypeErrors)", got["type"])
	}
	msg := got["msg"].(string)
	if !strings.Contains(msg, "--allow-net") {
		t.Errorf("msg = %q, want the --allow-net hint", msg)
	}
}

func TestFetchURLValidation(t *testing.T) {
	got := fetchResult(t, `
		let bad = {};
		{
			let out = { threw: false };
			try { await fetch("nope"); } catch (e) { out = { threw: true, type: e.constructor.name, msg: e.message }; }
			bad.parse = out;
		}
		{
			let out = { threw: false };
			try { await fetch("ftp://example.com/x"); } catch (e) { out = { threw: true, type: e.constructor.name, msg: e.message }; }
			bad.scheme = out;
		}
		bad;
	`, Env{AllowNet: true})

	parse := got["parse"].(map[string]any)
	if parse["type"] != "TypeError" {
		t.Errorf("parse type = %v, want TypeError", parse["type"])
	}
	if !strings.Contains(parse["msg"].(string), "Failed to parse URL") {
		t.Errorf("parse msg = %v", parse["msg"])
	}
	scheme := got["scheme"].(map[string]any)
	if scheme["type"] != "TypeError" || !strings.Contains(scheme["msg"].(string), "unsupported scheme") {
		t.Errorf("scheme = %v", scheme)
	}
}

func TestFetchGetBodyRejected(t *testing.T) {
	// The facade rejects before the host is called, so no AllowNet needed.
	got := fetchResult(t, fmt.Sprintf(catchBlock,
		`await fetch("https://example.com/", { method: "GET", body: "x" });`),
		Env{})
	if got["threw"] != true || got["type"] != "TypeError" {
		t.Fatalf("result = %v, want TypeError", got)
	}
	if !strings.Contains(got["msg"].(string), "cannot have body") {
		t.Errorf("msg = %v", got["msg"])
	}
}

func TestIPAllowed(t *testing.T) {
	strict := Env{}
	priv := Env{AllowPrivate: true}
	cases := []struct {
		ip   string
		env  Env
		want bool
	}{
		{"127.0.0.1", strict, false},
		{"127.0.0.1", priv, true},
		{"::1", priv, true},
		{"10.1.2.3", strict, false},
		{"10.1.2.3", priv, true},
		{"192.168.1.1", priv, true},
		{"172.16.0.1", priv, true},
		{"fd00::1", priv, true},
		// Cloud metadata / link-local stays blocked even with AllowPrivate.
		{"169.254.169.254", priv, false},
		{"fe80::1", priv, false},
		// Unspecified and broadcast are never global unicast.
		{"0.0.0.0", priv, false},
		{"255.255.255.255", priv, false},
		{"::", priv, false},
		// Public addresses pass by default.
		{"8.8.8.8", strict, true},
		{"2606:4700:4700::1111", strict, true},
	}
	for _, tc := range cases {
		ip := net.ParseIP(tc.ip)
		if ip == nil {
			t.Fatalf("bad test IP %q", tc.ip)
		}
		if got := tc.env.ipAllowed(ip); got != tc.want {
			t.Errorf("ipAllowed(%s, AllowPrivate=%v) = %v, want %v",
				tc.ip, tc.env.AllowPrivate, got, tc.want)
		}
	}
}

func TestFetchLoopbackDeniedWithoutAllowPrivate(t *testing.T) {
	srv := newFetchServer(t)
	got := fetchResult(t, fmt.Sprintf(catchBlock, `await fetch(input.url + "/json");`),
		Env{AllowNet: true, Input: map[string]any{"url": srv.URL}})
	if got["threw"] != true {
		t.Fatal("loopback fetch fulfilled without AllowPrivate")
	}
	if !strings.Contains(got["msg"].(string), "blocked address") {
		t.Errorf("msg = %v, want the blocked-address message", got["msg"])
	}
}

func TestFetchRoundTrip(t *testing.T) {
	srv := newFetchServer(t)
	got := fetchResult(t, `
		const res = await fetch(input.url + "/json");
		({
			status: res.status,
			ok: res.ok,
			statusText: res.statusText,
			ctype: res.headers.get("content-type"),
			upper: res.headers.get("CONTENT-TYPE"),
			xtest: res.headers.get("x-test"),
			missing: res.headers.get("nope"),
			url: res.url,
			redirected: res.redirected,
			type: res.type,
			bodyUsed: res.bodyUsed,
			text: await res.text(),
			bodyUsedAfter: res.bodyUsed,
		});
	`, Env{AllowNet: true, AllowPrivate: true, Input: map[string]any{"url": srv.URL}})

	if got["status"].(float64) != 200 || got["ok"] != true {
		t.Errorf("status/ok = %v/%v", got["status"], got["ok"])
	}
	if got["statusText"].(string) != "OK" {
		t.Errorf("statusText = %v", got["statusText"])
	}
	if !strings.Contains(got["ctype"].(string), "application/json") {
		t.Errorf("content-type = %v", got["ctype"])
	}
	if got["upper"] != got["ctype"] {
		t.Errorf("case-insensitive get: upper=%v ctype=%v", got["upper"], got["ctype"])
	}
	if got["xtest"].(string) != "gqjs" {
		t.Errorf("x-test = %v", got["xtest"])
	}
	if got["missing"] != nil {
		t.Errorf("missing header = %v, want null", got["missing"])
	}
	if got["url"].(string) != srv.URL+"/json" {
		t.Errorf("url = %v", got["url"])
	}
	if got["redirected"] != false || got["type"].(string) != "basic" {
		t.Errorf("redirected/type = %v/%v", got["redirected"], got["type"])
	}
	if got["text"].(string) != `{"hello":"world","n":42}` {
		t.Errorf("text = %v", got["text"])
	}
	if got["bodyUsed"] != false || got["bodyUsedAfter"] != true {
		t.Errorf("bodyUsed = %v then %v", got["bodyUsed"], got["bodyUsedAfter"])
	}
}

func TestFetchBodiesAndHeaders(t *testing.T) {
	srv := newFetchServer(t)
	textBody := "name=suwu 世界"
	byteBody := []byte{0, 1, 127, 128, 254, 255}

	got := fetchResult(t, `
		const r1 = await fetch(input.url + "/echo", {
			method: "POST",
			headers: { "X-Test": "hello" },
			body: input.textBody,
		});
		const j1 = await r1.json();
		const r2 = await fetch(input.url + "/echo", {
			method: "POST",
			body: new Uint8Array([0, 1, 127, 128, 254, 255]),
		});
		const j2 = await r2.json();
		({ m1: j1.method, h1: j1.xTest, accept: j1.accept, b1: j1.bodyB64,
		   m2: j2.method, b2: j2.bodyB64 });
	`, Env{
		AllowNet: true, AllowPrivate: true,
		Input: map[string]any{"url": srv.URL, "textBody": textBody},
	})

	if got["m1"] != "POST" || got["m2"] != "POST" {
		t.Errorf("methods = %v/%v", got["m1"], got["m2"])
	}
	if got["h1"].(string) != "hello" {
		t.Errorf("x-test = %v", got["h1"])
	}
	if got["accept"].(string) != "*/*" {
		t.Errorf("accept = %v, want browser-parity */*", got["accept"])
	}
	wantText := base64.StdEncoding.EncodeToString([]byte(textBody))
	if got["b1"].(string) != wantText {
		t.Errorf("string body = %v, want %v", got["b1"], wantText)
	}
	wantBytes := base64.StdEncoding.EncodeToString(byteBody)
	if got["b2"].(string) != wantBytes {
		t.Errorf("byte body = %v, want %v (b64Encode)", got["b2"], wantBytes)
	}
}

func TestFetchUTF8Text(t *testing.T) {
	srv := newFetchServer(t)
	got := fetchResult(t, `
		const good = await fetch(input.url + "/utf8");
		const bad = await fetch(input.url + "/bad");
		({ good: await good.text(), bad: await bad.text() });
	`, Env{AllowNet: true, AllowPrivate: true, Input: map[string]any{"url": srv.URL}})

	if got["good"].(string) != "héllo 世界 🚀 café" {
		t.Errorf("utf8 text = %q", got["good"])
	}
	// Invalid bytes decode to U+FFFD, matching TextDecoder's non-fatal mode:
	// 0xff is an invalid lead, e2 82 is a truncated sequence at end of body.
	if want := "Hi\uFFFD\uFFFD"; got["bad"].(string) != want {
		t.Errorf("invalid utf8 = %q, want %q", got["bad"], want)
	}
}

func TestFetchArrayBuffer(t *testing.T) {
	srv := newFetchServer(t)
	got := fetchResult(t, `
		const res = await fetch(input.url + "/bytes");
		const bytes = new Uint8Array(await res.arrayBuffer());
		({ len: bytes.length, first: bytes[0], last: bytes[bytes.length - 1], arr: Array.from(bytes) });
	`, Env{AllowNet: true, AllowPrivate: true, Input: map[string]any{"url": srv.URL}})

	if got["len"].(float64) != 256 {
		t.Fatalf("len = %v", got["len"])
	}
	if got["first"].(float64) != 0 || got["last"].(float64) != 255 {
		t.Errorf("first/last = %v/%v", got["first"], got["last"])
	}
	arr := got["arr"].([]any)
	for i, v := range arr {
		if v.(float64) != float64(i) {
			t.Fatalf("arr[%d] = %v", i, v)
		}
	}
}

func TestFetchBodyReadableOnce(t *testing.T) {
	srv := newFetchServer(t)
	got := fetchResult(t, `
		const res = await fetch(input.url + "/utf8");
		const first = await res.text();
		let out = { first };
		try { await res.json(); } catch (e) {
			out = { first, type: e.constructor.name, msg: e.message };
		}
		out;
	`, Env{AllowNet: true, AllowPrivate: true, Input: map[string]any{"url": srv.URL}})

	if got["first"].(string) == "" {
		t.Fatal("first read failed")
	}
	if got["type"] != "TypeError" {
		t.Errorf("second read type = %v, want TypeError", got["type"])
	}
}

func TestFetchRedirectModes(t *testing.T) {
	srv := newFetchServer(t)
	got := fetchResult(t, `
		const a = await fetch(input.url + "/redirect");
		const followed = await a.text();

		let err = { threw: false };
		try { await fetch(input.url + "/redirect", { redirect: "error" }); }
		catch (e) { err = { threw: true, type: e.constructor.name, msg: e.message }; }

		const m = await fetch(input.url + "/redirect", { redirect: "manual" });
		const manualBody = await m.text();

		({ status: a.status, redirected: a.redirected, url: a.url, followed, err,
		   mStatus: m.status, mRedirected: m.redirected, mLoc: m.headers.get("location"),
		   manualBody });
	`, Env{AllowNet: true, AllowPrivate: true, Input: map[string]any{"url": srv.URL}})

	if got["status"].(float64) != 200 || got["redirected"] != true {
		t.Errorf("follow: status/redirected = %v/%v", got["status"], got["redirected"])
	}
	if !strings.HasSuffix(got["url"].(string), "/final") {
		t.Errorf("follow url = %v", got["url"])
	}
	if got["followed"].(string) != "reached-final" {
		t.Errorf("followed body = %v", got["followed"])
	}
	err := got["err"].(map[string]any)
	if err["threw"] != true || err["type"] != "TypeError" || !strings.Contains(err["msg"].(string), "redirect") {
		t.Errorf("redirect:error = %v", err)
	}
	if got["mStatus"].(float64) != 302 || got["mRedirected"] != false {
		t.Errorf("manual: status/redirected = %v/%v", got["mStatus"], got["mRedirected"])
	}
	if got["mLoc"].(string) != "/final" {
		t.Errorf("manual location = %v", got["mLoc"])
	}
	// The unfollowed 302 comes back untouched, including its HTML body.
	if !strings.Contains(got["manualBody"].(string), "/final") {
		t.Errorf("manual body = %q, want the redirect body", got["manualBody"])
	}
}

func TestFetchBodyLimit(t *testing.T) {
	srv := newFetchServer(t)
	got := fetchResult(t, fmt.Sprintf(catchBlock, `await fetch(input.url + "/big");`),
		Env{
			AllowNet: true, AllowPrivate: true, MaxFetchBody: 32,
			Input: map[string]any{"url": srv.URL},
		})
	if got["threw"] != true || got["type"] != "Error" {
		t.Fatalf("result = %v, want plain Error", got)
	}
	if !strings.Contains(got["msg"].(string), "exceeds") {
		t.Errorf("msg = %v", got["msg"])
	}
}

// TestFetchBoundedByDeadline proves a slow server cannot outlive the request
// timeout: the runner has no persistent connections.
func TestFetchBoundedByDeadline(t *testing.T) {
	srv := newFetchServer(t)
	start := time.Now()
	res, err := testRun(t, `
		let out;
		try {
			const res = await fetch(input.url + "/slow");
			out = { done: true, status: res.status };
		} catch (e) {
			out = { done: false, msg: e.message };
		}
		out;
	`, Env{
		AllowNet: true, AllowPrivate: true,
		Input:   map[string]any{"url": srv.URL},
		Timeout: 400 * time.Millisecond,
	})
	elapsed := time.Since(start)
	if elapsed > 10*time.Second {
		t.Fatalf("fetch outlived the deadline: %s", elapsed)
	}
	if err == nil {
		got := res.Value.(map[string]any)
		if done, _ := got["done"].(bool); done {
			t.Fatalf("fetch completed despite the deadline: %v", got)
		}
	}
}