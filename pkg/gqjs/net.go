package gqjs

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/fastschema/qjs"
)

// errRedirectError is the CheckRedirect sentinel for redirect: "error".
var errRedirectError = errors.New(`fetch: the request was redirected and redirect is "error"`)

// fetchSpec is the JSON the prelude's fetch facade sends to the host.
type fetchSpec struct {
	URL      string      `json:"url"`
	Method   string      `json:"method"`
	Headers  [][2]string `json:"headers"`
	Redirect string      `json:"redirect"`
	// Text carries a string request body; B64 carries raw bytes. Presence is
	// tracked by nil-ness, so an empty string body is still a body.
	Text *string `json:"text,omitempty"`
	B64  string  `json:"b64,omitempty"`
}

// fetchWire is the JSON reply the host returns to the prelude. Kind tells
// the facade which error class to reject with: "url" and "network" become
// TypeErrors (as in browsers), "blocked" and "limit" are plain Errors.
type fetchWire struct {
	Error      string      `json:"error,omitempty"`
	Kind       string      `json:"kind,omitempty"`
	Status     int         `json:"status,omitempty"`
	StatusText string      `json:"statusText,omitempty"`
	URL        string      `json:"url,omitempty"`
	Redirected bool        `json:"redirected,omitempty"`
	Headers    [][2]string `json:"headers,omitempty"`
	B64        string      `json:"b64,omitempty"`
}

// bindFetch installs __gqjs.fetch, the host primitive behind global fetch().
//
// The whole request runs synchronously inside the call and is bounded by the
// run context, so no connection and no goroutine can outlive the script: this
// runner allows no persistent connections. Keep-alives are disabled on the
// transport for the same reason.
func bindFetch(c *qjs.Context, q *qjs.Value, ctx context.Context, env Env) {
	tr := &http.Transport{
		DisableKeepAlives: true,
		DialContext:       fetchDialer(env),
	}
	q.SetPropertyStr("fetch", c.Function(func(this *qjs.This) (*qjs.Value, error) {
		spec := ""
		if args := this.Args(); len(args) > 0 && !args[0].IsUndefined() && !args[0].IsNull() {
			spec = args[0].String()
		}
		data, err := json.Marshal(env.doFetch(ctx, tr, spec))
		if err != nil {
			data = []byte(`{"error":"fetch: failed to encode response","kind":"network"}`)
		}
		return this.Context().NewString(string(data)), nil
	}))
}

// doFetch performs one HTTP request for the prelude and always returns a
// marshalled wire result — failures are reported in-band so the facade can
// reject with the spec's error classes.
func (e Env) doFetch(ctx context.Context, tr *http.Transport, spec string) fetchWire {
	if !e.AllowNet {
		return fetchWire{Kind: "blocked", Error: "fetch: network access is disabled (re-run with --allow-net)"}
	}

	var req fetchSpec
	if err := json.Unmarshal([]byte(spec), &req); err != nil {
		return fetchWire{Kind: "url", Error: "fetch: invalid request: " + err.Error()}
	}
	u, err := url.Parse(req.URL)
	if err != nil || u.Host == "" {
		return fetchWire{Kind: "url", Error: "Failed to parse URL: " + req.URL}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fetchWire{Kind: "url", Error: fmt.Sprintf("fetch: unsupported scheme %q (only http and https)", u.Scheme)}
	}

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if req.Text != nil || req.B64 != "" {
		if method == http.MethodGet || method == http.MethodHead {
			return fetchWire{Kind: "url", Error: "fetch: a GET/HEAD request cannot have a body"}
		}
		if req.Text != nil {
			body = strings.NewReader(*req.Text)
		} else {
			raw, err := base64.StdEncoding.DecodeString(req.B64)
			if err != nil {
				return fetchWire{Kind: "url", Error: "fetch: invalid base64 request body"}
			}
			body = bytes.NewReader(raw)
		}
	}

	httpReq, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return fetchWire{Kind: "url", Error: "fetch: " + err.Error()}
	}
	for _, kv := range req.Headers {
		if len(kv) == 2 && kv[0] != "" {
			httpReq.Header.Add(kv[0], kv[1])
		}
	}
	// Browser parity: fetch always sends Accept unless the caller set one.
	if httpReq.Header.Get("Accept") == "" {
		httpReq.Header.Set("Accept", "*/*")
	}

	mode := req.Redirect
	if mode == "" {
		mode = "follow"
	}
	redirects := 0
	client := &http.Client{Transport: tr}
	switch mode {
	case "manual":
		// Hand the redirect response back unfollowed.
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	case "error":
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return errRedirectError }
	default:
		client.CheckRedirect = func(_ *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			redirects++
			return nil
		}
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		if errors.Is(err, errRedirectError) {
			return fetchWire{Kind: "redirect", Error: errRedirectError.Error()}
		}
		return fetchWire{Kind: "network", Error: "Failed to fetch: " + err.Error()}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, int64(e.MaxFetchBody)+1))
	if err != nil {
		return fetchWire{Kind: "network", Error: "Failed to fetch: " + err.Error()}
	}
	if len(data) > e.MaxFetchBody {
		return fetchWire{
			Kind:  "limit",
			Error: fmt.Sprintf("fetch: response body exceeds %d bytes (MaxFetchBody)", e.MaxFetchBody),
		}
	}

	statusText := resp.Status
	if i := strings.IndexByte(statusText, ' '); i >= 0 {
		statusText = statusText[i+1:]
	}
	names := make([]string, 0, len(resp.Header))
	for name := range resp.Header {
		names = append(names, name)
	}
	sort.Strings(names)
	headers := make([][2]string, 0, len(resp.Header))
	for _, name := range names {
		for _, v := range resp.Header[name] {
			headers = append(headers, [2]string{name, v})
		}
	}

	finalURL := resp.Request.URL
	if finalURL == nil {
		finalURL = u
	}
	return fetchWire{
		Status:     resp.StatusCode,
		StatusText: statusText,
		URL:        finalURL.String(),
		Redirected: redirects > 0,
		Headers:    headers,
		B64:        base64.StdEncoding.EncodeToString(data),
	}
}

// ipAllowed reports whether fetch may dial ip.
//
// Loopback and private addresses are dev targets behind an explicit opt-in
// (Env.AllowPrivate). Everything that is not a global unicast address —
// link-local (which holds cloud metadata endpoints like 169.254.169.254),
// multicast, broadcast, unspecified — is denied unconditionally.
func (e Env) ipAllowed(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() {
		return e.AllowPrivate
	}
	return ip.IsGlobalUnicast()
}

// fetchDialer returns a DialContext that resolves the target host and
// applies ipAllowed to every address, dialing only allowed ones. Filtering
// at dial time (instead of pre-checking the URL) covers redirects and DNS
// rebinding: the connection can only ever be made to an address that passed
// the policy.
func fetchDialer(env Env) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := resolveFetchHost(ctx, host)
		if err != nil {
			return nil, err
		}
		allowed := make([]net.IP, 0, len(ips))
		for _, ip := range ips {
			if env.ipAllowed(ip) {
				allowed = append(allowed, ip)
			}
		}
		if len(allowed) == 0 {
			return nil, fmt.Errorf(
				"fetch: blocked address %q (loopback/private targets need --allow-private; link-local is never allowed)",
				host,
			)
		}
		var firstErr error
		for _, ip := range allowed {
			var d net.Dialer
			conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
			if firstErr == nil {
				firstErr = err
			}
		}
		return nil, firstErr
	}
}

// resolveFetchHost resolves host to IPs, trusting IP literals as-is.
func resolveFetchHost(ctx context.Context, host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("fetch: resolve %q: %w", host, err)
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("fetch: no addresses for %q", host)
	}
	return ips, nil
}
