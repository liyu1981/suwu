package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// These tests drive the real binary, because the wiring under test — the serve
// command resolving SocketPath() and handing it to notify.NewListener — only
// exists once the command runs. Every child is started through
// exec.CommandContext with a deadline, so a case that unexpectedly *starts* a
// server fails the test instead of wedging the suite.

// buildSuwuBinary builds the CLI into a temp dir. It is the only way to cover
// the real command path; the build is cached by the Go toolchain across runs.
func buildSuwuBinary(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("builds the binary")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "suwu")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "build", "-o", bin, "./cmd/Suwu")
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		if ctx.Err() != nil {
			t.Fatalf("go build ./cmd/Suwu did not finish in time")
		}
		t.Fatalf("go build ./cmd/Suwu: %v\n%s", err, out)
	}
	return bin
}

// syncBuffer is an io.Writer safe to read while the child is writing.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// freePort reserves an ephemeral loopback port and releases it. The window
// between release and the server binding is small; loopback ports of a test
// host rarely collide.
func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprint(port)
}

// serveProc is one running `suwu serve` child.
type serveProc struct {
	bin  string
	dir  string
	sock string
	out  *syncBuffer

	pid    int
	cancel context.CancelFunc
	// done is closed when the child exits. A closed channel can be observed by
	// both the liveness check and the wait helpers; a value channel can only be
	// drained once.
	done chan struct{}
}

// serverEnv is the whole environment of a child: nothing is inherited from the
// test process (a developer shell may carry SUWU_* values), so the run is
// hermetic and a stray instance can never be reached.
func serverEnv(dir, port string, extra ...string) []string {
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + filepath.Join(dir, "home"),
		"SERVER_MODE=http",
		"HOST=127.0.0.1",
		"HTTP_PORT=" + port,
		"SUWU_VAR=" + dir,
		"SUWU_CONFIG_DIR=" + filepath.Join(dir, "config"),
		"SUWU_LOG_LEVEL=info",
	}
	return append(env, extra...)
}

// startServer starts a server and waits until its notify socket exists. It
// fails if the process exits first, and every child is bounded by a deadline so
// cleanup can never block the test run.
func startServer(t *testing.T, bin, dir, port, sockName string, extraEnv ...string) *serveProc {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	cmd := exec.CommandContext(ctx, bin, "serve", "--env-file", "/dev/null")
	cmd.Env = serverEnv(dir, port, extraEnv...)
	out := &syncBuffer{}
	cmd.Stdout, cmd.Stderr = out, out
	// A nil Stdin gives the child /dev/null, so nothing can ever wait on us.
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatalf("start server: %v", err)
	}

	s := &serveProc{
		bin:    bin,
		dir:    dir,
		sock:   filepath.Join(dir, sockName),
		out:    out,
		pid:    cmd.Process.Pid,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go func() {
		_ = cmd.Wait()
		close(s.done)
	}()
	t.Cleanup(func() { s.stop(t) })

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-s.done:
			cancel()
			t.Fatalf("server exited before %s appeared\n%s", s.sock, out.String())
		default:
		}
		if _, err := os.Lstat(s.sock); err == nil {
			return s
		}
		time.Sleep(25 * time.Millisecond)
	}
	cancel()
	t.Fatalf("server did not create %s within 20s\n%s", s.sock, out.String())
	return nil
}

func (s *serveProc) alive() bool {
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

// stop terminates the child and fails the test if it will not exit promptly.
func (s *serveProc) stop(t *testing.T) {
	t.Helper()
	if !s.alive() {
		s.cancel()
		return
	}
	s.cancel()
	select {
	case <-s.done:
	case <-time.After(10 * time.Second):
		t.Errorf("server did not exit after cancellation\n%s", s.out.String())
	}
}

// runBounded runs the binary to completion within timeout. A run that is still
// alive at the deadline is a failure: that is a case that started serving
// instead of failing fast, which is exactly what these tests must catch.
func runBounded(t *testing.T, timeout time.Duration, bin string, env []string, args ...string) (code int, output string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = env
	out := &syncBuffer{}
	cmd.Stdout, cmd.Stderr = out, out

	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("%v did not exit within %s — it started serving instead of failing\n%s",
			args, timeout, out.String())
	}
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatalf("run %v: %v", args, err)
		}
		return exit.ExitCode(), out.String()
	}
	return 0, out.String()
}

// A second server must not steal a live socket: that strands the first one's CLI
// ingress with no way to repair it short of a restart
// (docs/MEMORY_GROWTH_INVESTIGATION.md §5.7).
func TestServeRefusesLiveNotifySocket(t *testing.T) {
	bin := buildSuwuBinary(t)
	dir := t.TempDir()

	prod := startServer(t, bin, dir, freePort(t), "suwu.sock")

	// The second instance gets a different HTTP port and the same socket path.
	code, output := runBounded(t, 20*time.Second, bin,
		serverEnv(dir, freePort(t)),
		"serve", "--env-file", "/dev/null")

	if code == 0 {
		t.Fatalf("second instance exited 0; it should have refused\n%s", output)
	}
	if !strings.Contains(output, "already in use") {
		t.Errorf("refusal does not explain itself; output:\n%s", output)
	}
	if !strings.Contains(output, "SUWU_SOCK_PATH") {
		t.Errorf("refusal does not name the way out (SUWU_SOCK_PATH); output:\n%s", output)
	}

	// The refusal must not have disturbed the running server: its socket is
	// still there and still answered by it.
	if _, err := os.Lstat(prod.sock); err != nil {
		t.Fatalf("running server lost its socket to the refused instance: %v", err)
	}
	sendCode, sendOut := runBounded(t, 10*time.Second, bin,
		serverEnv(dir, freePort(t)),
		"send", "--sock", prod.sock, "still alive")
	if sendCode != 0 {
		t.Fatalf("notify send after a refused bind failed (%d):\n%s", sendCode, sendOut)
	}
}

// A development instance must use its own socket name, so it can run beside the
// installed service instead of fighting over one path.
func TestServeDevUsesSeparateSocketPath(t *testing.T) {
	bin := buildSuwuBinary(t)
	dir := t.TempDir()

	prod := startServer(t, bin, dir, freePort(t), "suwu.sock")
	devSock := filepath.Join(dir, "suwu-dev.sock")
	if devSock == prod.sock {
		t.Fatal("test setup: dev and prod socket paths are equal")
	}

	dev := startServer(t, bin, dir, freePort(t), "suwu-dev.sock", "SUWU_DEV=true")
	if _, err := os.Lstat(devSock); err != nil {
		t.Fatalf("dev server did not use %s: %v\n%s", devSock, err, dev.out.String())
	}
	if !prod.alive() || !dev.alive() {
		t.Fatalf("both servers should be running (prod=%v dev=%v)", prod.alive(), dev.alive())
	}

	// Each socket reaches its own instance.
	for _, sock := range []string{prod.sock, devSock} {
		code, out := runBounded(t, 10*time.Second, bin, serverEnv(dir, freePort(t)), "send", "--sock", sock, "hello")
		if code != 0 {
			t.Fatalf("send to %s failed (%d):\n%s", filepath.Base(sock), code, out)
		}
	}
}

// A graceful stop must remove the socket it owns — and only that one.
func TestServeRemovesItsOwnSocketOnExit(t *testing.T) {
	bin := buildSuwuBinary(t)
	dir := t.TempDir()

	prod := startServer(t, bin, dir, freePort(t), "suwu.sock")
	dev := startServer(t, bin, dir, freePort(t), "suwu-dev.sock", "SUWU_DEV=true")
	devSock := filepath.Join(dir, "suwu-dev.sock")

	// Ask prod to stop and give the shutdown path a moment; dev must survive.
	if err := syscall.Kill(prodPID(t, prod), syscall.SIGTERM); err != nil {
		t.Fatalf("signal prod: %v", err)
	}
	waitGone(t, prod)
	if _, err := os.Lstat(prod.sock); !os.IsNotExist(err) {
		t.Fatalf("prod socket survived its own shutdown: %v", err)
	}
	if _, err := os.Lstat(devSock); err != nil {
		t.Fatalf("prod shutdown removed the dev socket: %v", err)
	}
	if !dev.alive() {
		t.Fatalf("dev server died when prod stopped\n%s", dev.out.String())
	}
}

// prodPID digs the child's pid out of the running server.
func prodPID(t *testing.T, s *serveProc) int {
	t.Helper()
	// exec.CommandContext keeps the os.Process reachable only through the Cmd it
	// started; recording it here keeps this helper honest.
	if s.pid == 0 {
		t.Fatal("server pid not recorded")
	}
	return s.pid
}

func waitGone(t *testing.T, s *serveProc) {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(15 * time.Second):
		t.Fatalf("server still running after SIGTERM\n%s", s.out.String())
	}
}

// Every fatal path in the serve command must print why it failed. This is the
// case that exposed the silence: a config error used to exit 1 with no output at
// all, which reads as "it just will not start".
func TestServeFatalErrorIsVisible(t *testing.T) {
	bin := buildSuwuBinary(t)
	dir := t.TempDir()

	code, output := runBounded(t, 20*time.Second, bin,
		serverEnv(dir, freePort(t), "SERVER_MODE=bogus"),
		"serve", "--env-file", "/dev/null")

	if code == 0 {
		t.Fatalf("invalid SERVER_MODE exited 0")
	}
	if strings.TrimSpace(output) == "" {
		t.Fatal("fatal error printed nothing; the operator sees only a non-zero exit")
	}
	if !strings.Contains(output, "invalid SERVER_MODE") {
		t.Errorf("fatal output does not say what was wrong:\n%s", output)
	}
}
