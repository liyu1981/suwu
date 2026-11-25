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
	// masterRef is the ref the catalog is read at by default: the maintained
	// raw GitHub copy, independent of the running build's version.
	masterRef = "master"
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
	// Stale means the refresh failed and this is the cached (or embedded) copy.
	Stale bool `json:"stale"`
	// Error says why the refresh failed, verbatim, so the page can show a
	// network problem and a catalog this build cannot read as the different
	// things they are.
	Error string `json:"error,omitempty"`
	// FallbackFrom is set when an overridden ref has no catalog and master
	// answered instead. The default ref is master, so this is uncommon.
	FallbackFrom string `json:"fallbackFrom,omitempty"`
	// Cached means no request was needed (the cache was fresh).
	Cached bool `json:"cached"`
}

// NewSource returns the runtime source for a data dir. The catalog is always
// read at master on GitHub's raw host, so a build is never stuck with a copy
// from a tag cut before tools/catalog.json existed; `SUWU_TOOLS_REF` overrides
// the ref for development.
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

// defaultRef is the ref the catalog is read at. It is always master rather
// than this build's tag: a release tag cut before tools/catalog.json existed
// would 404 forever, and the catalog is maintained in master without a release.
// `SUWU_TOOLS_REF` can override it for development.
func defaultRef() string {
	if ref := strings.TrimSpace(os.Getenv(RefEnv)); ref != "" {
		return ref
	}
	return masterRef
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
	if errors.Is(err, ErrNotFound) && s.Ref != masterRef {
		// An overridden ref has no catalog (e.g. a tag cut before the catalog
		// existed). master is the maintained copy; the answer records the ref.
		fallback := *s
		fallback.Ref = masterRef
		cat, origin, ferr := fallback.Load(ctx)
		if ferr == nil {
			origin.FallbackFrom = s.Ref
			return cat, origin, nil
		}
	}
	if err != nil {
		// Offline, rate-limited or the ref is gone: an installed tool list beats
		// an empty page, as long as the caller can say it is stale — and can say
		// which ref the copy it is looking at came from.
		if cacheErr == nil {
			stale := cache.Catalog
			origin.FetchedAt = cache.FetchedAt
			origin.Ref = cache.Ref
			origin.Stale = true
			origin.Error = err.Error()
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

// ErrNotFound means this ref has no tools/catalog.json. It is separate from a
// network failure because the answer differs: a tag cut before the catalog
// existed should read master, a broken connection should not.
var ErrNotFound = errors.New("catalog not present at this ref")

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
	if resp.StatusCode == http.StatusNotFound {
		return nil, "", "", fmt.Errorf("fetch catalog: %s at %s: %w", resp.Status, s.Ref, ErrNotFound)
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
