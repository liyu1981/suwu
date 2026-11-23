package auth

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

func newTestRegistry(now time.Time) *Registry {
	r := NewRegistry()
	r.SetClock(fixedClock(now))
	return r
}

func TestSessionTokenFormatAndValidation(t *testing.T) {
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	reg := newTestRegistry(now)
	session, token, err := NewSession("test device", now)
	if err != nil {
		t.Fatal(err)
	}
	reg.Add(session)

	if !strings.HasPrefix(token, TokenPrefix) {
		t.Fatalf("token %q has no prefix", token)
	}
	id, secret, ok := ParseToken(token)
	if !ok || id != session.ID || secret == "" {
		t.Fatalf("parse %q -> %q %q %v", token, id, secret, ok)
	}
	// The registry validates the token and slides the expiry.
	got, ok := reg.Validate(token)
	if !ok || got.ID != session.ID {
		t.Fatalf("validate: %+v %v", got, ok)
	}
	if !got.Expires.After(now) {
		t.Fatal("expiry did not slide")
	}
	// A wrong secret with the right id is the same answer as an unknown id.
	if _, ok := reg.Validate(TokenPrefix + session.ID + ".notthesecret"); ok {
		t.Fatal("a wrong secret validated")
	}
	if _, ok := reg.Validate("garbage"); ok {
		t.Fatal("garbage validated")
	}
	if _, ok := reg.Validate(TokenPrefix + "unknownid.secret"); ok {
		t.Fatal("an unknown id validated")
	}
}

func TestSessionsExpireAndDoNotValidate(t *testing.T) {
	start := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	reg := newTestRegistry(start)
	session, token, err := NewSession("old phone", start)
	if err != nil {
		t.Fatal(err)
	}
	reg.Add(session)

	// Past the idle window: dropped on first use.
	reg.SetClock(func() time.Time { return start.Add(SessionIdleTTL + time.Minute) })
	if _, ok := reg.Validate(token); ok {
		t.Fatal("an idle session still validated")
	}
	if reg.Count() != 0 {
		t.Fatalf("expired session not dropped: %d", reg.Count())
	}

	// The hard stop caps a session that is used constantly. Use it every hour, so
	// the idle window never closes and only the absolute stop can end it.
	reg2 := newTestRegistry(start)
	s2, token2, _ := NewSession("busy phone", start)
	reg2.Add(s2)
	for i := 1; i <= int(SessionHardTTL.Hours()); i++ {
		moment := start.Add(time.Duration(i) * time.Hour)
		reg2.SetClock(fixedClock(moment))
		reg2.Validate(token2)
	}
	reg2.SetClock(fixedClock(start.Add(SessionHardTTL + 2*time.Hour)))
	if _, ok := reg2.Validate(token2); ok {
		t.Fatal("a session outlived the hard stop")
	}
}

func TestRotateRevokeAndCap(t *testing.T) {
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	reg := newTestRegistry(now)
	desktop, desktopToken, _ := NewSession("desktop", now)
	phone, phoneToken, _ := NewSession("phone", now)
	reg.Add(desktop)
	reg.Add(phone)

	// Rotating one leaves the other working.
	newToken, err := reg.Rotate(desktop.ID)
	if err != nil {
		t.Fatal(err)
	}
	if newToken == desktopToken {
		t.Fatal("rotate returned the same token")
	}
	if _, ok := reg.Validate(desktopToken); ok {
		t.Fatal("the rotated-away token still works")
	}
	if _, ok := reg.Validate(newToken); !ok {
		t.Fatal("the new token does not work")
	}
	if _, ok := reg.Validate(phoneToken); !ok {
		t.Fatal("rotating the desktop broke the phone")
	}

	// Revoking one leaves the other.
	if !reg.Revoke(phone.ID) {
		t.Fatal("revoke reported nothing")
	}
	if _, ok := reg.Validate(phoneToken); ok {
		t.Fatal("a revoked session still works")
	}
	if _, ok := reg.Validate(newToken); !ok {
		t.Fatal("revoking the phone broke the desktop")
	}

	// The cap evicts the least recently used.
	reg2 := newTestRegistry(now)
	var tokens []string
	for i := 0; i < MaxSessions; i++ {
		s, token, _ := NewSession("device", now.Add(time.Duration(i)*time.Minute))
		reg2.Add(s)
		tokens = append(tokens, token)
	}
	extra, extraToken, _ := NewSession("one too many", now.Add(2*time.Hour))
	reg2.Add(extra)
	if reg2.Count() != MaxSessions {
		t.Fatalf("cap not enforced: %d", reg2.Count())
	}
	if _, ok := reg2.Validate(tokens[0]); ok {
		t.Fatal("the least recently used session survived the cap")
	}
	if _, ok := reg2.Validate(extraToken); !ok {
		t.Fatal("the newest session was evicted")
	}
}

func TestRevokeAllExcept(t *testing.T) {
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	reg := newTestRegistry(now)
	keep, keepToken, _ := NewSession("keep", now)
	for i := 0; i < 3; i++ {
		s, _, _ := NewSession("other", now)
		reg.Add(s)
	}
	reg.Add(keep)
	if n := reg.RevokeAllExcept(keep.ID); n != 3 {
		t.Fatalf("revoked %d, want 3", n)
	}
	if _, ok := reg.Validate(keepToken); !ok {
		t.Fatal("the kept session was revoked")
	}
	if reg.Count() != 1 {
		t.Fatalf("count %d", reg.Count())
	}
}

func TestLegacyTokenBecomesASession(t *testing.T) {
	now := time.Now()
	cfg := &Config{
		Token:        "legacy-token-value",
		TokenExpiry:  now.Add(TokenTTL),
		SigningKey:   GenerateSigningKey("legacy-token-value"),
		Sessions:     newTestRegistry(now),
		PasswordHash: HashPassword("secret"),
	}
	// The old token still works, marked legacy so a renewal can replace it.
	session, ok := cfg.SessionFor("legacy-token-value")
	if !ok || !session.Legacy {
		t.Fatalf("legacy token: %+v %v", session, ok)
	}
	// An expired legacy token does not.
	cfg.TokenExpiry = now.Add(-time.Hour)
	if _, ok := cfg.SessionFor("legacy-token-value"); ok {
		t.Fatal("an expired legacy token validated")
	}
	// A legacy token is not in the registry: it must never be revocable by id.
	if _, ok := cfg.Sessions.Get("legacy"); ok {
		t.Fatal("the legacy token leaked into the registry")
	}
}

func TestAuthorizeTokenRequest(t *testing.T) {
	now := time.Now()
	reg := newTestRegistry(now)
	session, token, _ := NewSession("phone", now)
	reg.Add(session)
	cfg := &Config{
		Token:        "legacy",
		TokenExpiry:  now.Add(TokenTTL),
		SigningKey:   GenerateSigningKey("legacy"),
		Sessions:     reg,
		PasswordHash: HashPassword("secret"),
		AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
	}
	host := "127.0.0.1:8181"

	// A live session renews.
	d, grant := AuthorizeTokenRequest(cfg, host, "", "Bearer "+token)
	if !d.OK || grant.Session == nil || grant.Session.ID != session.ID || grant.Token != token {
		t.Fatalf("session grant: %+v %+v", d, grant)
	}
	// The password mints instead.
	d, grant = AuthorizeTokenRequest(cfg, host, "", "Basic "+basicHeader("user", "secret"))
	if !d.OK || !grant.Password || grant.Session != nil {
		t.Fatalf("password grant: %+v %+v", d, grant)
	}
	// A wrong password and a dead token are both 401.
	if d, _ := AuthorizeTokenRequest(cfg, host, "", "Basic "+basicHeader("user", "wrong")); d.OK {
		t.Fatal("a wrong password was accepted")
	}
	if d, _ := AuthorizeTokenRequest(cfg, host, "", "Bearer garbage"); d.OK {
		t.Fatal("a garbage token was accepted")
	}
	// A bearer token takes precedence over a password: a device renews with what
	// it has, and never needs to send the password again.
	d, grant = AuthorizeTokenRequest(cfg, host, "", "Bearer "+token)
	if !d.OK || grant.Password {
		t.Fatalf("bearer precedence: %+v", grant)
	}
}

// basicHeader builds "Basic <base64(user:pass)>".
func basicHeader(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}

// An active client is never kicked out: every authenticated request slides the
// idle window, so a session can outlive SessionIdleTTL (and its own creation
// time by far) as long as it is used. This is the behaviour the client relies on
// instead of a renewal timer.
func TestActiveSessionOutlivesTheIdleWindow(t *testing.T) {
	start := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	reg := newTestRegistry(start)
	session, token, _ := NewSession("open laptop", start)
	reg.Add(session)

	// Visit every 20 hours: each visit is inside the window, and the session is
	// still alive well past one idle window.
	moment := start
	for i := 0; i < 10; i++ {
		moment = moment.Add(20 * time.Hour)
		reg.SetClock(fixedClock(moment))
		if _, ok := reg.Validate(token); !ok {
			t.Fatalf("an active session expired after %v", moment.Sub(start))
		}
	}
	if moment.Sub(start) <= SessionIdleTTL {
		t.Fatalf("the test did not outlive the idle window (%v)", moment.Sub(start))
	}
	// The expiry stored on the session is relative to the last visit, not to
	// creation.
	got, _ := reg.Get(session.ID)
	if !got.Expires.After(moment) {
		t.Fatalf("expiry did not slide: expires %v, visited %v", got.Expires, moment)
	}
	// And a day of silence ends it.
	reg.SetClock(fixedClock(moment.Add(SessionIdleTTL + time.Minute)))
	if _, ok := reg.Validate(token); ok {
		t.Fatal("a session idle past the window still validated")
	}
}
