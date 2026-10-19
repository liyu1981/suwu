package sftp

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// startTestServer runs an in-process SSH server that serves SFTP rooted at a
// temp dir, and returns its address and root. This exercises the real client
// stack (dial, auth, subsystem, sftp ops) without an external host.
func startTestServer(t *testing.T) (addr, root string) {
	t.Helper()
	root = t.TempDir()

	_, hostKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(hostKey)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if c.User() == "tester" && string(pass) == "secret" {
				return nil, nil
			}
			return nil, fmt.Errorf("access denied")
		},
	}
	config.AddHostKey(signer)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveConn(conn, config, root)
		}
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	return fmt.Sprintf("127.0.0.1:%d", port), root
}

func serveConn(conn net.Conn, config *ssh.ServerConfig, root string) {
	sshConn, chans, reqs, err := ssh.NewServerConn(conn, config)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer func() { _ = sshConn.Close() }()
	go ssh.DiscardRequests(reqs)
	for newChan := range chans {
		if newChan.ChannelType() != "session" {
			_ = newChan.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		ch, requests, err := newChan.Accept()
		if err != nil {
			continue
		}
		go func() {
			for req := range requests {
				if req.Type == "subsystem" && len(req.Payload) > 4 && string(req.Payload[4:]) == "sftp" {
					_ = req.Reply(true, nil)
					srv, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(root))
					if err != nil {
						return
					}
					_ = srv.Serve()
					_ = srv.Close()
					return
				}
				_ = req.Reply(false, nil)
			}
		}()
	}
}

func connectTest(t *testing.T) (*Manager, *Session, string) {
	t.Helper()
	addr, root := startTestServer(t)
	host, portStr, _ := net.SplitHostPort(addr)
	port := 0
	_, _ = fmt.Sscanf(portStr, "%d", &port)

	m := NewManager()
	t.Cleanup(m.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := m.Connect(ctx, ConnectionParams{
		Host: host, Port: port, User: "tester", Auth: "password", Password: "secret",
	})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	return m, session, root
}

func TestConnectRejectsBadPassword(t *testing.T) {
	addr, _ := startTestServer(t)
	host, portStr, _ := net.SplitHostPort(addr)
	port := 0
	_, _ = fmt.Sscanf(portStr, "%d", &port)
	m := NewManager()
	defer m.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := m.Connect(ctx, ConnectionParams{
		Host: host, Port: port, User: "tester", Auth: "password", Password: "wrong",
	}); err == nil {
		t.Fatal("expected auth failure")
	}
}

func TestSessionOperations(t *testing.T) {
	m, session, root := connectTest(t)

	if home := session.Home(); home == "" {
		t.Fatal("empty home")
	}

	// mkdir + list
	if err := session.Mkdir("docs"); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	entries, err := session.List(".")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !hasDir(entries, "docs") {
		t.Fatalf("docs missing from %+v", entries)
	}

	// Upload via CreateWriter, download via OpenReader.
	writer, err := session.CreateWriter("docs/hello.txt")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := writer.Write([]byte("hello world")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	reader, size, _, err := session.OpenReader("docs/hello.txt")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	data, _ := io.ReadAll(reader)
	_ = reader.Close()
	if string(data) != "hello world" || size != 11 {
		t.Fatalf("read %q size %d", data, size)
	}
	if _, err := os.Stat(filepath.Join(root, "docs", "hello.txt")); err != nil {
		t.Fatalf("server file missing: %v", err)
	}

	// Rename.
	if err := session.Rename("docs/hello.txt", "docs/renamed.txt"); err != nil {
		t.Fatalf("rename: %v", err)
	}

	// Copy local -> remote, then remote -> local.
	localDir := t.TempDir()
	localFile := filepath.Join(localDir, "upload.bin")
	if err := os.WriteFile(localFile, []byte("binary-ish"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := session.CopyLocalToRemote(localFile, "docs", false, false); err != nil {
		t.Fatalf("local->remote: %v", err)
	}
	// A second copy without overwrite must fail.
	if err := session.CopyLocalToRemote(localFile, "docs", false, false); err == nil {
		t.Fatal("expected overwrite refusal")
	}
	outDir := t.TempDir()
	if err := session.CopyRemoteToLocal("docs/upload.bin", outDir, false, false); err != nil {
		t.Fatalf("remote->local: %v", err)
	}
	back, _ := os.ReadFile(filepath.Join(outDir, "upload.bin"))
	if string(back) != "binary-ish" {
		t.Fatalf("round-trip content = %q", back)
	}

	// Recursive directory copy local -> remote.
	if err := session.CopyLocalToRemote(localDir, ".", true, true); err != nil {
		t.Fatalf("recursive local->remote: %v", err)
	}
	if _, err := session.Stat(filepath.Base(localDir) + "/upload.bin"); err != nil {
		t.Fatalf("recursive copy missing file: %v", err)
	}

	// Remove a directory tree.
	if err := session.Remove("docs"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := session.Stat("docs"); err == nil {
		t.Fatal("docs still present after remove")
	}

	// Manager lookup by id, then disconnect.
	if _, err := m.Get(session.ID); err != nil {
		t.Fatalf("get: %v", err)
	}
	m.Disconnect(session.ID)
	if len(m.List()) != 0 {
		t.Fatal("session not removed")
	}
}

func hasDir(entries []Entry, name string) bool {
	for _, e := range entries {
		if e.Name == name && e.IsDir {
			return true
		}
	}
	return false
}

func TestCopyRemoteToRemote(t *testing.T) {
	_, source, _ := connectTest(t)
	_, dest, _ := connectTest(t)

	writer, err := source.CreateWriter("shared.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("remote to remote")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	if err := dest.CopyFromSession(source, "shared.txt", ".", false, false); err != nil {
		t.Fatalf("remote->remote: %v", err)
	}
	reader, _, _, err := dest.OpenReader("shared.txt")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(reader)
	_ = reader.Close()
	if string(data) != "remote to remote" {
		t.Fatalf("copied content = %q", data)
	}
}
