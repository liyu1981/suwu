package moewalls

import "testing"

const searchFixture = `
<nav class="pagination loop-pagination">
  <span aria-current="page" class="page-numbers current">1</span>
  <a class="page-numbers" href="https://moewalls.com/page/2/?s=naruto">2</a>
  <a class="next page-numbers" href="https://moewalls.com/page/2/?s=naruto">Next &rarr;</a>
</nav>
<article class="entry-tpl-grid post-20572 resolutions-1920x1080">
  <div class="entry-featured-media"><a class="g1-frame" href="https://moewalls.com/anime/naruto-blue-sky-live-wallpaper/"><div class="g1-frame-inner">
    <img width="364" height="205" src="https://moewalls.com/wp-content/uploads/2026/06/naruto-blue-sky-thumb-364x205.jpg" class="attachment-bimber-grid-standard wp-post-image" alt="" />
  </div></a></div>
  <div class="entry-resolutions"><a href="https://moewalls.com/resolution/1920x1080/">1920x1080</a></div>
  <h3 class="g1-gamma entry-title"><a href="https://moewalls.com/anime/naruto-blue-sky-live-wallpaper/" rel="bookmark">Naruto Blue Sky Live Wallpaper</a></h3>
</article>
<article class="entry-tpl-grid post-20297 resolutions-3840x2160">
  <div class="entry-featured-media"><a class="g1-frame" href="https://moewalls.com/anime/dark-naruto-live-wallpaper/"><div class="g1-frame-inner">
    <img width="364" height="205" src="https://moewalls.com/wp-content/uploads/2026/05/dark-naruto-thumb-364x205.jpg" class="wp-post-image" alt="" />
  </div></a></div>
  <h3 class="g1-gamma entry-title"><a href="https://moewalls.com/anime/dark-naruto-live-wallpaper/" rel="bookmark">Dark Naruto &amp; Friends</a></h3>
</article>
`

const detailFixture = `
<meta property="og:title" content="Naruto Blue Sky Live Wallpaper - MoeWalls" />
<a id="moe-download" data-id ="20572" data-url="mQ27pytrzbezI1sPd7piCrAW6Sd0WQH7R8cZzuChLp1UoI4TsCe1tAkjuHo%3D" rel="nofollow" class="g1-button" href="#">
`

func TestParseSearch(t *testing.T) {
	items, hasMore := parseSearch(searchFixture)
	if !hasMore {
		t.Fatal("expected a next-page link")
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	first := items[0]
	if first.Title != "Naruto Blue Sky Live Wallpaper" {
		t.Errorf("title = %q", first.Title)
	}
	if first.ID != "https://moewalls.com/anime/naruto-blue-sky-live-wallpaper/" {
		t.Errorf("id = %q", first.ID)
	}
	if first.Resolution != "1920x1080" {
		t.Errorf("resolution = %q", first.Resolution)
	}
	if first.ThumbnailURL != "https://moewalls.com/wp-content/uploads/2026/06/naruto-blue-sky-thumb-364x205.jpg" {
		t.Errorf("thumbnail = %q", first.ThumbnailURL)
	}
	if items[1].Title != "Dark Naruto & Friends" {
		t.Errorf("entity not unescaped: %q", items[1].Title)
	}
	if items[1].Resolution != "3840x2160" {
		t.Errorf("second resolution = %q", items[1].Resolution)
	}
}

func TestParseSearchNoNextPage(t *testing.T) {
	_, hasMore := parseSearch(`<article></article>`)
	if hasMore {
		t.Error("did not expect a next-page link")
	}
}

func TestParseDetail(t *testing.T) {
	token, title, err := parseDetail(detailFixture)
	if err != nil {
		t.Fatal(err)
	}
	if token != "mQ27pytrzbezI1sPd7piCrAW6Sd0WQH7R8cZzuChLp1UoI4TsCe1tAkjuHo%3D" {
		t.Errorf("token = %q", token)
	}
	if title != "Naruto Blue Sky Live Wallpaper" {
		t.Errorf("title = %q", title)
	}
}

func TestParseDetailMissing(t *testing.T) {
	if _, _, err := parseDetail("<html></html>"); err == nil {
		t.Fatal("expected an error for a page with no download link")
	}
}

func TestSearchURL(t *testing.T) {
	if got := searchURL("sci fi", 1); got != "https://moewalls.com/?s=sci+fi" {
		t.Errorf("page 1 = %q", got)
	}
	if got := searchURL("naruto", 3); got != "https://moewalls.com/page/3/?s=naruto" {
		t.Errorf("page 3 = %q", got)
	}
}

func TestValidatePageURL(t *testing.T) {
	if _, err := validatePageURL("https://moewalls.com/anime/x/"); err != nil {
		t.Errorf("valid url rejected: %v", err)
	}
	for _, bad := range []string{
		"http://moewalls.com/anime/x/",
		"https://evil.example.com/anime/x/",
		"https://moewalls.com.evil.example/x/",
		"not a url",
	} {
		if _, err := validatePageURL(bad); err == nil {
			t.Errorf("expected %q to be rejected", bad)
		}
	}
}

func TestSlugOf(t *testing.T) {
	if got := slugOf("https://moewalls.com/anime/naruto-blue-sky-live-wallpaper/"); got != "naruto-blue-sky-live-wallpaper" {
		t.Errorf("slug = %q", got)
	}
}
