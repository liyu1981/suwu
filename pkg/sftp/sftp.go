// Package sftp manages SSH/SFTP connections made from the Suwu host to a
// remote machine, for the SFTP tile.
//
// Credentials are held in memory only (never persisted) and sessions are closed
// on idle. The client is created server-side; the browser only sends paths.
package sftp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// IdleTimeout closes sessions that have not been used for a while.
const IdleTimeout = 30 * time.Minute

// dialTimeout bounds the initial SSH handshake.
const dialTimeout = 20 * time.Second

// ConnectionParams is the client-provided connection request. Credentials are
// never persisted.
type ConnectionParams struct {
	Host string `json:"host"`
	Port int    `json:"port,omitempty"`
	User string `json:"user"`
	// Auth is "password" or "key".
	Auth       string `json:"auth"`
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"privateKey,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

// Entry is one directory listing row. It mirrors the file browser's shape so
// the frontend can share types.
type Entry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
	Mode    string `json:"mode"`
}

// Session is one live SSH/SFTP connection.
type Session struct {
	ID          string
	Host        string
	User        string
	HostKey     string
	ConnectedAt time.Time
	sshClient   *ssh.Client
	sftpClient  *sftp.Client
	mu          sync.Mutex // guards lastUsed
	lastUsed    time.Time
}

// Manager owns the live sessions.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	stopOnce sync.Once
	stopCh   chan struct{}
}

// NewManager creates a manager. Call StartCleanupLoop to enable idle cleanup.
func NewManager() *Manager {
	return &Manager{sessions: map[string]*Session{}, stopCh: make(chan struct{})}
}

// StartCleanupLoop closes idle sessions once a minute until ctx ends.
func (m *Manager) StartCleanupLoop(ctx context.Context) {
	go m.cleanupLoop(ctx)
}

// Close stops the cleanup loop and closes every session.
func (m *Manager) Close() {
	m.stopOnce.Do(func() { close(m.stopCh) })
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.sessions {
		s.close()
		delete(m.sessions, id)
	}
}

// Connect dials the remote host and opens an SFTP client.
func (m *Manager) Connect(ctx context.Context, p ConnectionParams) (*Session, error) {
	host := strings.TrimSpace(p.Host)
	user := strings.TrimSpace(p.User)
	if host == "" {
		return nil, errors.New("host is required")
	}
	if user == "" {
		return nil, errors.New("user is required")
	}
	port := p.Port
	if port == 0 {
		port = 22
	}
	if port < 1 || port > 65535 {
		return nil, errors.New("port must be between 1 and 65535")
	}

	authMethods, err := authMethods(p)
	if err != nil {
		return nil, err
	}

	var hostKey string
	config := &ssh.ClientConfig{
		User:            user,
		Auth:            authMethods,
		HostKeyCallback: fingerprintCallback(&hostKey),
		Timeout:         dialTimeout,
	}

	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	dialer := net.Dialer{Timeout: dialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", addr, err)
	}
	sshConn, chans, reqs, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ssh handshake: %w", err)
	}
	sshClient := ssh.NewClient(sshConn, chans, reqs)

	sftpClient, err := sftp.NewClient(sshClient)
	if err != nil {
		_ = sshClient.Close()
		return nil, fmt.Errorf("open sftp: %w", err)
	}

	session := &Session{
		ID:          newID(),
		Host:        host,
		User:        user,
		HostKey:     hostKey,
		ConnectedAt: time.Now(),
		lastUsed:    time.Now(),
		sshClient:   sshClient,
		sftpClient:  sftpClient,
	}
	m.mu.Lock()
	m.sessions[session.ID] = session
	m.mu.Unlock()
	return session, nil
}

// Get returns a live session by id.
func (m *Manager) Get(id string) (*Session, error) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok {
		return nil, errors.New("session not found or expired")
	}
	s.touch()
	return s, nil
}

// Disconnect ends one session.
func (m *Manager) Disconnect(id string) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if ok {
		s.close()
	}
}

// SessionInfo describes a live session for the sessions endpoint.
type SessionInfo struct {
	ID          string `json:"id"`
	Host        string `json:"host"`
	User        string `json:"user"`
	HostKey     string `json:"hostKey"`
	ConnectedAt string `json:"connectedAt"`
}

// List returns every live session.
func (m *Manager) List() []SessionInfo {
	m.mu.Lock()
	out := make([]SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, SessionInfo{
			ID:          s.ID,
			Host:        s.Host,
			User:        s.User,
			HostKey:     s.HostKey,
			ConnectedAt: s.ConnectedAt.UTC().Format(time.RFC3339),
		})
	}
	m.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ConnectedAt < out[j].ConnectedAt })
	return out
}

func (m *Manager) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.stopCh:
			return
		case <-ticker.C:
			m.closeIdle()
		}
	}
}

func (m *Manager) closeIdle() {
	var expired []*Session
	m.mu.Lock()
	for id, s := range m.sessions {
		if s.idleFor() > IdleTimeout {
			expired = append(expired, s)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, s := range expired {
		s.close()
	}
}

// ── Session operations ────────────────────────────────────────────────

func (s *Session) touch() {
	s.mu.Lock()
	s.lastUsed = time.Now()
	s.mu.Unlock()
}

func (s *Session) idleFor() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Since(s.lastUsed)
}

func (s *Session) close() {
	if s.sftpClient != nil {
		_ = s.sftpClient.Close()
	}
	if s.sshClient != nil {
		_ = s.sshClient.Close()
	}
}

// Home returns the session's default (home) directory.
func (s *Session) Home() string {
	s.touch()
	wd, err := s.sftpClient.Getwd()
	if err != nil || wd == "" {
		return "/"
	}
	return wd
}

// List returns the entries of a directory.
func (s *Session) List(dir string) ([]Entry, error) {
	s.touch()
	dir = cleanRemote(dir)
	infos, err := s.sftpClient.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(infos))
	for _, info := range infos {
		mode := ""
		if info.Mode()&os.ModeSymlink != 0 {
			mode = "link"
		}
		entries = append(entries, Entry{
			Name:    info.Name(),
			IsDir:   info.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().UTC().Format(time.RFC3339),
			Mode:    mode,
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries, nil
}

// Stat returns one entry's metadata.
func (s *Session) Stat(p string) (*Entry, error) {
	s.touch()
	info, err := s.sftpClient.Stat(cleanRemote(p))
	if err != nil {
		return nil, err
	}
	return &Entry{
		Name:    info.Name(),
		IsDir:   info.IsDir(),
		Size:    info.Size(),
		ModTime: info.ModTime().UTC().Format(time.RFC3339),
	}, nil
}

// Mkdir creates a directory (including parents).
func (s *Session) Mkdir(p string) error {
	s.touch()
	return s.sftpClient.MkdirAll(cleanRemote(p))
}

// OpenReader opens a remote file for reading, returning the reader, its size
// and base name.
func (s *Session) OpenReader(p string) (io.ReadCloser, int64, string, error) {
	s.touch()
	f, err := s.sftpClient.Open(cleanRemote(p))
	if err != nil {
		return nil, 0, "", err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, "", err
	}
	return f, info.Size(), info.Name(), nil
}

// CreateWriter creates (or truncates) a remote file for writing, creating any
// missing parent directories.
func (s *Session) CreateWriter(p string) (io.WriteCloser, error) {
	s.touch()
	p = cleanRemote(p)
	if dir := path.Dir(p); dir != "" && dir != "." {
		if err := s.sftpClient.MkdirAll(dir); err != nil {
			return nil, err
		}
	}
	return s.sftpClient.Create(p)
}

// CopyFromSession copies a file or directory from another SFTP session into a
// remote directory, preserving the base name. The transfer streams through this
// host, so it never round-trips through the browser.
func (s *Session) CopyFromSession(src *Session, remotePath, destDir string, recursive, overwrite bool) error {
	s.touch()
	src.touch()
	remotePath = cleanRemote(remotePath)
	info, err := src.sftpClient.Stat(remotePath)
	if err != nil {
		return err
	}
	dest := path.Join(cleanRemote(destDir), path.Base(remotePath))
	if info.IsDir() {
		if !recursive {
			return errors.New("source is a directory; enable recursive copy")
		}
		return s.copySessionDir(src, remotePath, dest, overwrite)
	}
	return s.copySessionFile(src, remotePath, dest, overwrite)
}

func (s *Session) copySessionDir(src *Session, remotePath, destDir string, overwrite bool) error {
	walker := src.sftpClient.Walk(remotePath)
	for walker.Step() {
		if err := walker.Err(); err != nil {
			return err
		}
		p := walker.Path()
		rel, err := filepath.Rel(remotePath, p)
		if err != nil {
			return err
		}
		target := path.Join(destDir, filepath.ToSlash(rel))
		if walker.Stat().IsDir() {
			if err := s.sftpClient.MkdirAll(target); err != nil {
				return err
			}
			continue
		}
		if err := s.copySessionFile(src, p, target, overwrite); err != nil {
			return err
		}
	}
	return nil
}

func (s *Session) copySessionFile(src *Session, remotePath, destPath string, overwrite bool) error {
	if !overwrite {
		if _, err := s.sftpClient.Stat(destPath); err == nil {
			return fmt.Errorf("%s already exists", destPath)
		}
	}
	if dir := path.Dir(destPath); dir != "" && dir != "." {
		if err := s.sftpClient.MkdirAll(dir); err != nil {
			return err
		}
	}
	srcFile, err := src.sftpClient.Open(remotePath)
	if err != nil {
		return err
	}
	defer func() { _ = srcFile.Close() }()
	dstFile, err := s.sftpClient.Create(destPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dstFile, srcFile); err != nil {
		_ = dstFile.Close()
		return err
	}
	return dstFile.Close()
}

// Rename moves a remote path within its directory.
func (s *Session) Rename(from, to string) error {
	s.touch()
	return s.sftpClient.Rename(cleanRemote(from), cleanRemote(to))
}

// Remove deletes a file, or a directory tree.
func (s *Session) Remove(p string) error {
	s.touch()
	p = cleanRemote(p)
	info, err := s.sftpClient.Stat(p)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return s.sftpClient.Remove(p)
	}
	// Walk and delete children, then the directory itself.
	walker := s.sftpClient.Walk(p)
	var dirs []string
	for walker.Step() {
		if err := walker.Err(); err != nil {
			return err
		}
		child := walker.Path()
		if child == p {
			continue
		}
		if walker.Stat().IsDir() {
			dirs = append(dirs, child)
			continue
		}
		if err := s.sftpClient.Remove(child); err != nil {
			return err
		}
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := s.sftpClient.RemoveDirectory(dirs[i]); err != nil {
			return err
		}
	}
	return s.sftpClient.RemoveDirectory(p)
}

// CopyLocalToRemote copies a local file or directory into a remote directory,
// preserving the base name.
func (s *Session) CopyLocalToRemote(localPath, remoteDir string, recursive, overwrite bool) error {
	s.touch()
	info, err := os.Stat(localPath)
	if err != nil {
		return err
	}
	dest := path.Join(cleanRemote(remoteDir), filepath.Base(localPath))
	if info.IsDir() {
		if !recursive {
			return errors.New("source is a directory; enable recursive copy")
		}
		return s.copyLocalDir(localPath, dest, overwrite)
	}
	return s.copyLocalFile(localPath, dest, info.Size(), overwrite)
}

func (s *Session) copyLocalDir(localPath, remoteDir string, overwrite bool) error {
	return filepath.Walk(localPath, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(localPath, p)
		if err != nil {
			return err
		}
		remote := path.Join(remoteDir, filepath.ToSlash(rel))
		if info.IsDir() {
			return s.sftpClient.MkdirAll(remote)
		}
		return s.copyLocalFile(p, remote, info.Size(), overwrite)
	})
}

func (s *Session) copyLocalFile(localPath, remotePath string, size int64, overwrite bool) error {
	if !overwrite {
		if _, err := s.sftpClient.Stat(remotePath); err == nil {
			return fmt.Errorf("%s already exists", remotePath)
		}
	}
	if dir := path.Dir(remotePath); dir != "" && dir != "." {
		if err := s.sftpClient.MkdirAll(dir); err != nil {
			return err
		}
	}
	src, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	dst, err := s.sftpClient.Create(remotePath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		return err
	}
	return dst.Close()
}

// CopyRemoteToLocal copies a remote file or directory into a local directory,
// preserving the base name.
func (s *Session) CopyRemoteToLocal(remotePath, localDir string, recursive, overwrite bool) error {
	s.touch()
	remotePath = cleanRemote(remotePath)
	info, err := s.sftpClient.Stat(remotePath)
	if err != nil {
		return err
	}
	dest := filepath.Join(localDir, path.Base(remotePath))
	if info.IsDir() {
		if !recursive {
			return errors.New("source is a directory; enable recursive copy")
		}
		return s.copyRemoteDir(remotePath, dest, overwrite)
	}
	return s.copyRemoteFile(remotePath, dest, overwrite)
}

func (s *Session) copyRemoteDir(remotePath, localDir string, overwrite bool) error {
	walker := s.sftpClient.Walk(remotePath)
	for walker.Step() {
		if err := walker.Err(); err != nil {
			return err
		}
		p := walker.Path()
		rel, err := filepath.Rel(remotePath, p)
		if err != nil {
			return err
		}
		local := filepath.Join(localDir, rel)
		if walker.Stat().IsDir() {
			if err := os.MkdirAll(local, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := s.copyRemoteFile(p, local, overwrite); err != nil {
			return err
		}
	}
	return nil
}

func (s *Session) copyRemoteFile(remotePath, localPath string, overwrite bool) error {
	if !overwrite {
		if _, err := os.Stat(localPath); err == nil {
			return fmt.Errorf("%s already exists", localPath)
		}
	}
	if dir := filepath.Dir(localPath); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	src, err := s.sftpClient.Open(remotePath)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	dst, err := os.Create(localPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		return err
	}
	return dst.Close()
}

// ── helpers ───────────────────────────────────────────────────────────

// authMethods builds the SSH auth methods from the request.
func authMethods(p ConnectionParams) ([]ssh.AuthMethod, error) {
	switch strings.ToLower(strings.TrimSpace(p.Auth)) {
	case "", "password":
		if p.Password == "" {
			return nil, errors.New("password is required")
		}
		return []ssh.AuthMethod{ssh.Password(p.Password)}, nil
	case "key", "privatekey":
		key := p.PrivateKey
		if strings.TrimSpace(key) == "" {
			return nil, errors.New("private key is required")
		}
		var signer ssh.Signer
		var err error
		if p.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(key), []byte(p.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(key))
		}
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	default:
		return nil, fmt.Errorf("unknown auth method %q", p.Auth)
	}
}

// fingerprintCallback records the host key fingerprint and accepts it. The
// fingerprint is returned to the UI so the user can verify the host; there is
// no persistent known_hosts check.
func fingerprintCallback(out *string) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		*out = ssh.FingerprintSHA256(key)
		return nil
	}
}

// cleanRemote normalises a remote POSIX path.
func cleanRemote(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return "."
	}
	return path.Clean(p)
}

func newID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("sftp-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
