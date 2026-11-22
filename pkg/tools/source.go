package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"suwu/pkg/version"
)

// Where the catalog is read from at runtime.
const (
	// DefaultRepo is the first-party repository the catalog lives in.
	DefaultRepo = "liyu1981/suwu"
	// CatalogPath is the catalog's path inside that repository, i.e. the same
	// file the Go embed and the release builders read.
	CatalogPath = "tools/catalog.json"
	// RawBaseURL is the raw.githubusercontent.com host.
	RawBaseURL = "https://raw.githubusercontent.com"
	// DefaultTTL is how long a fetched catalog is reused before a conditional
	// revalidation.
	DefaultTTL = 6 * time.Hour
	// RefEnv overrides the ref the catalog is read at (development).
	RefEnv = "SUWU_TOOLS_REF"
	// RawBaseEnv overrides the host the catalog is read from: a mirror, or an
	// unreachable address in a test that must not depend on the network.
	RawBaseEnv = "SUWU_TOOLS_RAW_BASE"
	// maxCatalogBytes bounds the catalog response.
	maxCatalogBytes = 1 << 20
	// cacheName is the catalog cache under <dataDir>/cache.
	cacheName = "tools-catalog.json"
)

// Source fetches tools/catalog.json from GitHub, with an ETag cache so a page
// load does not spend a request, and a stale copy so an offline machine still
// lists the tools it could not refresh.
type Source struct {
	Repo string
	Ref  string
	// RawBase is the host; tests point it at an httptest server.
	RawBase string
	Client  *http.Client
	// CachePath is the JSON file holding the last catalog and its ETag.
	CachePath string
	TTL       time.Duration
	// Now is the clock, injectable for tests.
	Now func() time.Time
}

// Origin describes where a catalog came from, for the page to show.
type Origin struct {
	Repo      string `json:"repo"`
	Ref       string `json:"ref"`
	Path      string `json:"path"`
	FetchedAt string `json:"fetchedAt,omitempty"`
	// Stale means the refresh failed and this is the cached copy.
	Stale bool `json:"stale"`
	// Cached means no request was needed (the cache was fresh).
	Cached bool `json:"cached"`
}

// NewSource returns the runtime source for a data dir. The ref is the running
// build's own tag, so a binary is only ever offered tool versions that existed
// when it was built; `SUWU_TOOLS_REF` overrides it, and an untagged build
// (version "dev") reads master.
func NewSource(dataDir string) *Source {
	rawBase := strings.TrimSpace(os.Getenv(RawBaseEnv))
	if rawBase == "" {
		rawBase = RawBaseURL
	}
	return &Source{
		Repo:      DefaultRepo,
		Ref:       defaultRef(),
		RawBase:   rawBase,
		Client:    &http.Client{Timeout: 20 * time.Second},
		CachePath: filepath.Join(dataDir, "cache", cacheName),
		TTL:       DefaultTTL,
		Now:       time.Now,
	}
}

func defaultRef() string {
	if ref := strings.TrimSpace(os.Getenv(RefEnv)); ref != "" {
		return ref
	}
	v := strings.TrimSpace(version.Version)
	if v == "" || v == "dev" || !strings.HasPrefix(v, "v") {
		return "master"
	}
	return v
}

// cached is the on-disk cache document.
type cached struct {
	Repo      string  `json:"repo"`
	Ref       string  `json:"ref"`
	ETag      string  `json:"etag,omitempty"`
	FetchedAt string  `json:"fetchedAt"`
	Catalog   Catalog `json:"catalog"`
}

// Load returns the catalog for this source.
func (s *Source) Load(ctx context.Context) (*Catalog, Origin, error) {
	origin := Origin{Repo: s.Repo, Ref: s.Ref, Path: CatalogPath}
	now := s.now()
	cache, cacheErr := s.readCache()

	if cacheErr == nil && cache.Ref == s.Ref && s.TTL > 0 {
		if fetched, err := time.Parse(time.RFC3339, cache.FetchedAt); err == nil && now.Sub(fetched) < s.TTL {
			cat := cache.Catalog
			origin.FetchedAt = cache.FetchedAt
			origin.Cached = true
			return &cat, origin, nil
		}
	}

	cat, etag, fetchedAt, err := s.fetch(ctx, cacheETag(cache))
	if err != nil {
		// Offline, rate-limited or the ref is gone: an installed tool list beats
		// an empty page, as long as the caller can say it is stale.
		if cacheErr == nil && cache.Ref == s.Ref {
			stale := cache.Catalog
			origin.FetchedAt = cache.FetchedAt
			origin.Stale = true
			return &stale, origin, nil
		}
		return nil, origin, err
	}
	origin.FetchedAt = fetchedAt
	if cat == nil { // 304: the cache is still current
		cat = &cache.Catalog
		origin.Cached = true
		_ = s.writeCache(cached{Repo: s.Repo, Ref: s.Ref, ETag: etag, FetchedAt: fetchedAt, Catalog: *cat})
		return cat, origin, nil
	}
	_ = s.writeCache(cached{Repo: s.Repo, Ref: s.Ref, ETag: etag, FetchedAt: fetchedAt, Catalog: *cat})
	return cat, origin, nil
}

// Refresh is Load without the cache: it ignores the TTL and the stored ETag so
// `suwu tools list --refresh` really asks GitHub.
func (s *Source) Refresh(ctx context.Context) (*Catalog, Origin, error) {
	origin := Origin{Repo: s.Repo, Ref: s.Ref, Path: CatalogPath}
	cat, etag, fetchedAt, err := s.fetch(ctx, "")
	if err != nil {
		return nil, origin, err
	}
	if cat == nil { // a 304 is impossible without an ETag, but be explicit
		return nil, origin, errors.New("fetch catalog: unexpected 304")
	}
	origin.FetchedAt = fetchedAt
	_ = s.writeCache(cached{Repo: s.Repo, Ref: s.Ref, ETag: etag, FetchedAt: fetchedAt, Catalog: *cat})
	return cat, origin, nil
}

// Offline returns the catalog embedded in this build. It is the fallback when
// there is no cache and no network: the list is real, the downloads will fail.
func Offline() (*Catalog, error) { return Builtin() }

func (s *Source) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func cacheETag(c cached) string {
	if c.ETag == "" {
		return ""
	}
	return c.ETag
}

func (s *Source) url() string {
	base := s.RawBase
	if base == "" {
		base = RawBaseURL
	}
	return fmt.Sprintf("%s/%s/%s/%s", strings.TrimRight(base, "/"), s.Repo, s.Ref, CatalogPath)
}

// fetch performs one conditional GET. A nil catalog with no error means 304.
func (s *Source) fetch(ctx context.Context, etag string) (*Catalog, string, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url(), nil)
	if err != nil {
		return nil, "", "", err
	}
	req.Header.Set("User-Agent", "suwu-tools")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", "", fmt.Errorf("fetch catalog: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	fetchedAt := s.now().UTC().Format(time.RFC3339)
	if resp.StatusCode == http.StatusNotModified {
		return nil, etag, fetchedAt, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", "", fmt.Errorf("fetch catalog: %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxCatalogBytes+1))
	if err != nil {
		return nil, "", "", fmt.Errorf("fetch catalog: %w", err)
	}
	if len(body) > maxCatalogBytes {
		return nil, "", "", errors.New("fetch catalog: response too large")
	}
	cat, err := Parse(body)
	if err != nil {
		return nil, "", "", err
	}
	return cat, resp.Header.Get("ETag"), fetchedAt, nil
}

func (s *Source) readCache() (cached, error) {
	var c cached
	data, err := os.ReadFile(s.CachePath)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("read catalog cache: %w", err)
	}
	return c, nil
}

func (s *Source) writeCache(c cached) error {
	if s.CachePath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.CachePath), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.CachePath + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.CachePath)
}
