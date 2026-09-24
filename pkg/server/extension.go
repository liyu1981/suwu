package server

// Extension rendering: GET /gqjs/<id> runs a gqjs-backed extension in a
// separate `suwu gq` child process and returns the HTML page it produces.
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
const extensionRoutePrefix = "/gqjs/"

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
const extensionCSP = "default-src 'none'; " +
	"script-src 'unsafe-inline'; " +
	"style-src 'unsafe-inline'; " +
	"img-src data: blob:; " +
	"font-src data:; " +
	"connect-src 'self'; " +
	"frame-ancestors 'self'"

// defaultExtensionTimeout follows PHP's max_execution_time rule. Override with
// SUWU_EXTENSION_TIMEOUT (e.g. a short value in tests).
const defaultExtensionTimeout = 30 * time.Second

// defaultExtensionConcurrency caps how many extension child processes may run
// at once.
const defaultExtensionConcurrency = 4

// errExtensionTimeout reports that an extension render hit its deadline.
var errExtensionTimeout = errors.New("extension render timed out")

// extensionRunner renders one extension into its result JSON.
type extensionRunner interface {
	Render(ctx context.Context, ext extension.Extension, input map[string]any) ([]byte, error)
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

func (p *processRunner) Render(ctx context.Context, ext extension.Extension, input map[string]any) ([]byte, error) {
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

	cmd := exec.CommandContext(runCtx, p.binary, "gq",
		"--timeout", p.timeout.String(),
		"--result-file", resultPath,
		"--input", string(inputJSON),
		"--root", "/ext="+p.extDir,
		"--ro",
		ext.Entry,
	)
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

// extensionDir is the resolved extensions directory for this server.
func (s *Server) extensionDir() string { return extension.Dir(s.dataDir) }

// extensionRunnerOrDefault returns the configured runner (tests inject a stub).
func (s *Server) extensionRunner() extensionRunner {
	if s.extRunner != nil {
		return s.extRunner
	}
	return newProcessRunner(s.extensionDir())
}

// validateExtensionRequest authenticates an extension page navigation. These
// are iframe GETs that cannot carry an HMAC header, so the browser's
// suwu_token cookie is used, with the query token as a fallback.
func (s *Server) validateExtensionRequest(w http.ResponseWriter, r *http.Request) string {
	token := ""
	if c, err := r.Cookie("suwu_token"); err == nil {
		token = c.Value
	}
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	if token == "" {
		writePlain(w, http.StatusUnauthorized, "Unauthorized")
		return ""
	}
	d, validated := auth.ValidateAPIRequest(s.cfg, r.Host, r.Header.Get("Origin"), r.Header.Get("Authorization"), token)
	if !d.OK {
		writePlain(w, d.Status, d.Reason)
		return ""
	}
	return validated
}

// handleExtension renders an extension page: GET /gqjs/<id>
func (s *Server) handleExtension(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateExtensionRequest(w, r) == "" {
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

	raw, err := s.extensionRunner().Render(r.Context(), ext, buildExtensionInput(r, ext))
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
	w.Header().Set("Content-Security-Policy", extensionCSP)
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
func buildExtensionInput(r *http.Request, ext extension.Extension) map[string]any {
	query := map[string]string{}
	params := map[string]string{}
	for k, vs := range r.URL.Query() {
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
