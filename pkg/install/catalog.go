package install

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"suwu/pkg/background"
	"suwu/pkg/extension"
)

// Catalog defaults. The source is first-party: the examples that ship in the
// Suwu repository, installed from a directory rather than a whole-repo
// tarball, because the tarball also carries the website's demo videos.
const (
	// DefaultRepo is the first-party repository the catalog is read from.
	DefaultRepo = "liyu1981/suwu"
	// DefaultRef is the branch releases are cut from.
	DefaultRef = "master"
	// catalogCacheTTL is how long a cached tree is reused.
	catalogCacheTTL = 6 * time.Hour
	// maxTreeBytes bounds the tree listing response.
	maxTreeBytes = 4 << 20 // 4 MiB
	// maxDownloadBytes bounds one file download.
	maxDownloadBytes = MaxFileBytes
	// downloadTimeout bounds the whole item download.
	downloadTimeout = 2 * time.Minute
)

// Client fetches the catalog and its files from GitHub.
type Client struct {
	// HTTP is the transport; nil means http.DefaultClient.
	HTTP *http.Client
	// Token is sent as Authorization when set. It is never logged or printed.
	Token string
	// Repo and Ref select the source.
	Repo string
	Ref  string
	// BaseURL overrides the GitHub host, for tests.
	BaseURL string
	// RawBaseURL overrides the raw host, for tests.
	RawBaseURL string
}

// NewClient returns a client for repo/ref with sensible defaults applied.
func NewClient(repo, ref, token string) *Client {
	c := &Client{Repo: repo, Ref: ref, Token: token}
	if c.Repo == "" {
		c.Repo = DefaultRepo
	}
	if c.Ref == "" {
		c.Ref = DefaultRef
	}
	c.BaseURL = "https://api.github.com"
	c.RawBaseURL = "https://raw.githubusercontent.com"
	c.HTTP = &http.Client{Timeout: downloadTimeout}
	return c
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: downloadTimeout}
}

func (c *Client) base() string {
	if c.BaseURL == "" {
		return "https://api.github.com"
	}
	return c.BaseURL
}

func (c *Client) raw() string {
	if c.RawBaseURL == "" {
		return "https://raw.githubusercontent.com"
	}
	return c.RawBaseURL
}

// Source describes where a catalog came from, for printing.
func (c *Client) Source() string { return c.Repo + "@" + c.Ref }

// get performs an authenticated GET and returns the body, bounded by limit.
func (c *Client) get(ctx context.Context, rawURL string, limit int64, header http.Header) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "suwu-install")
	req.Header.Set("Accept", "application/vnd.github+json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	for k, vs := range header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", rawURL, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit+1))
}

// treeResponse is the subset of GitHub's tree API we read.
type treeResponse struct {
	Sha       string `json:"sha"`
	Truncated bool   `json:"truncated"`
	Tree      []struct {
		Path string `json:"path"`
		Type string `json:"type"` // "blob" | "tree" | "commit"
		Size int64  `json:"size"`
	} `json:"tree"`
}

// tree fetches the recursive file listing for the ref.
func (c *Client) tree(ctx context.Context) (*treeResponse, error) {
	if err := c.validSource(); err != nil {
		return nil, err
	}
	// owner/repo and the ref are interpolated literally (GitHub's API wants the
	// unescaped slash), so they are shape-validated instead.
	endpoint := fmt.Sprintf("%s/repos/%s/git/trees/%s?recursive=1", c.base(), c.Repo, c.Ref)
	body, err := c.get(ctx, endpoint, maxTreeBytes, nil)
	if err != nil {
		return nil, err
	}
	var out treeResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("parse tree response: %w", err)
	}
	if out.Truncated {
		return nil, errors.New("the repository tree is too large to enumerate; install from a zip instead")
	}
	return &out, nil
}

// CatalogEntry is one installable item in the catalog.
type CatalogEntry struct {
	Kind Kind
	ID   string
	// Name and Description come from the item's own manifest, so the picker
	// shows what the tile will show.
	Name        string
	Description string
	// Files is the payload, as repository paths, in the order they are fetched.
	Files []CatalogFile
	// Installed is filled in by the caller (the catalog does not know the
	// data dir).
	Installed bool
}

// CatalogFile is one file of a catalog entry.
type CatalogFile struct {
	// Path is relative to the item root, e.g. "public/style.css".
	Path string
	// RepoPath is the full path in the repository, used to download.
	RepoPath string
	Size     int64
}

// Catalog is the set of installable items for a ref.
type Catalog struct {
	Repo    string
	Ref     string
	Entries []CatalogEntry
}

// Find returns the entry for a kind and id.
func (c *Catalog) Find(kind Kind, id string) (CatalogEntry, bool) {
	for _, e := range c.Entries {
		if e.Kind == kind && e.ID == id {
			return e, true
		}
	}
	return CatalogEntry{}, false
}

// OfKind returns the entries of one kind, in id order.
func (c *Catalog) OfKind(kind Kind) []CatalogEntry {
	var out []CatalogEntry
	for _, e := range c.Entries {
		if e.Kind == kind {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// itemRoots maps a kind to the repository prefixes that hold installable items.
// These mirror the archive layout, so an item installed from the catalog and
// the same item installed from a zip land in the same place.
func itemRoots(kind Kind) []string {
	switch kind {
	case KindBackground:
		return []string{path.Join("examples", background.DirName)}
	default:
		return []string{path.Join("examples", extension.DirName)}
	}
}

// LoadCatalog enumerates installable items for the client's ref.
//
// A tree path is remote input, so it goes through cleanRel before it is used
// to build a destination: a listing that contained "../" or an absolute path
// is dropped, not fetched.
func (c *Client) LoadCatalog(ctx context.Context, cacheDir string, refresh bool) (*Catalog, error) {
	if cacheDir != "" {
		if cached, err := readCatalogCache(filepath.Join(cacheDir, "github-catalog.json")); err == nil && !refresh {
			if time.Since(cached.FetchedAt) < catalogCacheTTL && cached.Repo == c.Repo && cached.Ref == c.Ref {
				return &Catalog{Repo: cached.Repo, Ref: cached.Ref, Entries: cached.Entries}, nil
			}
		}
	}

	t, err := c.tree(ctx)
	if err != nil {
		// A cached catalog is better than no picker when the network is down —
		// but an explicit refresh asked for fresh data, so it reports the
		// failure instead of silently serving a stale list.
		if !refresh {
			if cached, cerr := readCatalogCache(filepath.Join(cacheDir, "github-catalog.json")); cerr == nil && cached.Repo == c.Repo && cached.Ref == c.Ref {
				return &Catalog{Repo: cached.Repo, Ref: cached.Ref, Entries: cached.Entries}, nil
			}
		}
		return nil, err
	}

	cat := &Catalog{Repo: c.Repo, Ref: c.Ref}
	for _, kind := range Kinds() {
		cat.Entries = append(cat.Entries, c.collect(kind, t.Tree)...)
	}
	sort.Slice(cat.Entries, func(i, j int) bool {
		if cat.Entries[i].Kind != cat.Entries[j].Kind {
			return cat.Entries[i].Kind < cat.Entries[j].Kind
		}
		return cat.Entries[i].ID < cat.Entries[j].ID
	})

	// Manifests are best-effort: a failed fetch leaves the bare id, and the
	// install path validates the real files anyway.
	c.enrich(ctx, cat)

	if cacheDir != "" {
		_ = writeCatalogCache(filepath.Join(cacheDir, "github-catalog.json"), cat)
	}
	return cat, nil
}

// collect groups the blobs under a kind's example roots into entries.
func (c *Client) collect(kind Kind, tree []struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}) []CatalogEntry {
	byID := map[string]*CatalogEntry{}
	order := []string{}

	for _, node := range tree {
		if node.Type != "blob" {
			continue
		}
		clean, err := cleanRel(node.Path)
		if err != nil {
			continue // a hostile or malformed path is dropped, not fetched
		}
		for _, root := range itemRoots(kind) {
			segs := strings.Split(clean, "/")
			rootSegs := strings.Split(root, "/")
			if len(segs) < len(rootSegs)+2 || !equalSegs(segs[:len(rootSegs)], rootSegs) {
				continue
			}
			id := segs[len(rootSegs)]
			if !kind.ValidID(id) {
				continue
			}
			e, ok := byID[id]
			if !ok {
				e = &CatalogEntry{Kind: kind, ID: id}
				byID[id] = e
				order = append(order, id)
			}
			e.Files = append(e.Files, CatalogFile{
				Path:     path.Join(segs[len(rootSegs)+1:]...),
				RepoPath: clean,
				Size:     node.Size,
			})
			break
		}
	}

	out := make([]CatalogEntry, 0, len(order))
	for _, id := range order {
		e := byID[id]
		sort.Slice(e.Files, func(i, j int) bool { return e.Files[i].Path < e.Files[j].Path })
		out = append(out, *e)
	}
	return out
}

// manifestPath is the metadata file that gives an entry its display name.
func manifestPath(kind Kind) string {
	if kind == KindBackground {
		return background.ManifestFile
	}
	return extension.PackageFile
}

// enrich fills in each entry's name and description from its manifest. A
// failure is not fatal: the entry keeps its id and still installs.
func (c *Client) enrich(ctx context.Context, cat *Catalog) {
	for i := range cat.Entries {
		e := &cat.Entries[i]
		raw, err := c.fetchRepoFile(ctx, e.Files, manifestPath(e.Kind))
		if err != nil {
			continue
		}
		if e.Kind == KindBackground {
			var m struct {
				Label string `json:"label"`
			}
			if json.Unmarshal(raw, &m) == nil {
				e.Name = m.Label
			}
			continue
		}
		var m struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if json.Unmarshal(raw, &m) == nil {
			e.Name, e.Description = m.Name, m.Description
		}
	}
}

// fetchRepoFile reads one file of an entry, by its manifest filename.
func (c *Client) fetchRepoFile(ctx context.Context, files []CatalogFile, name string) ([]byte, error) {
	for _, f := range files {
		if f.Path == name {
			body, err := c.get(ctx, c.rawURL(f.RepoPath), maxDownloadBytes, nil)
			if err != nil {
				return nil, err
			}
			return body, nil
		}
	}
	return nil, fmt.Errorf("no %s in the repository listing", name)
}

// rawURL builds the raw download URL for a repository path. The path is joined
// under the fixed repo/ref prefix, so a listing entry cannot redirect the
// request to another host.
func (c *Client) rawURL(repoPath string) string {
	return fmt.Sprintf("%s/%s/%s/%s", c.raw(), c.Repo, c.Ref, repoPath)
}

// repoRe and refRe bound the two values that are interpolated into a URL
// unescaped. Anything else is refused rather than escaped, because GitHub's API
// expects the literal owner/repo form.
var (
	repoRe = regexp.MustCompile(`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`)
	refRe  = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
)

// validSource checks the repo and ref shapes before either is used in a URL.
func (c *Client) validSource() error {
	if !repoRe.MatchString(c.Repo) {
		return fmt.Errorf("invalid repository %q (want owner/name)", c.Repo)
	}
	if !refRe.MatchString(c.Ref) || strings.Contains(c.Ref, "..") {
		return fmt.Errorf("invalid ref %q", c.Ref)
	}
	return nil
}

// InstallCatalogEntry downloads one catalog entry and installs it through the
// same stage, validation and commit as an archive.
func (c *Client) InstallCatalogEntry(ctx context.Context, entry CatalogEntry, opt Options) (Item, error) {
	stage, err := NewStage(opt.DataDir, entry.Kind, entry.ID)
	if err != nil {
		return Item{Kind: entry.Kind, ID: entry.ID}, err
	}
	defer func() { _ = stage.Discard() }()

	for _, f := range entry.Files {
		// Defence in depth: the listing was filtered, but a destination is
		// only ever built from a re-validated relative path.
		if _, err := cleanRel(f.Path); err != nil {
			return Item{Kind: entry.Kind, ID: entry.ID}, fmt.Errorf("%s: %w", f.RepoPath, err)
		}
		body, err := c.get(ctx, c.rawURL(f.RepoPath), maxDownloadBytes, nil)
		if err != nil {
			return Item{Kind: entry.Kind, ID: entry.ID}, fmt.Errorf("download %s: %w", f.RepoPath, err)
		}
		if _, err := stage.WriteBytes(f.Path, body); err != nil {
			return Item{Kind: entry.Kind, ID: entry.ID}, fmt.Errorf("%s: %w", f.RepoPath, err)
		}
	}
	return stage.Commit(opt)
}

// ── catalog cache ─────────────────────────────────────────────────────

// catalogCache is the on-disk form of a catalog: enough to render the picker
// without a network round trip.
type catalogCache struct {
	Repo      string         `json:"repo"`
	Ref       string         `json:"ref"`
	FetchedAt time.Time      `json:"fetchedAt"`
	Entries   []CatalogEntry `json:"entries"`
}

func readCatalogCache(path string) (*catalogCache, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out catalogCache
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func writeCatalogCache(path string, cat *Catalog) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(catalogCache{
		Repo: cat.Repo, Ref: cat.Ref, FetchedAt: time.Now(), Entries: cat.Entries,
	}, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
