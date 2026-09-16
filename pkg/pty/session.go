// Package pty wraps creating and managing a shell pseudo-terminal session.
package pty

import (
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"

	"github.com/creack/pty"
)

// Session is a single shell PTY session.
type Session struct {
	cmd  *exec.Cmd
	ptmx *os.File
}

// StartWithCWD launches the user's shell in a new PTY with the given size
// and an optional initial working directory. If cwd is empty, the home
// directory is used.
func StartWithCWD(cols, rows uint16, cwd string) (*Session, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}

	dir := cwd
	if dir == "" {
		home, err := homeDir()
		if err != nil {
			return nil, err
		}
		dir = home
	}

	cmd := exec.Command(shell)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"COLORFGBG=15;0",
	)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: cols,
		Rows: rows,
	})
	if err != nil {
		return nil, err
	}

	return &Session{cmd: cmd, ptmx: ptmx}, nil
}

// Read implements io.Reader over the PTY master.
func (s *Session) Read(p []byte) (int, error) {
	return s.ptmx.Read(p)
}

// Write implements io.Writer over the PTY master.
func (s *Session) Write(p []byte) (int, error) {
	return s.ptmx.Write(p)
}

// Resize updates the PTY window size.
func (s *Session) Resize(cols, rows uint16) error {
	return pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

// Kill terminates the session and its shell.
func (s *Session) Kill() error {
	if s.ptmx != nil {
		_ = s.ptmx.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	return nil
}

// Wait blocks until the shell exits and returns its exit code.
// Returns -1 if no process info is available.
func (s *Session) Wait() int {
	if s.cmd == nil || s.cmd.Process == nil {
		return -1
	}
	err := s.cmd.Wait()
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

// Pid returns the shell process ID, or -1 if unavailable.
func (s *Session) Pid() int {
	if s.cmd == nil || s.cmd.Process == nil {
		return -1
	}
	return s.cmd.Process.Pid
}

func homeDir() (string, error) {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h, nil
	}
	u, err := user.Current()
	if err != nil {
		return "", err
	}
	if u.HomeDir == "" {
		return "", errors.New("could not determine home directory")
	}
	return filepath.Clean(u.HomeDir), nil
}

// ShellPath returns the shell used for sessions.
func ShellPath() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	return "/bin/bash"
}

// Home returns the user's home directory.
func Home() (string, error) {
	return homeDir()
}
