package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"

	"suwu/pkg/version"
)

// restHeader is one request header row. It is an ordered list (not a map) so
// duplicate header names survive round-tripping.
type restHeader struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

// restFormEntry is one form-data / urlencoded field. File values arrive as
// base64 so the whole payload stays a single JSON document.
type restFormEntry struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	Type        string `json:"type"` // "text" | "file"
	Filename    string `json:"filename,omitempty"`
	ContentB64  string `json:"contentB64,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	Enabled     bool   `json:"enabled"`
}

// restRequest is the inbound payload for POST /api/rest/request.
type restRequest struct {
	Method   string          `json:"method"`
	URL      string          `json:"url"`
	Headers  []restHeader    `json:"headers"`
	BodyType string          `json:"bodyType"` // none|json|raw|form-data|urlencoded
	Body     string          `json:"body"`
	FormData []restFormEntry `json:"formData"`

	UserAgentMode    string `json:"userAgentMode"` // default|browser|custom
	BrowserUserAgent string `json:"browserUserAgent"`
	CustomUserAgent  string `json:"customUserAgent"`

	TimeoutMs        int   `json:"timeoutMs"`
	FollowRedirects  *bool `json:"followRedirects"`
	InsecureTLS      bool  `json:"insecureTLS"`
	MaxResponseBytes int64 `json:"maxResponseBytes"`
}

// restResponse is the outbound envelope. It is always written with HTTP 200;
// transport failures set Status=0 plus Error/ErrorKind so the client has one
// response shape to render.
type restResponse struct {
	Status      int                 `json:"status"`
	StatusText  string              `json:"statusText"`
	Headers     map[string][]string `json:"headers"`
	BodyB64     string              `json:"bodyB64"`
	BodySize    int64               `json:"bodySize"`
	Truncated   bool                `json:"truncated"`
	DurationMs  int64               `json:"durationMs"`
	FinalURL    string              `json:"finalUrl"`
	Redirects   []string            `json:"redirects"`
	InsecureTLS bool                `json:"insecureTLS"`
	Error       string              `json:"error,omitempty"`
	ErrorKind   string              `json:"errorKind,omitempty"`
}

const (
	restMaxPayloadBytes    = 32 << 20 // inbound JSON payload cap
	restDefaultTimeoutMs   = 30_000
	restMinTimeoutMs       = 1_000
	restMaxTimeoutMs       = 300_000
	restDefaultMaxResp     = 10 << 20 // 10 MiB outbound response cap
	restMaxResponseBytesCe = 64 << 20
	restConcurrency        = 16
	restMaxRedirects       = 10
)

// restSem bounds concurrent outbound requests so a single client cannot exhaust
// the server's sockets.
var restSem = make(chan struct{}, restConcurrency)

// handleRESTHelper routes /api/rest/* requests.
func (s *Server) handleRESTHelper(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	switch r.URL.Path {
	case "/api/rest/request":
		s.handleRESTRequest(w, r)
	default:
		writePlain(w, http.StatusNotFound, "Not Found")
	}
}

func (s *Server) handleRESTRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, restMaxPayloadBytes)
	var req restRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, restResponse{Error: "invalid request payload: " + err.Error(), ErrorKind: "invalid-payload"})
		return
	}

	if req.Method == "" {
		writeJSON(w, http.StatusBadRequest, restResponse{Error: "method is required", ErrorKind: "invalid-payload"})
		return
	}
	if req.URL == "" {
		writeJSON(w, http.StatusBadRequest, restResponse{Error: "url is required", ErrorKind: "invalid-payload"})
		return
	}

	// Acquire a concurrency slot without queueing forever.
	select {
	case restSem <- struct{}{}:
		defer func() { <-restSem }()
	case <-r.Context().Done():
		return
	case <-time.After(5 * time.Second):
		writeJSON(w, http.StatusTooManyRequests, restResponse{Error: "too many concurrent requests", ErrorKind: "busy"})
		return
	}

	resp := s.executeRESTRequest(r.Context(), &req)
	logRESTRequest(req.Method, req.URL, resp.Status, time.Duration(resp.DurationMs)*time.Millisecond)
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) executeRESTRequest(ctx context.Context, req *restRequest) restResponse {
	start := time.Now()
	out := restResponse{Headers: map[string][]string{}, InsecureTLS: req.InsecureTLS}

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	targetURL := strings.TrimSpace(req.URL)

	body, contentType, err := buildRESTBody(req)
	if err != nil {
		out.DurationMs = time.Since(start).Milliseconds()
		out.Error = err.Error()
		out.ErrorKind = "invalid-payload"
		return out
	}

	timeout := clampRESTTimeout(req.TimeoutMs)
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(reqCtx, method, targetURL, body)
	if err != nil {
		out.DurationMs = time.Since(start).Milliseconds()
		out.Error = err.Error()
		out.ErrorKind = "invalid-url"
		return out
	}

	applyRESTHeaders(httpReq, req, contentType)

	follow := true
	if req.FollowRedirects != nil {
		follow = *req.FollowRedirects
	}

	var redirects []string = []string{}
	client := newRESTClient(req.InsecureTLS)
	client.CheckRedirect = func(r2 *http.Request, via []*http.Request) error {
		redirects = append(redirects, r2.URL.String())
		if !follow {
			return http.ErrUseLastResponse
		}
		if len(via) >= restMaxRedirects {
			return fmt.Errorf("stopped after %d redirects", restMaxRedirects)
		}
		return nil
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		out.DurationMs = time.Since(start).Milliseconds()
		out.Redirects = redirects
		out.Error = err.Error()
		out.ErrorKind = classifyRESTError(err)
		return out
	}
	defer resp.Body.Close()

	maxBytes := req.MaxResponseBytes
	if maxBytes <= 0 || maxBytes > restMaxResponseBytesCe {
		maxBytes = restDefaultMaxResp
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		out.DurationMs = time.Since(start).Milliseconds()
		out.Redirects = redirects
		out.Error = err.Error()
		out.ErrorKind = classifyRESTError(err)
		return out
	}
	truncated := int64(len(raw)) > maxBytes
	if truncated {
		raw = raw[:maxBytes]
	}

	out.Status = resp.StatusCode
	out.StatusText = statusTextFor(resp)
	out.Headers = resp.Header
	out.BodyB64 = base64.StdEncoding.EncodeToString(raw)
	out.BodySize = int64(len(raw))
	out.Truncated = truncated
	out.DurationMs = time.Since(start).Milliseconds()
	out.FinalURL = targetURL
	if resp.Request != nil && resp.Request.URL != nil {
		out.FinalURL = resp.Request.URL.String()
	}
	out.Redirects = redirects
	return out
}

// buildRESTBody constructs the outbound body and returns the Content-Type it
// requires ("" to leave headers untouched).
func buildRESTBody(req *restRequest) (io.Reader, string, error) {
	switch req.BodyType {
	case "", "none":
		return nil, "", nil
	case "json", "raw":
		if req.Body == "" {
			return nil, "", nil
		}
		return strings.NewReader(req.Body), "", nil
	case "urlencoded":
		vals := url.Values{}
		for _, e := range req.FormData {
			if !e.Enabled || e.Key == "" {
				continue
			}
			vals.Add(e.Key, e.Value)
		}
		return strings.NewReader(vals.Encode()), "application/x-www-form-urlencoded", nil
	case "form-data":
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		for _, e := range req.FormData {
			if !e.Enabled || e.Key == "" {
				continue
			}
			if e.Type == "file" {
				data, err := base64.StdEncoding.DecodeString(e.ContentB64)
				if err != nil {
					return nil, "", fmt.Errorf("invalid base64 file content for %q: %w", e.Key, err)
				}
				part, err := mw.CreateFormFile(e.Key, e.Filename)
				if err != nil {
					return nil, "", err
				}
				if _, err := part.Write(data); err != nil {
					return nil, "", err
				}
				continue
			}
			if err := mw.WriteField(e.Key, e.Value); err != nil {
				return nil, "", err
			}
		}
		if err := mw.Close(); err != nil {
			return nil, "", err
		}
		return &buf, mw.FormDataContentType(), nil
	default:
		return nil, "", fmt.Errorf("unsupported bodyType %q", req.BodyType)
	}
}

// applyRESTHeaders copies enabled headers, resolves the User-Agent, applies the
// generated Content-Type, and strips hop-by-hop headers.
func applyRESTHeaders(httpReq *http.Request, req *restRequest, contentType string) {
	explicitUA := false
	for _, h := range req.Headers {
		if !h.Enabled || strings.TrimSpace(h.Key) == "" {
			continue
		}
		key := http.CanonicalHeaderKey(strings.TrimSpace(h.Key))
		if isHopByHopHeader(key) || key == "Content-Length" {
			continue
		}
		if key == "Host" {
			httpReq.Host = h.Value
			continue
		}
		if key == "User-Agent" {
			explicitUA = true
		}
		httpReq.Header.Add(key, h.Value)
	}

	if !explicitUA {
		if ua := resolveRESTUserAgent(req); ua != "" {
			httpReq.Header.Set("User-Agent", ua)
		}
	}
	if contentType != "" {
		httpReq.Header.Set("Content-Type", contentType)
	}
}

// resolveRESTUserAgent applies the precedence: explicit header > mode.
func resolveRESTUserAgent(req *restRequest) string {
	switch req.UserAgentMode {
	case "browser":
		return req.BrowserUserAgent
	case "custom":
		return req.CustomUserAgent
	case "default", "":
		return "SuwuREST/" + version.Version
	default:
		return "SuwuREST/" + version.Version
	}
}

// newRESTClient builds a per-request client. TLS verification is only disabled
// when explicitly requested; it is never global.
func newRESTClient(insecureTLS bool) *http.Client {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, Control: restDialControl()}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	if insecureTLS {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // explicit, per-request opt-in for local dev
	}
	return &http.Client{Transport: transport}
}

// restDialControl rejects link-local addresses (cloud metadata endpoints) unless
// the operator opts in with REST_HELPER_ALLOW_LINK_LOCAL=true.
func restDialControl() func(network, address string, c syscall.RawConn) error {
	if strings.EqualFold(os.Getenv("REST_HELPER_ALLOW_LINK_LOCAL"), "true") {
		return nil
	}
	return func(network, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil
		}
		ip := net.ParseIP(host)
		if ip == nil {
			return nil
		}
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return fmt.Errorf("link-local address %s is blocked (set REST_HELPER_ALLOW_LINK_LOCAL=true to allow)", ip)
		}
		return nil
	}
}

// statusTextFor returns the reason phrase only ("Bad Request"), not Go's full
// status line ("400 Bad Request"), so the client does not render "400 400 Bad Request".
func statusTextFor(resp *http.Response) string {
	if text := http.StatusText(resp.StatusCode); text != "" {
		return text
	}
	return resp.Status
}

func clampRESTTimeout(ms int) int {
	if ms <= 0 {
		return restDefaultTimeoutMs
	}
	if ms < restMinTimeoutMs {
		return restMinTimeoutMs
	}
	if ms > restMaxTimeoutMs {
		return restMaxTimeoutMs
	}
	return ms
}

// classifyRESTError maps a transport error to a stable machine-readable kind.
func classifyRESTError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns"
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		if errors.Is(urlErr.Err, context.DeadlineExceeded) {
			return "timeout"
		}
	}
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return "tls"
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "connection refused"):
		return "refused"
	case strings.Contains(msg, "no such host"):
		return "dns"
	case strings.Contains(msg, "certificate"), strings.Contains(msg, "x509"), strings.Contains(msg, "tls"):
		return "tls"
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "deadline exceeded"):
		return "timeout"
	default:
		return "other"
	}
}

// hopByHopHeaders are connection-scoped and must not be forwarded.
var hopByHopHeaders = map[string]bool{
	"Connection":          true,
	"Proxy-Connection":    true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
}

func isHopByHopHeader(key string) bool {
	return hopByHopHeaders[http.CanonicalHeaderKey(key)]
}

// logRESTRequest logs a redacted summary (never credentials or bodies).
func logRESTRequest(method, targetURL string, status int, dur time.Duration) {
	host := targetURL
	if u, err := url.Parse(targetURL); err == nil && u.Host != "" {
		host = u.Host
	}
	slog.Debug("rest request", "method", method, "host", host, "status", status, "duration", dur.String())
}
