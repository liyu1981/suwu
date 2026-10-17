// Package lives2d is the provider registry behind the "2D Lives" background:
// animated wallpapers pulled from a third-party site.
//
// A provider is an adapter over exactly one site. It knows how to search that
// site and how to resolve one search result into a downloadable media file.
// The Suwu server exposes both over HTTP (pkg/server/lives2d.go), so the
// browser never talks to the third-party origin directly — which is what makes
// the feature work at all, since those origins do not send CORS headers — and
// the provider can be upgraded, swapped or supplemented without touching the
// frontend.
//
// Adapters register themselves from an init function in their own package (see
// pkg/lives2d/moewalls) and the server blank-imports them; nothing else needs
// to know a provider exists.
package lives2d

import (
	"context"
	"sort"
	"sync"
)

// Credit is the attribution shown next to a provider's search UI.
type Credit struct {
	Author  string `json:"author"`
	URL     string `json:"url,omitempty"`
	License string `json:"license,omitempty"`
}

// Item is one search result. ID is provider-scoped and is the only thing the
// client sends back to resolve/download it.
type Item struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	PageURL      string `json:"pageUrl"`
	ThumbnailURL string `json:"thumbnailUrl"`
	Resolution   string `json:"resolution,omitempty"`
}

// SearchPage is one page of search results.
type SearchPage struct {
	Items   []Item `json:"items"`
	Page    int    `json:"page"`
	HasMore bool   `json:"hasMore"`
}

// Media is a resolved download target.
type Media struct {
	// URL is the absolute, allow-listed media URL the server may fetch.
	URL string
	// Filename is a fallback used when the origin sends no Content-Disposition.
	Filename string
	// ContentType is a fallback used when the origin sends no Content-Type.
	ContentType string
}

// Provider adapts one third-party animated-wallpaper site.
type Provider interface {
	// ID is the stable provider key used in URLs and storage.
	ID() string
	// Label is the human-readable provider name.
	Label() string
	// Credit is the attribution for the site.
	Credit() Credit
	// ImageOrigins are the CSP source expressions the browser needs to show
	// this provider's thumbnails, e.g. "https://example.com". They are added to
	// the app shell's img-src so a search result can render its preview.
	ImageOrigins() []string
	// Search returns one page (1-based) of results for query.
	Search(ctx context.Context, query string, page int) (SearchPage, error)
	// Resolve turns a result ID into a downloadable media target.
	Resolve(ctx context.Context, id string) (Media, error)
}

var (
	mu       sync.RWMutex
	registry = map[string]Provider{}
)

// Register adds a provider to the registry, replacing any provider with the
// same id. It is meant to be called from an adapter's init function.
func Register(p Provider) {
	if p == nil || p.ID() == "" {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	registry[p.ID()] = p
}

// Get looks a provider up by id.
func Get(id string) (Provider, bool) {
	mu.RLock()
	defer mu.RUnlock()
	p, ok := registry[id]
	return p, ok
}

// List returns every registered provider, ordered by id.
func List() []Provider {
	mu.RLock()
	out := make([]Provider, 0, len(registry))
	for _, p := range registry {
		out = append(out, p)
	}
	mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ID() < out[j].ID() })
	return out
}

// ImageOrigins returns the de-duplicated union of every provider's CSP image
// origins, used to extend the app shell's img-src.
func ImageOrigins() []string {
	mu.RLock()
	defer mu.RUnlock()
	seen := map[string]bool{}
	var out []string
	for _, p := range registry {
		for _, origin := range p.ImageOrigins() {
			if origin != "" && !seen[origin] {
				seen[origin] = true
				out = append(out, origin)
			}
		}
	}
	sort.Strings(out)
	return out
}
