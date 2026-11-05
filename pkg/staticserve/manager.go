// Package staticserve keeps an in-memory registry of folders exposed by the
// running Suwu server at /staticserve/<id>/. The registry is intentionally not
// persisted: restarting the server forgets every entry.
package staticserve

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// RoutePrefix is the public mount point for every static serve.
const RoutePrefix = "/staticserve/"

// Status values returned by the management API and CLI.
const (
	StatusRunning = "running"
	StatusPaused  = "paused"
)

// Entry is one served folder.
type Entry struct {
	ID        string
	Dir       string
	CreatedAt time.Time

	rootMu sync.RWMutex
	root   *os.Root
	paused atomic.Bool
}

// Prefix returns the entry's public URL prefix, including the trailing slash.
func (e *Entry) Prefix() string { return RoutePrefix + e.ID + "/" }

// Paused reports whether the entry currently rejects requests.
func (e *Entry) Paused() bool { return e.paused.Load() }

// SetPaused switches the entry between running and paused.
func (e *Entry) SetPaused(paused bool) { e.paused.Store(paused) }

// Status returns the wire representation of the entry.
func (e *Entry) Status() Status {
	status := StatusRunning
	if e.Paused() {
		status = StatusPaused
	}
	return Status{
		ID:        e.ID,
		Dir:       e.Dir,
		Prefix:    e.Prefix(),
		Status:    status,
		CreatedAt: e.CreatedAt.UTC().Format(time.RFC3339),
	}
}

// Status is one row of the management API.
type Status struct {
	ID        string `json:"id"`
	Dir       string `json:"dir"`
	Prefix    string `json:"prefix"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}

// Manager owns the in-memory registry. All methods are safe for concurrent use.
type Manager struct {
	mu      sync.Mutex
	entries map[string]*Entry
	order   []string
}

// NewManager creates an empty registry.
func NewManager() *Manager {
	return &Manager{entries: make(map[string]*Entry)}
}

// Create registers dir. When the same absolute directory is already registered
// and forceNew is false, the existing entry is returned with created=false.
// A different directory that happens to share the basename receives a numeric
// suffix (myweb1, myweb2, ...).
func (m *Manager) Create(dir string, forceNew bool) (*Entry, bool, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, false, errors.New("directory is required")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, false, fmt.Errorf("resolve directory: %w", err)
	}
	abs = filepath.Clean(abs)

	info, err := os.Stat(abs)
	if err != nil {
		return nil, false, fmt.Errorf("stat %s: %w", abs, err)
	}
	if !info.IsDir() {
		return nil, false, fmt.Errorf("%s is not a directory", abs)
	}

	m.mu.Lock()
	if !forceNew {
		for _, e := range m.entries {
			if e.Dir == abs {
				m.mu.Unlock()
				return e, false, nil
			}
		}
	}

	root, err := os.OpenRoot(abs)
	if err != nil {
		m.mu.Unlock()
		return nil, false, fmt.Errorf("open %s: %w", abs, err)
	}

	id := m.nextIDLocked(slugBase(abs))
	e := &Entry{
		ID:        id,
		Dir:       abs,
		CreatedAt: time.Now(),
		root:      root,
	}
	m.entries[id] = e
	m.order = append(m.order, id)
	m.mu.Unlock()
	return e, true, nil
}

// List returns every entry in creation order.
func (m *Manager) List() []Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Status, 0, len(m.order))
	for _, id := range m.order {
		if e, ok := m.entries[id]; ok {
			out = append(out, e.Status())
		}
	}
	return out
}

// Get resolves an entry by id.
func (m *Manager) Get(id string) (*Entry, error) {
	m.mu.Lock()
	e, ok := m.entries[id]
	m.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("static serve %s not found", id)
	}
	return e, nil
}

// Pause stops serving an entry without forgetting its directory.
func (m *Manager) Pause(id string) (*Entry, error) {
	e, err := m.Get(id)
	if err != nil {
		return nil, err
	}
	e.SetPaused(true)
	return e, nil
}

// Resume starts serving a paused entry again.
func (m *Manager) Resume(id string) (*Entry, error) {
	e, err := m.Get(id)
	if err != nil {
		return nil, err
	}
	e.SetPaused(false)
	return e, nil
}

// Remove forgets an entry and closes its directory handle.
func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	e, ok := m.entries[id]
	if ok {
		delete(m.entries, id)
		for i, candidate := range m.order {
			if candidate == id {
				m.order = append(m.order[:i], m.order[i+1:]...)
				break
			}
		}
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("static serve %s not found", id)
	}
	return e.Close()
}

// CloseAll closes every open directory handle. The registry is left empty.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	entries := make([]*Entry, 0, len(m.entries))
	for _, e := range m.entries {
		entries = append(entries, e)
	}
	m.entries = make(map[string]*Entry)
	m.order = nil
	m.mu.Unlock()
	for _, e := range entries {
		_ = e.Close()
	}
}

// Root returns the current directory handle, or nil after Remove.
func (e *Entry) Root() *os.Root {
	e.rootMu.RLock()
	defer e.rootMu.RUnlock()
	return e.root
}

// Close releases the entry's directory handle.
func (e *Entry) Close() error {
	e.rootMu.Lock()
	root := e.root
	e.root = nil
	e.rootMu.Unlock()
	if root == nil {
		return nil
	}
	return root.Close()
}

func (m *Manager) nextIDLocked(base string) string {
	if _, exists := m.entries[base]; !exists {
		return base
	}
	for i := 1; ; i++ {
		id := fmt.Sprintf("%s%d", base, i)
		if _, exists := m.entries[id]; !exists {
			return id
		}
	}
}

// slugBase derives a URL-safe id from the last path element. Non-ASCII and
// punctuation become dashes so the id never needs escaping in a URL.
func slugBase(dir string) string {
	base := filepath.Base(filepath.Clean(dir))
	if base == "." || base == string(filepath.Separator) || base == "/" {
		base = "root"
	}

	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(base) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	id := strings.Trim(b.String(), "-.")
	if id == "" {
		id = "static"
	}
	if len(id) > 48 {
		id = strings.TrimRight(id[:48], "-.")
		if id == "" {
			id = "static"
		}
	}
	return id
}
