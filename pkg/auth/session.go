package auth

// Login sessions: one credential per device, not one per server.
//
// The server used to hold a single token, rotated every five minutes. Two
// devices shared it, so whoever renewed logged the other out — the desktop/mobile
// ping-pong (docs/AUTH_SESSIONS_PLAN.md). A session is the unit of trust now:
// each device gets its own, with its own expiry, signing key, label and revoke.
//
// A token is `suwu1.<sid>.<secret>`. The id is a map key; only the SHA-256 of the
// secret is kept, so the registry can never be replayed as a credential. The
// signing key is derived from the whole token, the same derivation HMAC request
// signatures and extension tokens already used.

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// TokenPrefix marks a session token. A token without it is the single
	// per-run token from before sessions existed, still honoured as one.
	TokenPrefix = "suwu1."

	// SessionIdleTTL is how long a session survives without being used. It slides
	// on every authenticated request, so an active device never reaches it (see
	// the comment on renew), and an abandoned one stops working within a day.
	SessionIdleTTL = 24 * time.Hour
	// SessionHardTTL is the absolute lifetime of a session, used or not: a device
	// signs in again monthly even if it is in constant use.
	SessionHardTTL = 30 * 24 * time.Hour
	// MaxSessions caps the registry; the least recently used is evicted, so a
	// script holding the password cannot grow it without bound.
	MaxSessions = 32
	// SessionSecretBytes is the entropy behind one token.
	SessionSecretBytes = 32
	// sessionIDBytes gives a 12-character id.
	sessionIDBytes = 9
)

// BasicKey is the rate-limit key for a request authenticated with the password
// (only /api/token accepts that). It is not a session id.
const BasicKey = "basic"

// Errors a caller can tell apart.
var (
	ErrNoSession  = errors.New("no such session")
	ErrSessionOld = errors.New("session expired")
)

// Session is one device's credential.
type Session struct {
	// ID is public: it appears in the token and in the session list.
	ID string `json:"id"`
	// SecretHash is SHA-256 of the secret half. The secret itself is never
	// stored, so a copy of the registry is not a credential.
	SecretHash [32]byte `json:"-"`
	// SigningKey authenticates HMAC-signed requests and derives extension
	// tokens; it rotates with the secret.
	SigningKey []byte    `json:"-"`
	Created    time.Time `json:"created"`
	LastSeen   time.Time `json:"lastSeen"`
	Expires    time.Time `json:"expires"`
	HardStop   time.Time `json:"-"`
	Label      string    `json:"label"`
	// Legacy marks the token minted at startup before sessions existed. It is
	// valid until the old expiry, and the first renewal turns it into a session.
	Legacy bool `json:"legacy,omitempty"`
}

// Expired reports whether the session may no longer be used.
func (s *Session) Expired(now time.Time) bool {
	if s == nil {
		return true
	}
	if !s.HardStop.IsZero() && !now.Before(s.HardStop) {
		return true
	}
	if !s.Expires.IsZero() && !now.Before(s.Expires) {
		return true
	}
	return false
}

// NewSession mints a session and its token. label is computed from the request
// (a client-supplied label is untrusted input).
func NewSession(label string, now time.Time) (*Session, string, error) {
	idBytes := make([]byte, sessionIDBytes)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, "", err
	}
	secretBytes := make([]byte, SessionSecretBytes)
	if _, err := rand.Read(secretBytes); err != nil {
		return nil, "", err
	}
	id := base64.RawURLEncoding.EncodeToString(idBytes)
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	token := TokenPrefix + id + "." + secret
	s := &Session{
		ID:         id,
		SecretHash: sha256.Sum256([]byte(secret)),
		SigningKey: GenerateSigningKey(token),
		Created:    now,
		LastSeen:   now,
		Expires:    now.Add(SessionIdleTTL),
		HardStop:   now.Add(SessionHardTTL),
		Label:      label,
	}
	return s, token, nil
}

// ParseToken splits a session token into its id and secret. ok is false for a
// token that is not in the session format (the legacy per-run token, garbage).
func ParseToken(token string) (id, secret string, ok bool) {
	if !strings.HasPrefix(token, TokenPrefix) {
		return "", "", false
	}
	rest := token[len(TokenPrefix):]
	for i := 0; i < len(rest); i++ {
		if rest[i] != '.' {
			continue
		}
		id, secret = rest[:i], rest[i+1:]
		if id == "" || secret == "" {
			return "", "", false
		}
		return id, secret, true
	}
	return "", "", false
}

// matchesSecret reports whether secret is this session's secret.
func (s *Session) matchesSecret(secret string) bool {
	got := sha256.Sum256([]byte(secret))
	return subtle.ConstantTimeCompare(got[:], s.SecretHash[:]) == 1
}

// rotate gives the session a new secret and signing key, returning the new
// token. The id — and therefore the session's place in the registry — stays.
func (s *Session) rotate(now time.Time) (string, error) {
	secretBytes := make([]byte, SessionSecretBytes)
	if _, err := rand.Read(secretBytes); err != nil {
		return "", err
	}
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	token := TokenPrefix + s.ID + "." + secret
	s.SecretHash = sha256.Sum256([]byte(secret))
	s.SigningKey = GenerateSigningKey(token)
	s.LastSeen = now
	return token, nil
}

// renew slides the idle expiry, never past the hard stop.
//
// This is what "an active client is never kicked out" means concretely: every
// authenticated request pushes the window out again, so a browser that is being
// used stays signed in indefinitely, while one that is not touched for a day
// expires. The client needs no timer for this — the server moves the window.
func (s *Session) renew(now time.Time) {
	s.LastSeen = now
	expires := now.Add(SessionIdleTTL)
	if !s.HardStop.IsZero() && expires.After(s.HardStop) {
		expires = s.HardStop
	}
	s.Expires = expires
}

// Registry holds the live sessions. It is safe for concurrent use: every request
// touches it.
type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	now      func() time.Time
	// onChange is called after a mutation, so the server can persist. Set once at
	// startup.
	onChange func()
}

// NewRegistry returns an empty registry using the wall clock.
func NewRegistry() *Registry {
	return &Registry{sessions: make(map[string]*Session), now: time.Now}
}

// SetClock replaces the clock (tests).
func (r *Registry) SetClock(now func() time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.now = now
}

// OnChange registers the persistence hook.
func (r *Registry) OnChange(fn func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onChange = fn
}

func (r *Registry) changed() {
	r.mu.RLock()
	fn := r.onChange
	r.mu.RUnlock()
	if fn != nil {
		fn()
	}
}

// Add registers a session, evicting the least recently used when the cap is hit.
func (r *Registry) Add(s *Session) {
	r.mu.Lock()
	if len(r.sessions) >= MaxSessions {
		r.evictLocked()
	}
	r.sessions[s.ID] = s
	r.mu.Unlock()
	r.changed()
}

// evictLocked drops the least recently used session. The caller holds the lock.
func (r *Registry) evictLocked() {
	var oldest *Session
	for _, s := range r.sessions {
		if oldest == nil || s.LastSeen.Before(oldest.LastSeen) {
			oldest = s
		}
	}
	if oldest != nil {
		delete(r.sessions, oldest.ID)
	}
}

// Get returns a session by id.
func (r *Registry) Get(id string) (*Session, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.sessions[id]
	return s, ok
}

// List returns the sessions, most recently used first.
func (r *Registry) List() []*Session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Session, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out
}

// Count is the number of sessions.
func (r *Registry) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.sessions)
}

// Validate resolves a token to a live session and slides its expiry.
//
// Unknown ids and wrong secrets are the same answer (a caller must not learn
// which ids exist); an expired session is dropped as it is found.
func (r *Registry) Validate(token string) (*Session, bool) {
	id, secret, ok := ParseToken(token)
	if !ok {
		return nil, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[id]
	if !ok || !s.matchesSecret(secret) {
		return nil, false
	}
	now := r.now()
	if s.Expired(now) {
		delete(r.sessions, id)
		go r.changed()
		return nil, false
	}
	s.renew(now)
	// The expiry moved, so the stored copy is stale; the caller persists on its
	// own schedule rather than on every request.
	return s, true
}

// Rotate gives a session a new secret and returns the new token.
func (r *Registry) Rotate(id string) (string, error) {
	r.mu.Lock()
	s, ok := r.sessions[id]
	if !ok {
		r.mu.Unlock()
		return "", ErrNoSession
	}
	token, err := s.rotate(r.now())
	r.mu.Unlock()
	if err != nil {
		return "", err
	}
	r.changed()
	return token, nil
}

// Revoke removes one session.
func (r *Registry) Revoke(id string) bool {
	r.mu.Lock()
	_, ok := r.sessions[id]
	delete(r.sessions, id)
	r.mu.Unlock()
	if ok {
		r.changed()
	}
	return ok
}

// RevokeAllExcept removes every session but keep. It returns how many went.
func (r *Registry) RevokeAllExcept(keep string) int {
	r.mu.Lock()
	n := 0
	for id := range r.sessions {
		if id == keep {
			continue
		}
		delete(r.sessions, id)
		n++
	}
	r.mu.Unlock()
	if n > 0 {
		r.changed()
	}
	return n
}

// String is for logs: never print a secret.
func (s *Session) String() string {
	return fmt.Sprintf("session %s (%s)", s.ID, s.Label)
}
