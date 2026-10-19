// Package motionbgs adapts motionbgs.com to the lives2d provider registry.
//
// Search is interesting here: the site's own /search endpoint 302-redirects to
// a tag page (e.g. q=car -> /tag:car/), so the adapter follows the redirect and
// remembers the tag URL per query to paginate. A wallpaper's detail page links
// both a 4K and an HD mp4 download; 4K is preferred.
package motionbgs

import (
	"context"
	"errors"
	"fmt"
	stdhtml "html"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"suwu/pkg/lives2d"
)

const (
	// siteHost is the only host search/resolve may fetch from.
	siteHost = "motionbgs.com"
	// userAgent is a plain desktop browser so the site returns its full page.
	userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	// maxPage caps pagination so a client cannot walk the whole catalogue.
	maxPage = 50
	// maxSearchBytes caps one search/detail page read.
	maxSearchBytes = 4 << 20 // 4 MiB
	// thumbPrefix is the 364x205 card thumbnail path, used to recognise cards.
	thumbPrefix = "/i/c/364x205/media/"
)

// fetchTimeout bounds one upstream page fetch.
const fetchTimeout = 20 * time.Second

var httpClient = &http.Client{Timeout: fetchTimeout}

// init registers the adapter. Importing this package is enough to make the
// "motionbgs" provider available.
func init() {
	lives2d.Register(adapter{})
}

type adapter struct{}

// ID implements lives2d.Provider.
func (adapter) ID() string { return "motionbgs" }

// Label implements lives2d.Provider.
func (adapter) Label() string { return "MotionBGs" }

// Credit implements lives2d.Provider.
func (adapter) Credit() lives2d.Credit {
	return lives2d.Credit{Author: "MotionBGs", URL: "https://motionbgs.com/"}
}

// ImageOrigins implements lives2d.Provider; card thumbnails load from the site.
func (adapter) ImageOrigins() []string {
	return []string{"https://motionbgs.com", "https://*.motionbgs.com"}
}

var (
	// cardRe matches one result card: the <a ...> opening tag (group 1), the
	// 364x205 thumbnail path (group 2), the title (group 3) and the optional
	// resolution badge (group 4).
	cardRe = regexp.MustCompile(`(?s)<a\s+([^>]*?)>\s*<figure>\s*<picture>.*?<img[^>]*\bsrc="?(` +
		thumbPrefix + `[^"\s>]+)"?.*?</picture>\s*</figure>\s*<span class=ttl>\s*(.*?)\s*</span>(?:\s*<span class=frm>\s*(.*?)\s*</span>)?`)
	hrefAttrRe = regexp.MustCompile(`href="?([^"\s>]+)`)
	nextRe     = regexp.MustCompile(`(?i)<link[^>]*\brel=["']?next`)
	dl4kRe     = regexp.MustCompile(`href="?/dl/4k/(\d+)`)
	dlHdRe     = regexp.MustCompile(`href="?/dl/hd/(\d+)`)
	ogTitleRe  = regexp.MustCompile(`property=og:title\s+content="([^"]*)"`)
	ogTitleAlt = regexp.MustCompile(`content="([^"]*)"\s+property=og:title`)
)

// tagBaseCache remembers the tag page a query resolved to, so paging past the
// first page does not re-run the search redirect. Keyed by lowercased query.
var tagBaseCache sync.Map

// Search implements lives2d.Provider.
func (adapter) Search(ctx context.Context, query string, page int) (lives2d.SearchPage, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return lives2d.SearchPage{Page: page}, errors.New("search query is required")
	}
	if page < 1 {
		page = 1
	}
	if page > maxPage {
		return lives2d.SearchPage{Page: page}, fmt.Errorf("page must be at most %d", maxPage)
	}

	if page == 1 {
		base, body, err := fetchSearchPage(ctx, query)
		if err != nil {
			return lives2d.SearchPage{Page: page}, err
		}
		if base != "" {
			tagBaseCache.Store(cacheKey(query), base)
		}
		items, hasMore := parseSearch(body)
		return lives2d.SearchPage{Items: items, Page: page, HasMore: hasMore}, nil
	}

	base, ok := cachedBase(query)
	if !ok {
		resolved, _, err := fetchSearchPage(ctx, query)
		if err != nil {
			return lives2d.SearchPage{Page: page}, err
		}
		if resolved != "" {
			tagBaseCache.Store(cacheKey(query), resolved)
		}
		base = resolved
	}
	if base == "" {
		return lives2d.SearchPage{Items: []lives2d.Item{}, Page: page, HasMore: false}, nil
	}

	body, err := fetch(ctx, base+strconv.Itoa(page)+"/")
	if err != nil {
		return lives2d.SearchPage{Page: page}, err
	}
	items, hasMore := parseSearch(body)
	return lives2d.SearchPage{Items: items, Page: page, HasMore: hasMore}, nil
}

// Resolve implements lives2d.Provider.
func (adapter) Resolve(ctx context.Context, id string) (lives2d.Media, error) {
	pageURL, err := validatePageURL(id)
	if err != nil {
		return lives2d.Media{}, err
	}
	body, err := fetch(ctx, pageURL)
	if err != nil {
		return lives2d.Media{}, err
	}

	// Prefer the 4K mp4; fall back to HD for wallpapers that only ship one.
	var downloadURL string
	if m := dl4kRe.FindStringSubmatch(body); m != nil {
		downloadURL = "https://" + siteHost + "/dl/4k/" + m[1]
	} else if m := dlHdRe.FindStringSubmatch(body); m != nil {
		downloadURL = "https://" + siteHost + "/dl/hd/" + m[1]
	} else {
		return lives2d.Media{}, errors.New("this wallpaper has no download link")
	}

	title := ogTitle(body)
	if title == "" {
		title = slugOf(pageURL)
	}
	return lives2d.Media{
		URL:         downloadURL,
		Filename:    title + ".mp4",
		ContentType: "video/mp4",
	}, nil
}

// fetchSearchPage runs the site search and returns the tag page it redirects
// to (empty when the result is the search page itself) plus its HTML.
func fetchSearchPage(ctx context.Context, query string) (base, body string, err error) {
	body, finalURL, err := fetchWithURL(ctx, "https://"+siteHost+"/search?q="+url.QueryEscape(query))
	if err != nil {
		return "", "", err
	}
	return tagBase(finalURL), body, nil
}

// tagBase normalises a final search URL into the tag page to paginate from, or
// "" when the search did not resolve to a tag page.
func tagBase(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || !strings.HasPrefix(u.Path, "/tag:") {
		return ""
	}
	if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

// parseSearch extracts cards from a tag/search page and reports whether a next
// page link is present.
func parseSearch(page string) ([]lives2d.Item, bool) {
	items := make([]lives2d.Item, 0, 24)
	for _, m := range cardRe.FindAllStringSubmatch(page, -1) {
		href := hrefAttrRe.FindStringSubmatch(m[1])
		if href == nil {
			continue
		}
		pageURL := absoluteURL(href[1])
		item := lives2d.Item{
			ID:           pageURL,
			Title:        strings.TrimSpace(stdhtml.UnescapeString(m[3])),
			PageURL:      pageURL,
			ThumbnailURL: "https://" + siteHost + m[2],
			Resolution:   strings.TrimSpace(stdhtml.UnescapeString(m[4])),
		}
		if item.Title == "" {
			item.Title = slugOf(pageURL)
		}
		items = append(items, item)
	}
	return items, nextRe.MatchString(page)
}

// ogTitle reads the OpenGraph title, tolerating either attribute order.
func ogTitle(page string) string {
	if m := ogTitleRe.FindStringSubmatch(page); m != nil {
		return strings.TrimSpace(stdhtml.UnescapeString(m[1]))
	}
	if m := ogTitleAlt.FindStringSubmatch(page); m != nil {
		return strings.TrimSpace(stdhtml.UnescapeString(m[1]))
	}
	return ""
}

// absoluteURL makes a href root-relative to the site.
func absoluteURL(href string) string {
	if strings.HasPrefix(href, "http://") || strings.HasPrefix(href, "https://") {
		return href
	}
	return "https://" + siteHost + "/" + strings.TrimPrefix(href, "/")
}

// validatePageURL accepts only an https page on the site and returns it.
func validatePageURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return "", errors.New("invalid wallpaper url")
	}
	if u.Hostname() != siteHost {
		return "", errors.New("wallpaper url must be a motionbgs.com page")
	}
	return u.String(), nil
}

// fetch GETs an allow-listed page and returns its body.
func fetch(ctx context.Context, url string) (string, error) {
	body, _, err := fetchWithURL(ctx, url)
	return body, err
}

// fetchWithURL GETs a page and returns its body and the URL after redirects.
func fetchWithURL(ctx context.Context, rawURL string) (body, finalURL string, err error) {
	reqCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("motionbgs responded with HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSearchBytes))
	if err != nil {
		return "", "", err
	}
	finalURL = rawURL
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}
	return string(data), finalURL, nil
}

// slugOf returns the last path segment of a URL, used as a fallback title.
func slugOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "wallpaper"
	}
	slug := path.Base(strings.TrimSuffix(u.Path, "/"))
	if slug == "" || slug == "." || slug == "/" {
		return "wallpaper"
	}
	return slug
}

func cacheKey(query string) string { return strings.ToLower(query) }

func cachedBase(query string) (string, bool) {
	v, ok := tagBaseCache.Load(cacheKey(query))
	if !ok {
		return "", false
	}
	return v.(string), true
}
