package installto

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// ── helpers ────────────────────────────────────────────────────────────

// ed25519Key generates a host key for the in-process SSH server.
func ed25519Key() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}

// testServer is a minimal in-process SSH server: password auth, SFTP
// subsystem, and an exec handler for the three commands installto sends.
type testServer struct {
	home       string
	platform   string   // reply for `uname -sm`
	exitStatus uint32   // exit code for the install command
	commands   []string // exec'd commands, in order
}

func startTestServer(t *testing.T, srv *testServer) (addr string, port int) {
	t.Helper()
	_, hostKey, err := ed25519Key()
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(hostKey)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if c.User() == "dest" && string(pass) == "secret" {
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
			go serveSSH(conn, config, srv)
		}
	}()

	tcp := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", tcp.Port
}

func serveSSH(conn net.Conn, config *ssh.ServerConfig, srv *testServer) {
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
			defer func() { _ = ch.Close() }()
			for req := range requests {
				switch req.Type {
				case "pty-req", "env", "window-change":
					_ = req.Reply(req.Type != "window-change", nil)
				case "subsystem":
					var msg struct{ Name string }
					if err := ssh.Unmarshal(req.Payload, &msg); err != nil || msg.Name != "sftp" {
						_ = req.Reply(false, nil)
						continue
					}
					_ = req.Reply(true, nil)
					if server, err := sftp.NewServer(ch); err == nil {
						_ = server.Serve()
						_ = server.Close()
					}
					return
				case "exec":
					var msg struct{ Command string }
					if err := ssh.Unmarshal(req.Payload, &msg); err != nil {
						_ = req.Reply(false, nil)
						continue
					}
					_ = req.Reply(true, nil)
					code := srv.exec(ch, msg.Command)
					_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{code}))
					return
				default:
					_ = req.Reply(false, nil)
				}
			}
		}()
	}
}

// exec runs one of installto's commands and returns its exit status.
func (s *testServer) exec(ch ssh.Channel, cmd string) uint32 {
	switch {
	case strings.HasPrefix(cmd, "uname"):
		_, _ = ch.Write([]byte(s.platform + "\n"))
		return 0
	case strings.Contains(cmd, `printf`):
		_, _ = ch.Write([]byte(s.home))
		return 0
	default:
		s.commands = append(s.commands, cmd)
		_, _ = ch.Write([]byte("wizard done\n"))
		return s.exitStatus
	}
}

func TestParseTarget(t *testing.T) {
	user, host, err := ParseTarget("dest@192.168.0.5")
	if err != nil || user != "dest" || host != "192.168.0.5" {
		t.Fatalf("plain target: %q %q %v", user, host, err)
	}
	if _, host, err = ParseTarget("me@[fe80::1]"); err != nil || host != "fe80::1" {
		t.Fatalf("bracketed host: %q %v", host, err)
	}
	for _, bad := range []string{"", "hostonly", "@host", "user@", "a b@host"} {
		if _, _, err := ParseTarget(bad); err == nil {
			t.Errorf("expected %q to be rejected", bad)
		}
	}
}

func TestNormalizeArch(t *testing.T) {
	pairs := map[string]string{
		"amd64": "x86_64", "x86_64": "x86_64",
		"arm64": "arm64", "aarch64": "arm64",
		"386": "x86", "i686": "x86",
		"armv7l": "arm", "arm": "arm",
		"riscv64": "riscv64",
	}
	for in, want := range pairs {
		if got := normalizeArch(in); got != want {
			t.Errorf("normalizeArch(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPlatformMatches(t *testing.T) {
	goarch := runtime.GOARCH
	if !platformMatches("Linux "+unameArch(goarch), runtime.GOOS, goarch) {
		t.Fatalf("own platform must match (GOOS=%s GOARCH=%s)", runtime.GOOS, goarch)
	}
	if platformMatches("OpenBSD something", runtime.GOOS, goarch) {
		t.Error("different OS must not match")
	}
	if platformMatches("Linux definitely-not-an-arch", runtime.GOOS, goarch) {
		t.Error("different arch must not match")
	}
	// uname machine names match Go arch names.
	if runtime.GOARCH == "amd64" && !platformMatches("Linux x86_64", "linux", "amd64") {
		t.Error("x86_64 must match amd64")
	}
	if runtime.GOARCH == "arm64" && !platformMatches("Linux aarch64", "linux", "arm64") {
		t.Error("aarch64 must match arm64")
	}
}

// unameArch maps a Go arch to the uname machine name installto compares with.
func unameArch(goarch string) string {
	switch goarch {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	case "386":
		return "i686"
	default:
		return goarch
	}
}

// ── end-to-end ─────────────────────────────────────────────────────────

// newLocalBinary writes a fake binary to install and returns its path.
func newLocalBinary(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "suwu")
	if err := os.WriteFile(file, []byte("FAKEBINARY"), 0o755); err != nil {
		t.Fatal(err)
	}
	return file
}

func runInstall(t *testing.T, srv *testServer) (stdout, stderr *strings.Builder, err error) {
	t.Helper()
	host, port := startTestServer(t, srv)
	out := &strings.Builder{}
	errOut := &strings.Builder{}
	binary := newLocalBinary(t)
	runErr := Run(context.Background(), Options{
		User:       "dest",
		Host:       host,
		Port:       port,
		Password:   "secret",
		BinaryPath: binary,
		Stdin:      strings.NewReader(""),
		Stdout:     out,
		Stderr:     errOut,
	})
	return out, errOut, runErr
}

func TestRunInstallsAndStartsCommand(t *testing.T) {
	home := t.TempDir()
	srv := &testServer{
		home:     home,
		platform: "Linux " + unameArch(runtime.GOARCH),
	}
	out, _, err := runInstall(t, srv)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// The binary lands in ~/.local/bin/suwu, executable.
	installed := path.Join(home, ".local", "bin", "suwu")
	data, err := os.ReadFile(installed)
	if err != nil {
		t.Fatalf("installed binary: %v", err)
	}
	if string(data) != "FAKEBINARY" {
		t.Fatalf("content = %q", data)
	}
	info, err := os.Stat(installed)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o111 == 0 {
		t.Fatalf("mode %v is not executable", info.Mode())
	}

	// No temp file left behind.
	entries, _ := os.ReadDir(path.Join(home, ".local", "bin"))
	if len(entries) != 1 {
		t.Fatalf("expected exactly the installed binary, got %d entries", len(entries))
	}

	// The wizard was started with the installed path.
	if len(srv.commands) != 1 {
		t.Fatalf("expected 1 command, got %v", srv.commands)
	}
	want := posixQuote(installed) + " " + posixQuote("onboard")
	if srv.commands[0] != want {
		t.Fatalf("command = %q, want %q", srv.commands[0], want)
	}

	log := out.String()
	for _, want := range []string{"Connecting to dest@", "Remote platform", "Installed", "SSH session closed."} {
		if !strings.Contains(log, want) {
			t.Errorf("stdout missing %q:\n%s", want, log)
		}
	}
}

func TestRunRejectsPlatformMismatch(t *testing.T) {
	home := t.TempDir()
	srv := &testServer{
		home:     home,
		platform: "OpenBSD dreamstation",
	}
	_, _, err := runInstall(t, srv)
	if err == nil || !strings.Contains(err.Error(), "platform mismatch") {
		t.Fatalf("err = %v, want a platform mismatch", err)
	}
	// Nothing must be transferred.
	if _, statErr := os.Stat(path.Join(home, ".local")); statErr == nil {
		t.Fatal("directory was created despite the platform mismatch")
	}
	if len(srv.commands) != 0 {
		t.Fatalf("remote command ran despite the platform mismatch: %v", srv.commands)
	}
}

func TestRunRemoteCommandFailureClosesSSH(t *testing.T) {
	home := t.TempDir()
	srv := &testServer{
		home:       home,
		platform:   "Linux " + unameArch(runtime.GOARCH),
		exitStatus: 1,
	}
	out, _, err := runInstall(t, srv)
	if err == nil {
		t.Fatal("expected an error when the remote command fails")
	}
	if !strings.Contains(err.Error(), "remote command failed") {
		t.Fatalf("err = %v", err)
	}
	// The upload itself succeeded; the session still closed cleanly.
	if _, statErr := os.Stat(path.Join(home, ".local", "bin", "suwu")); statErr != nil {
		t.Fatalf("binary missing: %v", statErr)
	}
	if !strings.Contains(out.String(), "SSH session closed.") {
		t.Fatalf("stdout:\n%s", out.String())
	}
}

func TestRunRejectsBadTarget(t *testing.T) {
	err := Run(context.Background(), Options{Stdout: &strings.Builder{}, Stderr: &strings.Builder{}})
	if err == nil || !strings.Contains(err.Error(), "<user>@<host>") {
		t.Fatalf("err = %v", err)
	}
}

func TestHumanBytes(t *testing.T) {
	if got := humanBytes(512); got != "512 B" {
		t.Errorf("got %q", got)
	}
	if got := humanBytes(20 * 1024); got != "20.0 KiB" {
		t.Errorf("got %q", got)
	}
}

// TestRunTimeoutKillsDial is a smoke test that a context deadline is honored
// when the destination is unroutable.
func TestRunTimeoutKillsDial(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	// 192.0.2.0/24 is TEST-NET-1 (RFC 5737): blackholed, never a real host.
	err := Run(ctx, Options{
		User:     "dest",
		Host:     "192.0.2.1",
		Port:     22,
		Password: "secret",
		Stdin:    strings.NewReader(""),
		Stdout:   &strings.Builder{},
		Stderr:   &strings.Builder{},
	})
	if err == nil {
		t.Fatal("expected the dial to fail or time out")
	}
}
