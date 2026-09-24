package server

// Extension APIs: /gqjs/api/<id>/<path> selects one of the extension's
// registered {route, handler} entries (package.json → suwu.api, first match
// in declaration order wins) and executes that handler script through the
// same isolated `suwu gq` child process as page renders.
//
// Unlike page renders, API responses are pure data: the backend injects no
// script (no focus/key relay), serves JSON by default, and relays the
// handler's status/headers/body behind a denylist. See
// docs/EXTENSION_API_PLAN.md.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"unicode/utf8"

	"suwu/pkg/extension"
)

// extensionAPIRoutePrefix is the path prefix for extension API requests.
const extensionAPIRoutePrefix = "/gqjs/api/"

// extensionAPIMaxBody caps an incoming request body relayed to a handler,
// mirroring the 4 MiB response-body cap in pkg/gqjs.
const extensionAPIMaxBody = 4 << 20 // 4 MiB

// extensionAPICSP scopes API responses. Handlers serve data, not pages: no
// scripts ever, and only our own origin may frame the response.
const extensionAPICSP = "default-src 'none'; " +
	"style-src 'unsafe-inline'; " +
	"frame-ancestors 'self'"

// extensionAPIAllow is the method allowlist forwarded to handlers; anything
// else (CONNECT, TRACE, ...) is rejected before a child process starts.
// Handlers enforce their own per-route method rules and may answer 405.
var extensionAPIAllow = map[string]bool{
	http.MethodGet:     true,
	http.MethodHead:    true,
	http.MethodPost:    true,
	http.MethodPut:     true,
	http.MethodPatch:   true,
	http.MethodDelete:  true,
	http.MethodOptions: true,
}

// isDeniedAPIHeader reports whether a handler-set response header is withheld.
// Hop-by-hop and framing headers, the session cookie (an extension must never
// overwrite suwu_token), CORS grants, and the headers this handler sets
// itself are all refused.
func isDeniedAPIHeader(h string) bool {
	switch strings.ToLower(h) {
	case "content-length", "content-encoding", "transfer-encoding",
		"connection", "keep-alive", "trailer", "upgrade",
		"set-cookie", "content-security-policy", "cache-control",
		"x-content-type-options", "referrer-policy", "content-type":
		return true
	}
	return strings.HasPrefix(strings.ToLower(h), "access-control-")
}

// extensionAPIResult is the JSON contract a handler returns. Exactly one of
// Body (UTF-8 text) or BodyB64 (raw bytes) carries the payload; an empty
// result means "no content" (204).
type extensionAPIResult struct {
	Status      int               `json:"status"`
	ContentType string            `json:"contentType"`
	Headers     map[string]string `json:"headers"`
	Body        string            `json:"body"`
	BodyB64     string            `json:"bodyB64"`
}

// grantOpaqueOriginCORS marks an API response readable by a sandboxed
// extension page. Those pages run with an opaque ("null") origin, so without
// an explicit grant every call back into their own API is blocked by CORS.
// Only the literal null origin is granted, and without credentials: API auth
// rides on the query token, so a foreign null-origin page with no token still
// gets an unusable 401.
func grantOpaqueOriginCORS(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") == "null" {
		w.Header().Set("Access-Control-Allow-Origin", "null")
		w.Header().Add("Vary", "Origin")
	}
}

// requestedHeaders answers Access-Control-Allow-Headers by reflecting the
// browser's own Access-Control-Request-Headers list. htmx always sends HX-*
// headers (HX-Request, HX-Trigger, HX-Current-URL, …), so a fixed allow-list
// breaks the moment a client adds one; reflecting the names is the standard
// robust answer. The grant is non-credentialed and token-authed, so header
// names alone grant no data access. Control characters are stripped before
// the value re-enters the response.
func requestedHeaders(r *http.Request) string {
	requested := strings.Map(func(c rune) rune {
		if c < 0x20 || c == 0x7f {
			return -1
		}
		return c
	}, r.Header.Get("Access-Control-Request-Headers"))
	if requested == "" {
		return "Content-Type"
	}
	return requested
}

// handleExtensionAPI serves an extension API request:
// GET/POST/... /gqjs/api/<ext_id>/<path>
func (s *Server) handleExtensionAPI(w http.ResponseWriter, r *http.Request) {
	grantOpaqueOriginCORS(w, r)

	// CORS preflight carries no token, so answer it here — it reveals only
	// this endpoint's method/header policy and never reaches the handler.
	if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", requestedHeaders(r))
		w.Header().Set("Access-Control-Max-Age", "600")
		// Chrome's private-network preflight: the page may live on a public
		// "null" origin while the API is on a LAN address.
		if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if !extensionAPIAllow[r.Method] {
		w.Header().Set("Allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
		writeExtensionAPIError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	// <ext_id> is the first segment; everything after it is the path handed
	// to route matching and the handler. The id is parsed before auth because
	// the accepted token is derived from it, and only that extension's token
	// is valid.
	rest := strings.TrimPrefix(r.URL.Path, extensionAPIRoutePrefix)
	id, reqPath, _ := strings.Cut(rest, "/")
	if !extension.ValidID(id) {
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	if status, reason := s.authorizeExtensionAPIRequest(r, id); status != 0 {
		writeExtensionAPIError(w, status, reason)
		return
	}
	ext, err := extension.Resolve(s.extensionDir(), id)
	if err != nil {
		slog.Debug("extension resolve failed", "id", id, "error", err)
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	if len(ext.API) == 0 {
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	path := "/" + strings.Trim(reqPath, "/")
	route, pathParams, matched := extension.MatchAPI(ext.API, path)
	if !matched {
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	handlerPath, err := ext.HandlerPath(route.Handler)
	if err != nil {
		slog.Error("extension api handler path", "id", ext.ID, "handler", route.Handler, "error", err)
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	if st, serr := os.Stat(handlerPath); serr != nil || st.IsDir() {
		slog.Debug("extension api handler missing", "id", ext.ID, "handler", route.Handler, "error", serr)
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, extensionAPIMaxBody+1))
	if err != nil {
		writeExtensionAPIError(w, http.StatusBadRequest, "Bad Request")
		return
	}
	if len(body) > extensionAPIMaxBody {
		writeExtensionAPIError(w, http.StatusRequestEntityTooLarge, "Request body too large")
		return
	}

	raw, err := s.extensionRunner().Exec(r.Context(), ext, handlerPath,
		buildExtensionAPIInput(r, ext, route.Route, path, pathParams, body))
	if err != nil {
		if errors.Is(err, errExtensionTimeout) || errors.Is(err, context.DeadlineExceeded) {
			writeExtensionAPIError(w, http.StatusGatewayTimeout, "Extension timed out")
			return
		}
		if errors.Is(err, context.Canceled) {
			return // client went away; nothing to report
		}
		slog.Error("extension api failed", "id", ext.ID, "handler", route.Handler, "error", err)
		writeExtensionAPIError(w, http.StatusInternalServerError, "Extension API failed")
		return
	}

	res, err := parseExtensionAPIResult(raw)
	if err != nil {
		slog.Error("extension api result invalid", "id", ext.ID, "handler", route.Handler, "error", err)
		writeExtensionAPIError(w, http.StatusInternalServerError, "Extension returned an invalid result")
		return
	}

	payload := []byte(res.Body)
	if res.BodyB64 != "" {
		payload, err = base64.StdEncoding.DecodeString(res.BodyB64)
		if err != nil {
			slog.Error("extension api result invalid", "id", ext.ID, "error", err)
			writeExtensionAPIError(w, http.StatusInternalServerError, "Extension returned an invalid result")
			return
		}
	}
	status := res.Status
	switch {
	case status == 0 && len(payload) == 0:
		status = http.StatusNoContent // nothing returned: 204 semantics
	case status == 0:
		status = http.StatusOK
	case status < 100 || status > 599:
		status = http.StatusOK
	}

	// Handler headers first, ours last: the denylist above plus Set overrides
	// mean a handler can never restate the response's own framing.
	for k, v := range res.Headers {
		if !isDeniedAPIHeader(k) {
			w.Header().Set(k, v)
		}
	}
	contentType := res.ContentType
	if contentType == "" {
		contentType = "application/json; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Security-Policy", extensionAPICSP)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	if len(payload) > 0 {
		_, _ = w.Write(payload)
	}
}

// buildExtensionAPIInput assembles the `input` global handed to the handler.
// The path is normalized (leading slash), route bindings land in pathParams,
// and the payload crosses as text when it is valid UTF-8 and as base64
// otherwise. The auth query token is stripped — it is transport, not data —
// and credential headers (Authorization, Cookie) are withheld so a caller's
// session credential can never be relayed into extension code.
func buildExtensionAPIInput(
	r *http.Request,
	ext extension.Extension,
	route, path string,
	pathParams map[string]string,
	body []byte,
) map[string]any {
	query := map[string]string{}
	for k, vs := range r.URL.Query() {
		if k == "token" {
			continue
		}
		if len(vs) > 0 {
			query[k] = vs[0]
		}
	}
	headers := map[string]string{}
	for k, vs := range r.Header {
		if len(vs) == 0 {
			continue
		}
		switch strings.ToLower(k) {
		case "authorization", "cookie":
			continue
		}
		headers[strings.ToLower(k)] = strings.Join(vs, ", ")
	}
	if pathParams == nil {
		pathParams = map[string]string{}
	}
	input := map[string]any{
		"action":     "api",
		"id":         ext.ID,
		"route":      route,
		"path":       path,
		"pathParams": pathParams,
		"method":     r.Method,
		"query":      query,
		"headers":    headers,
	}
	if len(body) > 0 {
		if utf8.Valid(body) {
			input["body"] = string(body)
		} else {
			input["bodyB64"] = base64.StdEncoding.EncodeToString(body)
		}
	}
	return input
}

// parseExtensionAPIResult interprets the handler's JSON result: a bare string
// is the body, an object carries the full contract, and an empty/null result
// means no content. Unlike page renders, a missing body is legal (204).
func parseExtensionAPIResult(raw []byte) (extensionAPIResult, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return extensionAPIResult{}, nil
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		return extensionAPIResult{Body: str}, nil
	}
	var obj extensionAPIResult
	if err := json.Unmarshal(raw, &obj); err != nil {
		return extensionAPIResult{}, err
	}
	return obj, nil
}

// writeExtensionAPIError sends a JSON error body; extension failures never
// expose raw stack traces to the client.
func writeExtensionAPIError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
