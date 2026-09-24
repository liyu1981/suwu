package server

// Extension rendering: GET /gqjs/ext/<id> runs a gqjs-backed extension in a
// separate `suwu gq` child process and returns the HTML page it produces.
// Extension APIs (GET/POST/... /gqjs/api/<id>/<path>) are handled in
// extension_api.go.
//
// Isolation model: one fresh child process per render, bounded by a deadline
// and a concurrency cap, so a crashed or runaway extension cannot take the
// Suwu server down. See docs/EXTENSION_TILE_PLAN.md.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"suwu/pkg/auth"
	"suwu/pkg/extension"
)

// extensionRoutePrefix is the path prefix for rendering an extension page.
const extensionRoutePrefix = "/gqjs/ext/"

// extensionRelayMarker identifies the injected relay script so injection stays
// idempotent even if an extension ships a copy of its own.
const extensionRelayMarker = "data-suwu-ext-relay"

// extensionRelayScript is injected into HTML extension pages immediately
// before </body>.
//
// The ext page runs in a sandboxed, opaque-origin iframe, so focus and key
// events inside it never reach the tile page (ancestor frames do not re-fire
// `focus`, and events do not cross document boundaries). The tile page also
// cannot reach into this document (contentDocument is null under sandbox), so
// the only viable channel is postMessage — which means the relay must be part
// of the bytes we serve.
//
// It relays two things to the tile page:
//   - focus: announced once per focus episode (window focus / first focusin,
//     reset only on window blur, so moving between elements does not spam).
//   - keydown: the raw key + modifiers, forwarded as-is. WM shortcuts are
//     Alt-based and space switching is Ctrl-based; both are swallowed here so
//     browser defaults (Alt+Left history, Ctrl+Tab tab cycling) cannot fire
//     inside a sandboxed extension.
const extensionRelayScript = `<script ` + extensionRelayMarker + `>
(function () {
  var post = function (m) { try { window.parent.postMessage(m, '*'); } catch (e) {} };
  var active = false;
  var onFocus = function () {
    if (active) return;
    active = true;
    post({ type: 'ext-focus' });
  };
  var onBlur = function () { active = false; };
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('focusin', onFocus);
  document.addEventListener('keydown', function (e) {
    var wm = e.altKey && !e.ctrlKey && !e.metaKey;
    var space = e.ctrlKey && !e.altKey && !e.metaKey &&
      (e.key === 'Tab' || (!e.shiftKey && e.key >= '0' && e.key <= '9'));
    if (wm || space) { try { e.preventDefault(); } catch (err) {} }
    post({
      type: 'ext-key', key: e.key,
      altKey: !!e.altKey, ctrlKey: !!e.ctrlKey,
      shiftKey: !!e.shiftKey, metaKey: !!e.metaKey
    });
  });
  if (document.hasFocus()) onFocus();
})();
</script>`

// injectExtensionRelay inserts extensionRelayScript just before </body>
// (case-insensitive), else </html>, else appended. HTML5 parsers place a
// trailing script inside the body, so the append fallback is safe.
func injectExtensionRelay(body string) string {
	if body == "" || strings.Contains(body, extensionRelayMarker) {
		return body
	}
	lower := strings.ToLower(body)
	if idx := strings.LastIndex(lower, "</body>"); idx >= 0 {
		return body[:idx] + extensionRelayScript + body[idx:]
	}
	if idx := strings.LastIndex(lower, "</html>"); idx >= 0 {
		return body[:idx] + extensionRelayScript + body[idx:]
	}
	return body + extensionRelayScript
}

// isHTMLContentType reports whether a response body is an HTML document.
func isHTMLContentType(contentType string) bool {
	return strings.Contains(strings.ToLower(contentType), "text/html")
}

// extensionCSP scopes the generated document. The extension page is untrusted,
// so the default source is 'none'; inline scripts/styles are allowed because
// extension pages are self-contained, and frame-ancestors limits framing to
// the same-origin /extension tile page.
// extensionCSP is the strict CSP used for error documents: no external
// scripts, no connections. Rendered pages get extensionCSPFor instead.
const extensionCSP = "default-src 'none'; " +
	"script-src 'unsafe-inline'; " +
	"style-src 'unsafe-inline'; " +
	"img-src data: blob:; " +
	"font-src data:; " +
	"connect-src 'self'; " +
	"frame-ancestors 'self'"

// extensionCSPFor builds the CSP for a rendered extension page. Compared with
// extensionCSP it additionally allows the pinned htmx CDN in script-src, and
// names the request origin in every directive that can load extension assets
// (script/style/img/font, plus connect for the API): the page runs in a
// sandboxed iframe with an opaque origin — where 'self' alone is unreliable.
// r.Host is restricted to host-safe characters before it enters the header.
func extensionCSPFor(r *http.Request) string {
	host := strings.Map(func(c rune) rune {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '.', c == ':', c == '-', c == '[', c == ']':
			return c
		}
		return -1
	}, r.Host)
	origin := "https://" + host + " http://" + host
	return "default-src 'none'; " +
		"script-src 'unsafe-inline' https://unpkg.com " + origin + "; " +
		"style-src 'unsafe-inline' " + origin + "; " +
		"img-src data: blob: " + origin + "; " +
		"font-src data: " + origin + "; " +
		"connect-src 'self' " + origin + "; " +
		"frame-ancestors 'self'"
}

// defaultExtensionTimeout follows PHP's max_execution_time rule. Override with
// SUWU_EXTENSION_TIMEOUT (e.g. a short value in tests).
const defaultExtensionTimeout = 30 * time.Second

// defaultExtensionConcurrency caps how many extension child processes may run
// at once.
const defaultExtensionConcurrency = 4

// errExtensionTimeout reports that an extension render hit its deadline.
var errExtensionTimeout = errors.New("extension render timed out")

// extensionRunner executes one extension script (the render entry or an API
// handler) and returns its raw JSON result.
type extensionRunner interface {
	Exec(ctx context.Context, ext extension.Extension, entry string, input map[string]any) ([]byte, error)
}

// extensionResult is the parsed JSON contract returned by an extension script.
type extensionResult struct {
	Status      int    `json:"status"`
	ContentType string `json:"contentType"`
	Body        string `json:"body"`
	HTML        string `json:"html"` // shorthand for body
}

// render resolves to extensionResult.Body via html.
func (r extensionResult) page() string {
	if r.Body != "" {
		return r.Body
	}
	return r.HTML
}

// processRunner runs `suwu gq` in a separate OS process per render.
type processRunner struct {
	binary  string
	timeout time.Duration
	extDir  string
	sem     chan struct{}
}

func newProcessRunner(extDir string) *processRunner {
	timeout := defaultExtensionTimeout
	if v := strings.TrimSpace(os.Getenv("SUWU_EXTENSION_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			timeout = d
		}
	}
	binary, err := os.Executable()
	if err != nil || binary == "" {
		binary = "suwu"
	}
	return &processRunner{
		binary:  binary,
		timeout: timeout,
		extDir:  extDir,
		sem:     make(chan struct{}, defaultExtensionConcurrency),
	}
}

func (p *processRunner) Exec(ctx context.Context, ext extension.Extension, entry string, input map[string]any) ([]byte, error) {
	// Bound concurrency; respect an already-cancelled context.
	select {
	case p.sem <- struct{}{}:
		defer func() { <-p.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	inputJSON, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("marshal input: %w", err)
	}

	// Input travels via a temp file, not the command line: API bodies can
	// exceed argv limits (E2BIG), and a command line would leak payloads
	// into `ps`.
	inFile, err := os.CreateTemp("", "suwu-ext-in-*.json")
	if err != nil {
		return nil, fmt.Errorf("create input temp: %w", err)
	}
	inPath := inFile.Name()
	_, werr := inFile.Write(inputJSON)
	if cerr := inFile.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(inPath)
		return nil, fmt.Errorf("write input temp: %w", werr)
	}
	defer func() { _ = os.Remove(inPath) }()

	tmp, err := os.CreateTemp("", "suwu-ext-*.json")
	if err != nil {
		return nil, fmt.Errorf("create result temp: %w", err)
	}
	resultPath := tmp.Name()
	_ = tmp.Close()
	_ = os.Remove(resultPath) // gq writes it; we only need a unique path
	defer func() { _ = os.Remove(resultPath) }()

	// The exec deadline is the backstop; gq's own --timeout normally fires
	// first and exits with code 2, which we classify below.
	runCtx, cancel := context.WithTimeout(ctx, p.timeout+time.Second)
	defer cancel()

	cmd := exec.CommandContext(runCtx, p.binary, p.gqArgs(entry, inPath, resultPath, ext.Net)...)
	// A deliberately minimal environment: the child only needs PATH (for the
	// binary, though we pass an absolute path) and HOME.
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
	}
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		switch {
		case runCtx.Err() != nil || ctx.Err() != nil:
			return nil, errExtensionTimeout
		default:
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) && exitErr.ExitCode() == 2 {
				return nil, errExtensionTimeout
			}
			return nil, fmt.Errorf("gq failed: %w: %s", err, strings.TrimSpace(stderr.String()))
		}
	}

	data, err := os.ReadFile(resultPath)
	if err != nil {
		return nil, fmt.Errorf("read result: %w", err)
	}
	return data, nil
}

// gqArgs builds the `suwu gq` argument list for one extension exec.
//
// --allow-net is the suwu.net opt-in; --allow-private is never passed, so an
// extension with network access still cannot reach loopback, private, or
// link-local (cloud metadata) addresses.
func (p *processRunner) gqArgs(entry, inputPath, resultPath string, net bool) []string {
	args := []string{
		"gq",
		"--timeout", p.timeout.String(),
		"--result-file", resultPath,
		"--input-file", inputPath,
	}
	if net {
		args = append(args, "--allow-net")
	}
	return append(args, "--root", "/ext="+p.extDir, "--ro", entry)
}

// extensionDir is the resolved extensions directory for this server.
func (s *Server) extensionDir() string { return extension.Dir(s.dataDir) }

// extensionRunnerOrDefault returns the configured runner (tests inject a stub).
func (s *Server) extensionRunner() extensionRunner {
	if s.extRunner != nil {
		return s.extRunner
	}
	return newProcessRunner(s.extensionDir())
}

// authorizeExtensionRequest authenticates the extension *render* navigation
// (GET /gqjs/ext/<id>) with the app-shell session credential, and returns the
// validated session token or ("", status, reason) on failure. It writes
// nothing, so the caller shapes its own error body.
//
// Extension navigations are iframe GETs that cannot carry an HMAC header, so
// the browser's suwu_token cookie is used, with the query token as a fallback;
// programmatic callers may authenticate with the Authorization header.
//
// The returned session token is deliberately NOT handed to the render script:
// handleExtension downgrades it to the extension-scoped token. The render
// route keeps the session gate because the iframe is a same-origin navigation
// that carries the cookie; extension tokens are for API calls (see
// authorizeExtensionAPIRequest).
func (s *Server) authorizeExtensionRequest(r *http.Request) (string, int, string) {
	token := ""
	if c, err := r.Cookie("suwu_token"); err == nil {
		token = c.Value
	}
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	if token == "" {
		return "", http.StatusUnauthorized, "Unauthorized"
	}
	origin := r.Header.Get("Origin")
	// Extension pages run in a sandboxed iframe whose opaque origin is the
	// literal "null": it can never match the Host, and failing to parse it
	// would 400 every API call the page makes. Treat it as "no comparable
	// origin" — the request still needs the session token, cross-site callers
	// cannot attach the SameSite=Lax cookie, and the API's CORS grant for null
	// origins is deliberately non-credentialed. Real foreign origins
	// (https://evil.example) keep failing the match inside ValidateAPIRequest.
	if origin == "null" {
		origin = ""
	}
	d, validated := auth.ValidateAPIRequest(s.cfg, r.Host, origin, r.Header.Get("Authorization"), token)
	if !d.OK {
		return "", d.Status, d.Reason
	}
	return validated, 0, ""
}

// authorizeExtensionAPIRequest authenticates an extension API request
// (/gqjs/api/<id>/<path>) against the token derived for id, returning
// (status, reason) with status 0 on success. It writes nothing.
//
// Only the extension-scoped token is accepted — never the app-shell session
// token. The extension page is opaque-origin, so it cannot present the
// suwu_token cookie; its token travels in the query string (or an
// Authorization: Bearer header for programmatic callers).
func (s *Server) authorizeExtensionAPIRequest(r *http.Request, id string) (int, string) {
	token := r.URL.Query().Get("token")
	if token == "" {
		const bearer = "Bearer "
		if header := r.Header.Get("Authorization"); strings.HasPrefix(header, bearer) {
			token = header[len(bearer):]
		}
	}
	if token == "" {
		return http.StatusUnauthorized, "Unauthorized"
	}
	origin := r.Header.Get("Origin")
	// The sandboxed page's opaque origin is the literal "null", which can
	// never match the Host and would fail parsing. Treat it as "no comparable
	// origin": the scoped token is still required, and real foreign origins
	// keep failing the match.
	if origin == "null" {
		origin = ""
	}
	d := auth.ValidateExtensionAPIRequest(s.cfg, r.Host, origin, id, token)
	if !d.OK {
		return d.Status, d.Reason
	}
	return 0, ""
}

// handleExtension renders an extension page: GET /gqjs/ext/<id>
func (s *Server) handleExtension(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if _, authStatus, authReason := s.authorizeExtensionRequest(r); authStatus != 0 {
		writePlain(w, authStatus, authReason)
		return
	}

	id := strings.Trim(strings.TrimPrefix(r.URL.Path, extensionRoutePrefix), "/")
	if id == "" {
		writePlain(w, http.StatusNotFound, "Extension not found")
		return
	}
	ext, err := extension.Resolve(s.extensionDir(), id)
	if err != nil {
		slog.Debug("extension resolve failed", "id", id, "error", err)
		writePlain(w, http.StatusNotFound, "Extension not found")
		return
	}

	// The render navigation carried the session token; the page itself is
	// handed only this extension's scoped token, so a leaked page credential
	// cannot reach the main API or another extension.
	extToken := auth.DeriveExtensionToken(s.cfg, ext.ID)
	raw, err := s.extensionRunner().Exec(r.Context(), ext, ext.Entry, buildExtensionInput(r, ext, extToken))
	if err != nil {
		if errors.Is(err, errExtensionTimeout) || errors.Is(err, context.DeadlineExceeded) {
			writePlain(w, http.StatusGatewayTimeout, "Extension timed out")
			return
		}
		if errors.Is(err, context.Canceled) {
			return // client went away; nothing to report
		}
		slog.Error("extension render failed", "id", ext.ID, "error", err)
		writeExtensionError(w, http.StatusInternalServerError, "Extension failed to render")
		return
	}

	res, err := parseExtensionResult(raw)
	if err != nil {
		slog.Error("extension result invalid", "id", ext.ID, "error", err)
		writeExtensionError(w, http.StatusInternalServerError, "Extension returned an invalid result")
		return
	}

	status := res.Status
	if status < 100 || status > 599 {
		status = http.StatusOK
	}
	contentType := res.ContentType
	if contentType == "" {
		contentType = "text/html; charset=utf-8"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Security-Policy", extensionCSPFor(r))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)

	body := res.page()
	if isHTMLContentType(contentType) {
		body = injectExtensionRelay(body)
	}
	_, _ = io.WriteString(w, body)
}

// handleExtensionsList lists registered extensions:
// GET /api/extensions -> { "extensions": [ {id,name,description,params} ] }
//
// Consumed by the App Menu config editor to populate the extension id
// selector — not by the tile itself.
func (s *Server) handleExtensionsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	exts, err := extension.List(s.extensionDir())
	if err != nil {
		writePlain(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	items := make([]extension.Extension, 0, len(exts))
	for _, e := range exts {
		e.Dir, e.Entry = "", "" // filesystem paths are not part of the API
		items = append(items, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"extensions": items})
}

// buildExtensionInput assembles the `input` global handed to the script.
//
// token is the extension-scoped token derived for this extension (never the
// session token). The render page has an opaque origin, so it cannot
// authenticate to its own API with the cookie; it embeds this token in its API
// URLs instead. The token is stripped from the relayed query/params so a
// ?token= render navigation cannot bounce the credential back through input.
func buildExtensionInput(r *http.Request, ext extension.Extension, token string) map[string]any {
	query := map[string]string{}
	params := map[string]string{}
	for k, vs := range r.URL.Query() {
		if k == "token" {
			continue
		}
		v := ""
		if len(vs) > 0 {
			v = vs[0]
		}
		query[k] = v
		params[k] = v
	}
	return map[string]any{
		"action": "render",
		"id":     ext.ID,
		"token":  token,
		"pane":   params["pane"],
		"method": r.Method,
		"url":    r.URL.Path,
		"query":  query,
		"params": params,
	}
}

// parseExtensionResult interprets the extension's JSON result: a bare string
// is the HTML body, an object may use body/html plus status/contentType.
func parseExtensionResult(raw []byte) (extensionResult, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return extensionResult{}, errors.New("empty result")
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		return extensionResult{Body: str}, nil
	}
	var obj extensionResult
	if err := json.Unmarshal(raw, &obj); err != nil {
		return extensionResult{}, err
	}
	if obj.page() == "" {
		return extensionResult{}, errors.New("result has no body")
	}
	return obj, nil
}

// writeExtensionError sends a minimal, CSP-scoped HTML error page so a broken
// extension never exposes raw stack traces to the browser.
func writeExtensionError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", extensionCSP)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w,
		"<!doctype html><meta charset=\"utf-8\"><title>Extension error</title>"+
			"<body style=\"font:14px/1.5 system-ui;margin:2rem;color:#94a3b8\">"+
			"<h1 style=\"font-size:16px\">"+
			html.EscapeString(msg)+"</h1>"+
			"<p>Status "+strconv.Itoa(status)+".</p></body>")
}
