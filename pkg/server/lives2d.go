package server

// 2D live-wallpaper endpoints. The browser cannot fetch moewalls.com directly
// (no CORS headers), so every network call goes through these handlers and the
// provider adapters in pkg/lives2d. The frontend is provider-agnostic: it
// lists providers, searches one, and streams a chosen result into OPFS.
//
//   GET /api/lives2d/providers                 -> { providers: [{id,label,credit}] }
//   GET /api/lives2d/search?provider=&q=&page= -> SearchPage JSON
//   GET /api/lives2d/media?provider=&id=       -> the resolved media file
//
// The blank import registers the built-in providers.

import (
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"suwu/pkg/lives2d"
	_ "suwu/pkg/lives2d/moewalls"
)

const lives2dRoutePrefix = "/api/lives2d/"

// maxMediaBytes caps one proxied wallpaper download.
const maxMediaBytes = 256 << 20 // 256 MiB

// livesUserAgent is used for the media fetch (the adapters fetch pages with
// their own browser UA).
const livesUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// livesMediaClient has no total timeout (a wallpaper can be tens of MB) but
// gives up when the origin never sends response headers.
var livesMediaClient = &http.Client{
	Transport: &http.Transport{ResponseHeaderTimeout: 30 * time.Second},
}

type livesProviderInfo struct {
	ID     string         `json:"id"`
	Label  string         `json:"label"`
	Credit lives2d.Credit `json:"credit"`
}

// handleLives2D routes every live-wallpaper request.
func (s *Server) handleLives2D(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}
	switch strings.TrimPrefix(r.URL.Path, lives2dRoutePrefix) {
	case "providers":
		s.handleLives2DProviders(w, r)
	case "search":
		s.handleLives2DSearch(w, r)
	case "media":
		s.handleLives2DMedia(w, r)
	default:
		writePlain(w, http.StatusNotFound, "Not Found")
	}
}

func (s *Server) handleLives2DProviders(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	providers := lives2d.List()
	out := make([]livesProviderInfo, 0, len(providers))
	for _, p := range providers {
		out = append(out, livesProviderInfo{ID: p.ID(), Label: p.Label(), Credit: p.Credit()})
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": out})
}

func (s *Server) handleLives2DSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	provider, ok := s.livesProvider(w, r)
	if !ok {
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writePlain(w, http.StatusBadRequest, "q is required")
		return
	}
	if len(query) > 100 {
		query = query[:100]
	}
	page := 1
	if raw := r.URL.Query().Get("page"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			page = n
		}
	}

	result, err := provider.Search(r.Context(), query, page)
	if err != nil {
		slog.Warn("lives2d search failed", "provider", provider.ID(), "error", err)
		writePlain(w, http.StatusBadGateway, "Search failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleLives2DMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	provider, ok := s.livesProvider(w, r)
	if !ok {
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writePlain(w, http.StatusBadRequest, "id is required")
		return
	}

	media, err := provider.Resolve(r.Context(), id)
	if err != nil {
		slog.Warn("lives2d resolve failed", "provider", provider.ID(), "error", err)
		writePlain(w, http.StatusBadGateway, "Could not resolve wallpaper: "+err.Error())
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, media.URL, nil)
	if err != nil {
		writePlain(w, http.StatusBadGateway, "Could not build download request")
		return
	}
	req.Header.Set("User-Agent", livesUserAgent)

	resp, err := livesMediaClient.Do(req)
	if err != nil {
		slog.Warn("lives2d media fetch failed", "provider", provider.ID(), "error", err)
		writePlain(w, http.StatusBadGateway, "Download failed")
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		writePlain(w, http.StatusBadGateway, "Origin responded with HTTP "+strconv.Itoa(resp.StatusCode))
		return
	}
	if resp.ContentLength > maxMediaBytes {
		writePlain(w, http.StatusRequestEntityTooLarge, "Wallpaper is too large")
		return
	}

	contentType := media.ContentType
	if ct := resp.Header.Get("Content-Type"); ct != "" && strings.HasPrefix(ct, "video/") {
		contentType = ct
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		w.Header().Set("Content-Disposition", cd)
	} else {
		w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(media.Filename)+`"`)
	}

	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(w, io.LimitReader(resp.Body, maxMediaBytes)); err != nil {
		// The response is already committed; log and stop.
		slog.Debug("lives2d media stream interrupted", "provider", provider.ID(), "error", err)
	}
}

// livesProvider resolves and validates the ?provider= parameter.
func (s *Server) livesProvider(w http.ResponseWriter, r *http.Request) (lives2d.Provider, bool) {
	id := strings.TrimSpace(r.URL.Query().Get("provider"))
	if id == "" {
		writePlain(w, http.StatusBadRequest, "provider is required")
		return nil, false
	}
	provider, ok := lives2d.Get(id)
	if !ok {
		writePlain(w, http.StatusNotFound, "Unknown provider")
		return nil, false
	}
	return provider, true
}

// sanitizeFilename keeps a Content-Disposition filename free of quotes, path
// separators and control characters.
func sanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	name = strings.NewReplacer("\"", "", "\\", "", "/", "-", "\r", "", "\n", "").Replace(name)
	if name == "" {
		return "wallpaper.mp4"
	}
	return name
}
