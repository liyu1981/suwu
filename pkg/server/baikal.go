package server

// Baikal: the herdr-core tile. Suwu is the only client of the core's local
// socket (core has no API password of its own), so these endpoints are a narrow,
// authenticated view of it:
//
//	GET  /api/baikal/snapshot            spaces, terminals, core version
//	GET  /api/baikal/events              server-sent events: "the snapshot moved"
//	POST /api/baikal/run                 start a shell in a directory/space
//	POST /api/baikal/space               rename / recolour / forget a space
//	POST /api/baikal/terminal            kill / remove / read
//	GET  /ws/baikal/attach               one attached terminal, byte stream
//
// See docs/BAIKAL_PLAN.md.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"

	"suwu/pkg/auth"
	"suwu/pkg/herdr"
)

// baikalCores hands out one Core per session.
type baikalCores struct {
	mu    sync.Mutex
	cores map[string]*herdr.Core
}

func newBaikalCores() *baikalCores {
	return &baikalCores{cores: make(map[string]*herdr.Core)}
}

func (b *baikalCores) get(session string) *herdr.Core {
	b.mu.Lock()
	defer b.mu.Unlock()
	if core, ok := b.cores[session]; ok {
		return core
	}
	core := herdr.NewCore(session)
	b.cores[session] = core
	return core
}

// CloseBaikal ends every herdr-core connection this server holds.
func (s *Server) CloseBaikal() {
	if s.baikal != nil {
		s.baikal.closeAll()
	}
}

func (b *baikalCores) closeAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, core := range b.cores {
		core.Close()
	}
	b.cores = make(map[string]*herdr.Core)
}

var (
	// Terminal addresses are `t7` (or a name); a machine prefix is out of scope
	// for v1, so only local, conservative values are accepted.
	baikalTerminalRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	baikalSessionRE  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,32}$`)
)

// baikalSession returns the requested core session, or "" for the server's own
// default (HC_SESSION, else "default") — resolution belongs to pkg/herdr, not to
// the URL.
func baikalSession(r *http.Request) string {
	session := r.URL.Query().Get("session")
	if session == "" || !baikalSessionRE.MatchString(session) {
		return ""
	}
	return session
}

// handleBaikalAPI routes the tile's JSON endpoints.
func (s *Server) handleBaikalAPI(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/baikal/snapshot":
		s.handleBaikalSnapshot(w, r)
	case "/api/baikal/events":
		s.handleBaikalEvents(w, r)
	case "/api/baikal/run":
		s.handleBaikalRun(w, r)
	case "/api/baikal/space":
		s.handleBaikalSpace(w, r)
	case "/api/baikal/terminal":
		s.handleBaikalTerminal(w, r)
	case "/api/baikal/assign":
		s.handleBaikalAssign(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleBaikalSnapshot(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}
	core := s.baikal.get(baikalSession(r))
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	snap, err := core.Snapshot(ctx)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": err.Error(),
			"hint":  "install herdr-core (https://herdr.dev/core/) or set SUWU_HC_BIN",
		})
		return
	}
	snap.Core.Session = core.Session()
	writeJSON(w, http.StatusOK, snap)
}

// handleBaikalEvents streams one event per change of the snapshot, so the tile
// does not have to poll to notice a `cd` (core reports the foreground change
// within 500 ms and this forwards it immediately). The payload is deliberately
// empty: an event means "read the snapshot again", not "here is the delta" — the
// snapshot is already the assembled, authoritative view.
func (s *Server) handleBaikalEvents(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writePlain(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// Proxies (and the Cloudflare tunnel in front of a self-hosted server) buffer
	// a response unless told not to; without this the "live" stream arrives in
	// blocks and the panel updates exactly as late as it used to.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// Confirm the stream is live and say how fast to retry after a drop.
	if _, err := fmt.Fprint(w, "retry: 2000\nevent: ready\ndata: ok\n\n"); err != nil {
		return
	}
	flusher.Flush()

	changes, cancel := s.baikal.get(baikalSession(r)).Subscribe()
	defer cancel()

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case _, ok := <-changes:
			if !ok {
				return
			}
			// A burst (a shell opened: created + labels + foreground) is one
			// snapshot read, so let it settle first.
			settle := time.NewTimer(40 * time.Millisecond)
			select {
			case <-settle.C:
			case <-r.Context().Done():
				settle.Stop()
				return
			}
			if _, err := fmt.Fprint(w, "data: changed\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

type baikalRunRequest struct {
	Cwd     string `json:"cwd"`
	SpaceID string `json:"spaceId"`
	Name    string `json:"name"`
	// Cols/rows size the shell before it draws its prompt; see Core.RunShell.
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

func (s *Server) handleBaikalRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	var req baikalRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if req.Name != "" && !baikalTerminalRE.MatchString(req.Name) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	core := s.baikal.get(baikalSession(r))
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	cols, rows := req.Cols, req.Rows
	if cols < 1 || cols > 4096 {
		cols = 0
	}
	if rows < 1 || rows > 4096 {
		rows = 0
	}
	terminal, spaceID, err := core.RunShell(ctx, req.Cwd, req.SpaceID, req.Name, cols, rows)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"terminal": terminal.Address,
		"spaceId":  spaceID,
		"cwd":      terminal.Cwd,
	})
}

type baikalSpaceRequest struct {
	SpaceID    string `json:"spaceId"`
	Name       string `json:"name"`
	ClearName  bool   `json:"clearName"`
	Colour     string `json:"colour"`
	Identity   string `json:"identityTerminal"`
	IdentityCw string `json:"identityCwd"`
	Forget     bool   `json:"forget"`
}

func (s *Server) handleBaikalSpace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	var req baikalSpaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SpaceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "spaceId required"})
		return
	}
	core := s.baikal.get(baikalSession(r))
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	if req.Forget {
		// Forgetting a space only drops our metadata: the terminals keep their
		// label, and a space with no live terminal stops being listed.
		if err := core.SetSpaceMeta(ctx, req.SpaceID, func(meta *herdr.SpaceMeta) {
			*meta = herdr.SpaceMeta{}
		}); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}

	err := core.SetSpaceMeta(ctx, req.SpaceID, func(meta *herdr.SpaceMeta) {
		// A name pins the space; clearing it returns the name to the directory
		// derivation. Colour-only updates leave the name alone.
		if req.ClearName {
			meta.CustomName = ""
		} else if req.Name != "" {
			meta.CustomName = req.Name
		}
		if req.Colour != "" {
			meta.Colour = req.Colour
		}
		if req.Identity != "" {
			meta.IdentityTerminal = req.Identity
		}
		if req.IdentityCw != "" {
			meta.IdentityCwd = req.IdentityCw
		}
	})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type baikalAssignRequest struct {
	Terminal string `json:"terminal"`
	SpaceID  string `json:"spaceId"`
}

// handleBaikalAssign adopts a terminal into a space by setting its `space`
// label — the same convention baikal uses when it starts a shell.
func (s *Server) handleBaikalAssign(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	var req baikalAssignRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !baikalTerminalRE.MatchString(req.Terminal) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid terminal"})
		return
	}
	if req.SpaceID != "" && !baikalTerminalRE.MatchString(req.SpaceID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid space"})
		return
	}
	core := s.baikal.get(baikalSession(r))
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	// An empty spaceId removes the label (back to "unassigned").
	if err := core.Label(ctx, req.Terminal, map[string]string{"space": req.SpaceID}); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type baikalTerminalRequest struct {
	Action   string `json:"action"`
	Terminal string `json:"terminal"`
	Lines    int    `json:"lines"`
}

func (s *Server) handleBaikalTerminal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	var req baikalTerminalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !baikalTerminalRE.MatchString(req.Terminal) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid terminal"})
		return
	}
	core := s.baikal.get(baikalSession(r))
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	switch req.Action {
	case "read":
		text, err := core.ReadText(ctx, req.Terminal, req.Lines)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"text": text})
	case "kill":
		if err := core.Kill(ctx, req.Terminal); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "rm":
		if err := core.Remove(ctx, req.Terminal); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown action"})
	}
}

// handleBaikalAttach streams one terminal to the tile.
//
// Browser -> server: binary frames are keyboard bytes; text frames are control
// ({type:"resize"|"close"}).
// Server -> browser: binary frames are terminal output; text frames are control
// ({type:"ready"|"close"}).
func (s *Server) handleBaikalAttach(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	q := r.URL.Query()
	d := auth.ValidateWebSocketRequest(s.cfg, r.Host, r.Header.Get("Origin"), q.Get("token"))
	if !d.OK {
		slogWarnWSRejected(r, d)
		writePlain(w, d.Status, d.Reason)
		return
	}
	terminal := q.Get("terminal")
	if !baikalTerminalRE.MatchString(terminal) {
		writePlain(w, http.StatusBadRequest, "invalid terminal")
		return
	}
	cols, _ := strconv.Atoi(q.Get("cols"))
	rows, _ := strconv.Atoi(q.Get("rows"))
	if cols <= 0 || cols > 4096 {
		cols = 80
	}
	if rows <= 0 || rows > 4096 {
		rows = 24
	}
	observe := q.Get("observe") == "1"

	s.clients.Touch(r.RemoteAddr)
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusInternalError, "")
	conn.SetReadLimit(maxInputFrame)

	ctx := r.Context()
	core := s.baikal.get(baikalSession(r))
	stream, err := core.Attach(ctx, terminal, cols, rows, observe)
	if err != nil {
		_ = writeWS(ctx, conn, websocket.MessageText, mustJSON(map[string]any{
			"type":   "close",
			"reason": err.Error(),
		}))
		_ = conn.Close(websocket.StatusNormalClosure, "attach failed")
		return
	}
	defer func() { _ = stream.Close() }()

	ready := map[string]any{
		"type":     "ready",
		"terminal": terminal,
		"cols":     cols,
		"rows":     rows,
		"observe":  observe,
	}
	if err := writeWS(ctx, conn, websocket.MessageText, mustJSON(ready)); err != nil {
		return
	}

	// browser -> core
	go func() {
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				_ = stream.Close()
				return
			}
			switch typ {
			case websocket.MessageBinary:
				if observe {
					continue
				}
				if err := stream.Write(data); err != nil {
					return
				}
			case websocket.MessageText:
				var msg struct {
					Type string `json:"type"`
					Cols int    `json:"cols"`
					Rows int    `json:"rows"`
				}
				if json.Unmarshal(data, &msg) != nil {
					continue
				}
				switch msg.Type {
				case "resize":
					if observe || msg.Cols <= 0 || msg.Rows <= 0 {
						continue
					}
					_ = stream.Resize(msg.Cols, msg.Rows)
				case "close":
					_ = stream.Close()
					return
				}
			}
		}
	}()

	// core -> browser
	for {
		select {
		case <-ctx.Done():
			return
		case <-stream.Closed():
			// Core sends the reason as JSON: {"reason":"exited","exit_code":0,…}.
			closeMsg := map[string]any{"type": "close"}
			if raw := stream.Reason(); raw != "" {
				var cr struct {
					Reason   string `json:"reason"`
					ExitCode *int   `json:"exit_code"`
				}
				if json.Unmarshal([]byte(raw), &cr) == nil && cr.Reason != "" {
					closeMsg["reason"] = cr.Reason
					if cr.ExitCode != nil {
						closeMsg["exitCode"] = *cr.ExitCode
					}
				}
			}
			_ = writeWS(ctx, conn, websocket.MessageText, mustJSON(closeMsg))
			return
		case chunk, ok := <-stream.Data():
			if !ok {
				return
			}
			if err := writeWS(ctx, conn, websocket.MessageBinary, chunk); err != nil {
				return
			}
			stream.Credit(len(chunk))
		}
	}
}

func mustJSON(v any) []byte {
	out, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"type":"close","reason":"encode failed"}`)
	}
	return out
}

// slogWarnWSRejected keeps the rejection visible in the log (the browser cannot
// read a WebSocket handshake's response).
func slogWarnWSRejected(r *http.Request, d auth.Decision) {
	slog.Warn("baikal websocket rejected", "host", r.Host, "origin", r.Header.Get("Origin"),
		"status", d.Status, "reason", d.Reason)
}
