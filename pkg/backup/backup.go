// Package backup stores the client's encrypted settings backups as opaque
// blobs: an append-only chain of numbered generations per backup slot, with a
// small plaintext index.
//
// The server never holds a key and never parses plaintext. It checks that a
// payload carries the expected container prologue (so garbage cannot consume
// the quota), records sizes and ciphertext digests, and hands bytes back
// unchanged. Everything else is the client's business.
package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

// Quota limits for one slot. They bound what a single authenticated session
// can leave on the server's disk.
const (
	// MaxGenerations is how many backups are retained per slot; the oldest
	// generation is pruned past this.
	MaxGenerations = 10
	// MaxSlotBytes is the total ciphertext a slot may occupy.
	MaxSlotBytes = 64 << 20
	// MaxUploadBytes is the largest single generation accepted.
	MaxUploadBytes = 16 << 20
)

// slotRe matches a slot id: 26 Crockford base32 characters (lowercase), i.e.
// 130 bits. Slots are opaque server-side; the client treats the id as a
// recovery code.
var slotRe = regexp.MustCompile(`^[a-z2-7]{26}$`)

// Container prologue, written by the browser's `container.ts`. The server
// matches it so an upload that is not a backup container is refused instead of
// filling the quota.
const (
	Magic         = "SUWUBK1"
	prologueBytes = len(Magic) + 4 // magic + uint32 big-endian header length
)

// MaxHeaderBytes caps the JSON header the server will even look at.
const MaxHeaderBytes = 64 << 10

// Generation is one stored backup.
type Generation struct {
	Gen    int64  `json:"gen"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	MTime  string `json:"mtime"`
}

// Meta is the plaintext index of one slot. It describes ciphertext only —
// no setting value, no key, no passphrase material ever reaches it.
type Meta struct {
	Slot        string       `json:"slot"`
	Generations []Generation `json:"generations"`
	Bytes       int64        `json:"bytes"`
}

// Latest returns the highest-numbered generation, or false when the slot is
// empty.
func (m *Meta) Latest() (Generation, bool) {
	if m == nil || len(m.Generations) == 0 {
		return Generation{}, false
	}
	return m.Generations[len(m.Generations)-1], true
}

// ErrConflict reports that the slot moved on since the caller's base
// generation: another device wrote, so this write must not silently win.
var ErrConflict = errors.New("backup: slot has a newer generation")

// ErrNotFound reports an unknown slot or generation.
var ErrNotFound = errors.New("backup: not found")

// ErrTooLarge reports an upload above MaxUploadBytes.
var ErrTooLarge = errors.New("backup: upload too large")

// ErrNotContainer reports a payload that is not a backup container.
var ErrNotContainer = errors.New("backup: not a backup container")

// ValidSlot reports whether id is a well-formed slot id.
func ValidSlot(id string) bool { return slotRe.MatchString(id) }

// Store manages backup slots under a data directory.
//
// It holds no plaintext and no decrypted state: everything it keeps is the
// opaque blob and its index, so a restart, an upgrade, or a `suwu upgrade`
// between the client and the server is a non-event.
type Store struct {
	root string
	// mu serializes slot mutations. Different slots could proceed in
	// parallel, but the autosave loop is one browser and the critical section
	// is a handful of small file operations.
	mu sync.Mutex
}

// Dir resolves the backup root under dataRoot, creating it if needed.
func Dir(dataRoot string) (string, error) {
	dir := filepath.Join(dataRoot, "backup")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create backup dir: %w", err)
	}
	return dir, nil
}

// New opens a store rooted at dataRoot.
func New(dataRoot string) (*Store, error) {
	dir, err := Dir(dataRoot)
	if err != nil {
		return nil, err
	}
	return &Store{root: dir}, nil
}

// slotDir returns the directory for a validated slot id.
func (s *Store) slotDir(slot string) (string, error) {
	if !ValidSlot(slot) {
		return "", fmt.Errorf("backup: invalid slot id")
	}
	return filepath.Join(s.root, slot), nil
}

// genPath returns the blob path for a validated generation number.
func (s *Store) genPath(slot string, gen int64) (string, error) {
	dir, err := s.slotDir(slot)
	if err != nil {
		return "", err
	}
	if gen <= 0 {
		return "", fmt.Errorf("backup: invalid generation")
	}
	return filepath.Join(dir, fmt.Sprintf("g%08d.bin", gen)), nil
}

// metaPath returns the index path for a validated slot id.
func (s *Store) metaPath(slot string) (string, error) {
	dir, err := s.slotDir(slot)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "meta.json"), nil
}

// Meta reads a slot's index. A slot that was never written reports
// ErrNotFound, which is how the client tells "no backup yet" from "server
// broken".
func (s *Store) Meta(slot string) (*Meta, error) {
	if _, err := s.slotDir(slot); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readMetaLocked(slot)
}

func (s *Store) readMetaLocked(slot string) (*Meta, error) {
	path, _ := s.metaPath(slot)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("backup: read meta: %w", err)
	}
	meta := &Meta{}
	if err := json.Unmarshal(data, meta); err != nil {
		return nil, fmt.Errorf("backup: parse meta: %w", err)
	}
	if meta.Slot != slot {
		// A slot directory whose index names another slot is not something we
		// wrote; treat it as absent rather than mixing two clients' indexes.
		return nil, ErrNotFound
	}
	sort.Slice(meta.Generations, func(i, j int) bool {
		return meta.Generations[i].Gen < meta.Generations[j].Gen
	})
	meta.Bytes = totalBytes(meta.Generations)
	return meta, nil
}

func totalBytes(gens []Generation) int64 {
	var total int64
	for _, g := range gens {
		total += g.Size
	}
	return total
}

// Put stores one generation.
//
// base, when non-nil, is the generation the client believed was current; if the
// slot has moved on, Put returns ErrConflict and writes nothing. That single
// check is what keeps a second browser from silently overwriting a newer
// backup.
func (s *Store) Put(slot string, base *int64, r io.Reader) (*Meta, error) {
	dir, err := s.slotDir(slot)
	if err != nil {
		return nil, err
	}

	// Read the whole generation into memory, bounded: uploads are capped at
	// MaxUploadBytes and this is a settings backup, not a file transfer.
	buf, err := readCapped(r, MaxUploadBytes)
	if err != nil {
		return nil, err
	}
	if err := checkContainer(buf); err != nil {
		return nil, err
	}
	digest := sha256.Sum256(buf)

	s.mu.Lock()
	defer s.mu.Unlock()

	// The data dir is created here rather than in Dir so a slot directory
	// inherits 0700 and not the process umask.
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("backup: create slot dir: %w", err)
	}

	meta, err := s.readMetaLocked(slot)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	if meta == nil {
		meta = &Meta{Slot: slot}
	}

	if base != nil {
		current := int64(0)
		if latest, ok := meta.Latest(); ok {
			current = latest.Gen
		}
		if current != *base {
			return nil, ErrConflict
		}
	}

	var prev int64
	if latest, ok := meta.Latest(); ok {
		prev = latest.Gen
	}
	gen := prev + 1

	dest, err := s.genPath(slot, gen)
	if err != nil {
		return nil, err
	}
	if err := writeAtomic(dest, buf); err != nil {
		return nil, err
	}

	meta.Generations = append(meta.Generations, Generation{
		Gen:    gen,
		Size:   int64(len(buf)),
		SHA256: hex.EncodeToString(digest[:]),
		MTime:  time.Now().UTC().Format(time.RFC3339),
	})
	kept, dropped := prune(meta.Generations)
	meta.Generations = kept
	meta.Bytes = totalBytes(meta.Generations)

	metaPath, _ := s.metaPath(slot)
	index, err := json.Marshal(meta)
	if err != nil {
		return nil, fmt.Errorf("backup: encode meta: %w", err)
	}
	if err := writeAtomic(metaPath, index); err != nil {
		return nil, err
	}

	// The index is the source of truth; only once it no longer references a
	// generation does its blob go, so a crash between the two leaves an
	// unreferenced file that a later write reclaims, never a missing backup.
	for _, g := range dropped {
		if path, err := s.genPath(slot, g.Gen); err == nil {
			if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				slog.Warn("backup: prune blob failed", "slot", slot, "gen", g.Gen, "error", err)
			}
		}
	}
	return meta, nil
}

// prune drops the oldest generations until the slot is inside both limits and
// returns the survivors plus the generations that fell out.
func prune(gens []Generation) (kept, dropped []Generation) {
	start := 0
	for len(gens)-start > MaxGenerations || (totalBytes(gens[start:]) > MaxSlotBytes && len(gens)-start > 1) {
		start++
	}
	return gens[start:], gens[:start]
}

// Read returns one generation's bytes exactly as they were stored.
func (s *Store) Read(slot string, gen int64) ([]byte, error) {
	path, err := s.genPath(slot, gen)
	if err != nil {
		return nil, err
	}
	// Refuse a symlinked blob: the data dir may be shared, and a link could
	// otherwise turn this into an arbitrary-file read.
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("backup: stat blob: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, ErrNotFound
	}
	return os.ReadFile(path)
}

// Delete removes a whole slot, index and blobs. Used by the client's
// "forget this backup" action.
func (s *Store) Delete(slot string) error {
	dir, err := s.slotDir(slot)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("backup: delete slot: %w", err)
	}
	return nil
}

// Summary describes one slot for `suwu upgrade` output and any other
// command-line surface: how many generations and how many bytes, with no
// content and no way to tell what is inside.
type Summary struct {
	Slot        string `json:"slot"`
	Generations int    `json:"generations"`
	Bytes       int64  `json:"bytes"`
	LatestMTime string `json:"latestMtime,omitempty"`
}

// Summarize lists every slot under the store root. Slots whose name is not a
// valid id are skipped: a stray directory in the data dir is not a backup.
func (s *Store) Summarize() ([]Summary, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("backup: read root: %w", err)
	}
	out := make([]Summary, 0, len(entries))
	for _, e := range entries {
		slot := e.Name()
		if !ValidSlot(slot) {
			continue
		}
		meta, err := s.Meta(slot)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			return nil, err
		}
		summary := Summary{Slot: slot, Generations: len(meta.Generations), Bytes: meta.Bytes}
		if latest, ok := meta.Latest(); ok {
			summary.LatestMTime = latest.MTime
		}
		out = append(out, summary)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	return out, nil
}

// readCapped reads at most limit bytes, reporting ErrTooLarge past it.
func readCapped(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, fmt.Errorf("backup: read upload: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, ErrTooLarge
	}
	return data, nil
}

// checkContainer verifies the prologue and header length only.
func checkContainer(data []byte) error {
	if len(data) < prologueBytes {
		return ErrNotContainer
	}
	if string(data[:len(Magic)]) != Magic {
		return ErrNotContainer
	}
	hdrLen := int(uint32(data[len(Magic)])<<24 | uint32(data[len(Magic)+1])<<16 |
		uint32(data[len(Magic)+2])<<8 | uint32(data[len(Magic)+3]))
	if hdrLen <= 0 || hdrLen > MaxHeaderBytes || prologueBytes+hdrLen > len(data) {
		return ErrNotContainer
	}
	return nil
}

// writeAtomic writes data to a temporary file in the target directory, fsyncs
// it, then renames it into place — so a reader never sees a half-written
// generation and a crash never leaves a truncated blob that looks complete.
func writeAtomic(dest string, data []byte) error {
	dir := filepath.Dir(dest)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("backup: create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("backup: write temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("backup: sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("backup: close temp: %w", err)
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return fmt.Errorf("backup: chmod temp: %w", err)
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return fmt.Errorf("backup: rename: %w", err)
	}
	return nil
}
