// Package moewalls adapts moewalls.com to the lives2d provider registry.
//
// It is the reference adapter: search parses the WordPress search loop, and
// resolve reads the download token out of a wallpaper page and turns it into
// the go.moewalls.com download URL. Both parsers are pure functions over the
// page HTML so they can be regression-tested without the network.
package moewalls

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
	"strings"
	"time"

	"suwu/pkg/lives2d"
)

const (
	// siteHost is the only host search/resolve may fetch from.
	siteHost = "moewalls.com"
	// downloadHost serves the resolved media.
	downloadHost = "go.moewalls.com"
	// userAgent is a plain desktop browser so the site returns its full page.
	userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	// maxPage caps pagination so a client cannot walk the whole catalogue.
	maxPage = 50
	// maxSearchBytes caps one search/detail page read.
	maxSearchBytes = 4 << 20 // 4 MiB
)

// fetchTimeout bounds one upstream page fetch.
const fetchTimeout = 20 * time.Second

var httpClient = &http.Client{Timeout: fetchTimeout}

// init registers the adapter. Importing this package is enough to make the
// "moewalls" provider available.
func init() {
	lives2d.Register(adapter{})
}

type adapter struct{}

// ID implements lives2d.Provider.
func (adapter) ID() string { return "moewalls" }

// Label implements lives2d.Provider.
func (adapter) Label() string { return "MoeWalls" }

// Credit implements lives2d.Provider.
func (adapter) Credit() lives2d.Credit {
	return lives2d.Credit{Author: "MoeWalls", URL: "https://moewalls.com/"}
}

// ImageOrigins implements lives2d.Provider; thumbnails load from the site
// directly, so the app shell's CSP has to allow it.
func (adapter) ImageOrigins() []string {
	return []string{"https://moewalls.com", "https://*.moewalls.com"}
}

var (
	articleRe = regexp.MustCompile(`(?s)<article\b.*?</article>`)
	titleRe   = regexp.MustCompile(`(?s)<h3[^>]*class="[^"]*\bentry-title\b[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	resRe     = regexp.MustCompile(`resolutions-([0-9]+x[0-9]+)`)
	imgTagRe  = regexp.MustCompile(`(?s)<img[^>]*\bwp-post-image\b[^>]*>`)
	imgSrcRe  = regexp.MustCompile(`\bsrc="([^"]+)"`)
	nextRe    = regexp.MustCompile(`(?s)<a[^>]*class="[^"]*\bnext\b[^"]*page-numbers[^"]*"`)

	downloadAnchorRe = regexp.MustCompile(`(?s)<a[^>]*\bid\s*=\s*"moe-download"[^>]*>`)
	dataURLRe        = regexp.MustCompile(`\bdata-url\s*=\s*"([^"]+)"`)
	ogTitleRe        = regexp.MustCompile(`(?s)<meta[^>]*property\s*=\s*"og:title"[^>]*>`)
	metaContentRe    = regexp.MustCompile(`\bcontent\s*=\s*"([^"]*)"`)
	titleTagRe       = regexp.MustCompile(`(?s)<title[^>]*>(.*?)</title>`)
)

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

	pageURL := searchURL(query, page)
	body, err := fetch(ctx, pageURL)
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
	token, title, err := parseDetail(body)
	if err != nil {
		return lives2d.Media{}, err
	}
	if title == "" {
		title = slugOf(pageURL)
	}
	return lives2d.Media{
		URL:         "https://" + downloadHost + "/download.php?video=" + token,
		Filename:    title + ".mp4",
		ContentType: "video/mp4",
	}, nil
}

// searchURL builds the WordPress search URL for a page (1-based).
func searchURL(query string, page int) string {
	base := "https://" + siteHost + "/"
	if page > 1 {
		base = fmt.Sprintf("https://%s/page/%d/", siteHost, page)
	}
	return base + "?s=" + url.QueryEscape(query)
}

// validatePageURL accepts only an https page on the site and returns it.
func validatePageURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return "", errors.New("invalid wallpaper url")
	}
	if u.Hostname() != siteHost {
		return "", errors.New("wallpaper url must be a moewalls.com page")
	}
	return u.String(), nil
}

// fetch GETs an allow-listed page and returns its body.
func fetch(ctx context.Context, url string) (string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("moewalls responded with HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSearchBytes))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// parseSearch extracts the result cards from a search page and reports whether
// another page follows.
func parseSearch(page string) ([]lives2d.Item, bool) {
	items := make([]lives2d.Item, 0, 16)
	for _, block := range articleRe.FindAllString(page, -1) {
		title := titleRe.FindStringSubmatch(block)
		if title == nil {
			continue
		}
		pageURL := title[1]
		name := strings.TrimSpace(stdhtml.UnescapeString(stripTags(title[2])))
		item := lives2d.Item{
			ID:      pageURL,
			Title:   name,
			PageURL: pageURL,
		}
		if m := resRe.FindStringSubmatch(block); m != nil {
			item.Resolution = m[1]
		}
		if tag := imgTagRe.FindString(block); tag != "" {
			if src := imgSrcRe.FindStringSubmatch(tag); src != nil {
				item.ThumbnailURL = stdhtml.UnescapeString(src[1])
			}
		}
		if item.Title == "" {
			item.Title = slugOf(pageURL)
		}
		items = append(items, item)
	}
	return items, nextRe.MatchString(page)
}

// parseDetail pulls the download token and title out of a wallpaper page.
func parseDetail(page string) (token, title string, err error) {
	anchor := downloadAnchorRe.FindString(page)
	if anchor == "" {
		return "", "", errors.New("this wallpaper has no download link")
	}
	match := dataURLRe.FindStringSubmatch(anchor)
	if match == nil || match[1] == "" {
		return "", "", errors.New("this wallpaper has no download token")
	}
	token = stdhtml.UnescapeString(match[1])

	if meta := ogTitleRe.FindString(page); meta != "" {
		if content := metaContentRe.FindStringSubmatch(meta); content != nil {
			title = cleanTitle(stdhtml.UnescapeString(content[1]))
		}
	}
	if title == "" {
		if tag := titleTagRe.FindStringSubmatch(page); tag != nil {
			title = cleanTitle(stdhtml.UnescapeString(stripTags(tag[1])))
		}
	}
	return token, title, nil
}

// cleanTitle strips the site suffix ("… - MoeWalls") from a page title.
func cleanTitle(title string) string {
	title = strings.TrimSpace(title)
	for _, suffix := range []string{" - MoeWalls", " | MoeWalls"} {
		title = strings.TrimSuffix(title, suffix)
	}
	return strings.TrimSpace(title)
}

// stripTags removes any markup left inside an extracted text node.
func stripTags(s string) string {
	var b strings.Builder
	depth := 0
	for _, r := range s {
		switch {
		case r == '<':
			depth++
		case r == '>':
			if depth > 0 {
				depth--
			}
		case depth == 0:
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
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
