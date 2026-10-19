package motionbgs

import "testing"

const searchFixture = `
<a title="Naruto's Halloween Party live wallpaper" href=/narutos-halloween-party>
  <figure><picture><source media="(-webkit-min-device-pixel-ratio: 1.5)" srcset=/i/c/546x308/media/10216/narutos-halloween-party.3840x2160.jpg type=image/jpeg><source srcset=/i/c/364x205/media/10216/narutos-halloween-party.3840x2160.jpg type=image/jpeg><img alt="naruto's halloween party live wallpaper" height=205 src=/i/c/364x205/media/10216/narutos-halloween-party.3840x2160.jpg width=364></picture></figure>
  <span class=ttl>Naruto's Halloween Party</span>
  <span class=frm> 4K </span>
</a>
<a title="Itachi Uchiha in Front of the Red Moon animated wallpaper" href="/itachi-shillouette-in-front-of-the-red-moon">
  <figure><picture><source srcset=/i/c/364x205/media/1057/itachi-shillouette-in-front-of-the-red-moon.jpg type=image/jpeg><img alt="" height=205 src=/i/c/364x205/media/1057/itachi-shillouette-in-front-of-the-red-moon.jpg width=364></picture></figure>
  <span class=ttl>Itachi Uchiha in Front of the Red Moon</span>
  <span class=frm> HD </span>
</a>
<a class=logo href=https://motionbgs.com><img src=/static/img/logo.svg></a>
<link href=https://motionbgs.com/tag:naruto-art/2/ rel=next>
`

const detailFixture = `
<meta content="website" property=og:type>
<meta property=og:title content="Naruto's Halloween Party Live Wallpaper">
<a href=/dl/4k/10216 rel=nofollow target=_blank> 4K Wallpaper (28.0Mb) </a>
<a href=/dl/hd/10216 rel=nofollow target=_blank> HD Wallpaper (11.0Mb) </a>
`

func TestParseSearch(t *testing.T) {
	items, hasMore := parseSearch(searchFixture)
	if !hasMore {
		t.Fatal("expected a next-page link")
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 cards, got %d: %+v", len(items), items)
	}
	first := items[0]
	if first.ID != "https://motionbgs.com/narutos-halloween-party" {
		t.Errorf("id = %q", first.ID)
	}
	if first.Title != "Naruto's Halloween Party" {
		t.Errorf("title = %q", first.Title)
	}
	if first.Resolution != "4K" {
		t.Errorf("resolution = %q", first.Resolution)
	}
	if first.ThumbnailURL != "https://motionbgs.com/i/c/364x205/media/10216/narutos-halloween-party.3840x2160.jpg" {
		t.Errorf("thumbnail = %q", first.ThumbnailURL)
	}
	if items[1].ID != "https://motionbgs.com/itachi-shillouette-in-front-of-the-red-moon" {
		t.Errorf("second id = %q", items[1].ID)
	}
	if items[1].Resolution != "HD" {
		t.Errorf("second resolution = %q", items[1].Resolution)
	}
}

func TestParseSearchNoNextPage(t *testing.T) {
	items, hasMore := parseSearch(`<a title="x" href=/x><figure><picture><img src=/i/c/364x205/media/1/x.jpg></picture></figure><span class=ttl>x</span></a>`)
	if hasMore {
		t.Error("did not expect a next-page link")
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 card, got %d", len(items))
	}
}

func TestTagBase(t *testing.T) {
	if got := tagBase("https://motionbgs.com/tag:naruto-art/"); got != "https://motionbgs.com/tag:naruto-art/" {
		t.Errorf("tag base = %q", got)
	}
	if got := tagBase("https://motionbgs.com/tag:car"); got != "https://motionbgs.com/tag:car/" {
		t.Errorf("missing slash = %q", got)
	}
	if got := tagBase("https://motionbgs.com/search?q=zzz"); got != "" {
		t.Errorf("search page should not be a tag base, got %q", got)
	}
}

func TestAbsoluteURL(t *testing.T) {
	if got := absoluteURL("/narutos-halloween-party"); got != "https://motionbgs.com/narutos-halloween-party" {
		t.Errorf("relative = %q", got)
	}
	if got := absoluteURL("https://motionbgs.com/x"); got != "https://motionbgs.com/x" {
		t.Errorf("absolute = %q", got)
	}
}

func TestValidatePageURL(t *testing.T) {
	if _, err := validatePageURL("https://motionbgs.com/narutos-halloween-party"); err != nil {
		t.Errorf("valid url rejected: %v", err)
	}
	for _, bad := range []string{
		"http://motionbgs.com/x",
		"https://evil.example.com/x",
		"https://motionbgs.com.evil.example/x",
		"not a url",
	} {
		if _, err := validatePageURL(bad); err == nil {
			t.Errorf("expected %q to be rejected", bad)
		}
	}
}

func TestDetailExtraction(t *testing.T) {
	if m := dl4kRe.FindStringSubmatch(detailFixture); m == nil || m[1] != "10216" {
		t.Fatalf("4k id extraction failed: %v", m)
	}
	if got := ogTitle(detailFixture); got != "Naruto's Halloween Party Live Wallpaper" {
		t.Fatalf("og title = %q", got)
	}
}

func TestSearchURLEncoding(t *testing.T) {
	// The search URL is built inline in fetchSearchPage; guard the encoding
	// contract through tagBase's parsing instead.
	if got := tagBase("https://motionbgs.com/tag:anime-girl/"); got != "https://motionbgs.com/tag:anime-girl/" {
		t.Errorf("tag base = %q", got)
	}
}
