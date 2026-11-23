package auth

// Persistence for login sessions: <dataDir>/auth/sessions.json.
//
// Without it every restart of the server (or of `suwu upgrade`) signs every
// device out, which is half the annoyance the session model exists to remove.
// The file holds the secret hashes and the signing keys — never a usable token —
// and is written 0600 through a temp file and a rename, so a crash cannot leave
// half a registry behind.

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// StoreSchema is the file format this build writes.
const StoreSchema = 1

// StoreFile is the registry's path inside a data directory.
func StoreFile(dataDir string) string { return filepath.Join(dataDir, "auth", "sessions.json") }

type storedSession struct {
	ID         string `json:"id"`
	SecretHash string `json:"secretHash"`
	SigningKey string `json:"signingKey"`
	Created    string `json:"created"`
	LastSeen   string `json:"lastSeen"`
	Expires    string `json:"expires"`
	HardStop   string `json:"hardStop"`
	Label      string `json:"label"`
}

type storeFile struct {
	Schema int `json:"schema"`
	// PasswordHash records which password the sessions were issued under: if the
	// server's password has changed, they are all void.
	PasswordHash string          `json:"passwordHash,omitempty"`
	Sessions     []storedSession `json:"sessions"`
}

// LoadSessions reads the registry. A missing file is not an error; an unreadable
// or malformed one is reported and ignored, so a corrupt file cannot lock the
// user out of their own server (they log in again and it is rewritten).
func LoadSessions(dataDir, passwordHash string, now time.Time) ([]*Session, error) {
	path := StoreFile(dataDir)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var file storeFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if file.Schema != StoreSchema {
		return nil, fmt.Errorf("%s: schema %d is not supported", path, file.Schema)
	}
	// A different password voids every session: "change the password" must mean
	// "sign every device out", or it means nothing.
	if file.PasswordHash != passwordHash && len(file.Sessions) > 0 {
		return nil, nil
	}
	out := make([]*Session, 0, len(file.Sessions))
	for _, s := range file.Sessions {
		if s.ID == "" {
			continue
		}
		hash, err := hex.DecodeString(s.SecretHash)
		if err != nil || len(hash) != 32 {
			continue
		}
		key, err := hex.DecodeString(s.SigningKey)
		if err != nil || len(key) == 0 {
			continue
		}
		session := &Session{
			ID:         s.ID,
			SigningKey: key,
			Created:    parseTime(s.Created),
			LastSeen:   parseTime(s.LastSeen),
			Expires:    parseTime(s.Expires),
			HardStop:   parseTime(s.HardStop),
			Label:      s.Label,
		}
		copy(session.SecretHash[:], hash)
		if session.Expired(now) {
			continue
		}
		out = append(out, session)
	}
	return out, nil
}

// SaveSessions writes the registry atomically.
func SaveSessions(dataDir, passwordHash string, sessions []*Session) error {
	path := StoreFile(dataDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	file := storeFile{Schema: StoreSchema, PasswordHash: passwordHash, Sessions: make([]storedSession, 0, len(sessions))}
	for _, s := range sessions {
		file.Sessions = append(file.Sessions, storedSession{
			ID:         s.ID,
			SecretHash: hex.EncodeToString(s.SecretHash[:]),
			SigningKey: hex.EncodeToString(s.SigningKey),
			Created:    s.Created.UTC().Format(time.RFC3339),
			LastSeen:   s.LastSeen.UTC().Format(time.RFC3339),
			Expires:    s.Expires.UTC().Format(time.RFC3339),
			HardStop:   s.HardStop.UTC().Format(time.RFC3339),
			Label:      s.Label,
		})
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(name, 0o600); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func parseTime(value string) time.Time {
	t, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}
	}
	return t
}

// Restore fills the registry from a loaded file without firing the persistence
// hook (that would rewrite the file on every start).
func (r *Registry) Restore(sessions []*Session) {
	r.mu.Lock()
	for _, s := range sessions {
		if len(r.sessions) >= MaxSessions {
			break
		}
		r.sessions[s.ID] = s
	}
	r.mu.Unlock()
}

// Snapshot copies the sessions for persistence.
func (r *Registry) Snapshot() []*Session {
	return r.List()
}
