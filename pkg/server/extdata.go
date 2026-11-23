package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"suwu/pkg/extdata"
)

// Server-scoped extension records (docs/EXTENSION_TILE_PLAN.md §4.8).
//
// The browser bridge gives an extension a per-extension IndexedDB namespace;
// the same namespace exists on the server so an extension can opt into "one
// copy on every device". The page proxies the extension's request with its own
// token, exactly like every other /api call: an extension frame never holds a
// credential and never talks to the server directly.
//
//	GET    /api/ext/data/<id>          -> { keys: [...] }
//	GET    /api/ext/data/<id>/<key>    -> { value: <json> }
//	PUT    /api/ext/data/<id>/<key>    -> { ok: true }
//	DELETE /api/ext/data/<id>/<key>    -> { ok: true }
//
// The id is validated against the extension grammar and the key against the same
// charset the browser bridge enforces, so a record can only ever be addressed as
// <dataDir>/extension-data/<id>/<key>.json.
const extDataPrefix = "/api/ext/data/"

func (s *Server) handleExtData(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, extDataPrefix) {
		writePlain(w, http.StatusNotFound, "Not Found")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, extDataPrefix)
	id, key, hasKey := strings.Cut(rest, "/")
	if id == "" || !extdata.ValidID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid extension id"})
		return
	}
	if hasKey && !extdata.ValidKey(key) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid key"})
		return
	}
	store, err := extdata.New(s.dataDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	switch {
	case !hasKey:
		s.handleExtDataList(w, r, store, id)
	case r.Method == http.MethodGet:
		s.handleExtDataGet(w, store, id, key)
	case r.Method == http.MethodPut:
		s.handleExtDataPut(w, r, store, id, key)
	case r.Method == http.MethodDelete:
		if err := store.Delete(id, key); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (s *Server) handleExtDataList(w http.ResponseWriter, r *http.Request, store *extdata.Store, id string) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	keys, err := store.List(id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if keys == nil {
		keys = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

func (s *Server) handleExtDataGet(w http.ResponseWriter, store *extdata.Store, id, key string) {
	value, err := store.Get(id, key)
	if err != nil {
		if errors.Is(err, extdata.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such record"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	// The stored bytes are already JSON; re-wrapping them as a string would
	// make every client parse twice for no reason.
	_, _ = w.Write([]byte(`{"value":`))
	_, _ = w.Write(value)
	_, _ = w.Write([]byte("}\n"))
}

func (s *Server) handleExtDataPut(w http.ResponseWriter, r *http.Request, store *extdata.Store, id, key string) {
	// The cap plus room for the JSON envelope, so an honest 512 KB record is not
	// rejected by the reader before the store can measure it.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, extdata.MaxValueBytes+64))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "record is too large"})
		return
	}
	var envelope struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || len(envelope.Value) == 0 {
		// A bare JSON body is accepted too: an extension that already has the
		// value does not need to wrap it.
		if json.Valid(body) {
			envelope.Value = body
		} else {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body must be JSON"})
			return
		}
	}
	if err := store.Set(id, key, envelope.Value); err != nil {
		if errors.Is(err, extdata.ErrTooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": err.Error()})
			return
		}
		if strings.Contains(err.Error(), "not JSON") || strings.Contains(err.Error(), "not a key") || strings.Contains(err.Error(), "not an extension id") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
