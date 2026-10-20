// Package installto installs a Suwu binary onto a remote machine over SSH.
//
// `suwu install-to <user>@<host>` dials the destination with the local ssh
// agent / default keys (or a password prompt on a terminal), refuses to
// transfer anything unless the remote platform matches this binary, uploads
// the binary into ~/.local/bin over SFTP, and then starts the remote onboarding
// wizard with the SSH session attached to this terminal. When the wizard ends
// — or on any error — the SSH connection is closed and the process exits.
package installto

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/term"
)

const (
	defaultPort   = 22
	dialTimeout   = 20 * time.Second
	remoteBinDir  = ".local/bin"
	remoteBinName = "suwu"
)

// Options configures one install run.
type Options struct {
	// User and Host are the SSH target (`<user>@<host>`).
	User string
	Host string
	// Port is the SSH port (default 22).
	Port int
	// Identity is an optional private key file path. When empty the ssh-agent
	// and ~/.ssh/id_* defaults are tried.
	Identity string
	// Password, when set, is used for password auth without prompting
	// (CI/tests). Otherwise a terminal prompts for it.
	Password string
	// BinaryPath is the local file to install (default: the running binary).
	BinaryPath string
	// Command is run on the remote after the upload (default: ["onboard"]).
	Command []string
	// Stdin/Stdout/Stderr are attached to the remote command. Defaults are
	// os.Stdin/os.Stdout/os.Stderr.
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

func (o *Options) applyDefaults() {
	if o.Port == 0 {
		o.Port = defaultPort
	}
	if o.BinaryPath == "" {
		if exe, err := os.Executable(); err == nil {
			o.BinaryPath = exe
		}
	}
	if len(o.Command) == 0 {
		o.Command = []string{"onboard"}
	}
	if o.Stdin == nil {
		o.Stdin = os.Stdin
	}
	if o.Stdout == nil {
		o.Stdout = os.Stdout
	}
	if o.Stderr == nil {
		o.Stderr = os.Stderr
	}
}

// Run connects to the destination, verifies the platform, installs the binary
// and starts the remote command. The SSH connection is always closed before it
// returns.
func Run(ctx context.Context, opts Options) error {
	opts.applyDefaults()
	if opts.User == "" || opts.Host == "" {
		return errors.New("target must be <user>@<host>")
	}
	if opts.BinaryPath == "" {
		return errors.New("could not locate the running binary")
	}

	label := fmt.Sprintf("%s@%s:%d", opts.User, opts.Host, opts.Port)
	fmt.Fprintf(opts.Stdout, "Connecting to %s …\n", label)
	client, err := dial(ctx, opts)
	if err != nil {
		return err
	}
	defer func() {
		_ = client.Close()
		fmt.Fprintln(opts.Stdout, "SSH session closed.")
	}()
	fmt.Fprintln(opts.Stdout, "Connected.")

	// Platform check: never push a binary the remote cannot run.
	remotePlatform, err := remotePlatform(client)
	if err != nil {
		return fmt.Errorf("read remote platform: %w", err)
	}
	if !platformMatches(remotePlatform, runtime.GOOS, runtime.GOARCH) {
		return fmt.Errorf(
			"platform mismatch: this binary is %s/%s but %s is %s — nothing was transferred",
			runtime.GOOS, runtime.GOARCH, label, remotePlatform,
		)
	}
	fmt.Fprintf(opts.Stdout, "Remote platform %s matches this binary.\n", remotePlatform)

	remoteBin, err := uploadBinary(client, opts, label)
	if err != nil {
		return err
	}

	return runRemoteCommand(client, opts, remoteBin)
}

// ── dial + auth ────────────────────────────────────────────────────────

// dial opens the SSH connection. Host keys are not verified against a
// known_hosts file (the fingerprints the terminal shows are advisory, matching
// the SFTP tile); the credential check is the key/password handshake itself.
func dial(ctx context.Context, opts Options) (*ssh.Client, error) {
	methods, err := authMethods(opts)
	if err != nil {
		return nil, err
	}
	config := &ssh.ClientConfig{
		User:            opts.User,
		Auth:            methods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec // no known_hosts store; see doc comment
		Timeout:         dialTimeout,
	}
	addr := net.JoinHostPort(opts.Host, fmt.Sprintf("%d", opts.Port))
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
	return ssh.NewClient(sshConn, chans, reqs), nil
}

// authMethods builds the offered auth methods: the optional identity file (or
// the agent and ~/.ssh defaults), then a password callback that prompts on a
// terminal when nothing else worked.
func authMethods(opts Options) ([]ssh.AuthMethod, error) {
	var signers []ssh.Signer
	if opts.Identity != "" {
		s, err := loadIdentity(opts.Identity, opts)
		if err != nil {
			return nil, err
		}
		signers = append(signers, s)
	} else {
		signers = append(signers, agentSigners()...)
		signers = append(signers, defaultSigners(opts)...)
	}

	var methods []ssh.AuthMethod
	if len(signers) > 0 {
		methods = append(methods, ssh.PublicKeys(signers...))
	}
	if opts.Password != "" {
		methods = append(methods, ssh.Password(opts.Password))
	} else if isTerminal(opts.Stdin) {
		methods = append(methods, ssh.KeyboardInteractive(func(_ string, _ string, _ []string, _ []bool) ([]string, error) {
			pw, err := promptPassword(opts, opts.User+"@"+opts.Host+"'s password: ")
			if err != nil {
				return nil, err
			}
			return []string{pw}, nil
		}))
	}
	if len(methods) == 0 {
		return nil, errors.New("no SSH credentials available (no key, no agent, and stdin is not a terminal for a password prompt)")
	}
	return methods, nil
}

// agentSigners loads key identities from the running ssh-agent, if any.
func agentSigners() []ssh.Signer {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return nil
	}
	signers, err := agent.NewClient(conn).Signers()
	if err != nil {
		_ = conn.Close()
		return nil
	}
	return signers
}

// defaultSigners tries the standard unencrypted key files in ~/.ssh.
func defaultSigners(opts Options) []ssh.Signer {
	home := homeDir()
	if home == "" {
		return nil
	}
	var out []ssh.Signer
	for _, name := range []string{"id_ed25519", "id_ecdsa", "id_rsa"} {
		if s, err := loadIdentity(filepath.Join(home, ".ssh", name), opts); err == nil {
			out = append(out, s)
		}
	}
	return out
}

func loadIdentity(file string, opts Options) (ssh.Signer, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	signer, err := ssh.ParsePrivateKey(data)
	if err == nil {
		return signer, nil
	}
	var missing *ssh.PassphraseMissingError
	if errors.As(err, &missing) && isTerminal(opts.Stdin) {
		passphrase, promptErr := promptPassword(opts, fmt.Sprintf("Passphrase for %s: ", file))
		if promptErr != nil {
			return nil, promptErr
		}
		return ssh.ParsePrivateKeyWithPassphrase(data, []byte(passphrase))
	}
	return nil, err
}

func promptPassword(opts Options, prompt string) (string, error) {
	fmt.Fprint(opts.Stderr, prompt)
	file, ok := opts.Stdin.(*os.File)
	if !ok || !term.IsTerminal(int(file.Fd())) {
		return "", errors.New("stdin is not a terminal; use an ssh-agent key or --identity")
	}
	pw, err := term.ReadPassword(int(file.Fd()))
	fmt.Fprintln(opts.Stderr)
	if err != nil {
		return "", err
	}
	return string(pw), nil
}

func isTerminal(r io.Reader) bool {
	file, ok := r.(*os.File)
	return ok && term.IsTerminal(int(file.Fd()))
}

// ── platform check ─────────────────────────────────────────────────────

// remotePlatform runs `uname -sm` on the destination.
func remotePlatform(client *ssh.Client) (string, error) {
	out, err := runCommand(client, "uname -sm")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// platformMatches compares `uname -sm` output with the local GOOS/GOARCH. A
// single-field remote value is treated as architecture only.
func platformMatches(remote, goos, goarch string) bool {
	fields := strings.Fields(remote)
	if len(fields) == 0 {
		return false
	}
	if len(fields) >= 2 {
		if !strings.EqualFold(fields[0], goos) {
			return false
		}
		return normalizeArch(fields[1]) == normalizeArch(goarch)
	}
	return normalizeArch(fields[0]) == normalizeArch(goarch)
}

// normalizeArch maps Go arch names and uname machine names onto one canonical
// family ("amd64" and "x86_64" are the same machine, as are "arm64" and
// "aarch64").
func normalizeArch(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "x86_64", "amd64", "x64":
		return "x86_64"
	case "aarch64", "arm64":
		return "arm64"
	case "i386", "i486", "i586", "i686", "x86", "386":
		return "x86"
	case "armv4", "armv5", "armv6", "armv7", "armv6l", "armv7l", "armhf", "armel", "armle", "arm":
		return "arm"
	default:
		return strings.ToLower(strings.TrimSpace(s))
	}
}

// ── upload ─────────────────────────────────────────────────────────────

// uploadBinary copies the local binary into ~/.local/bin on the remote,
// atomically (write to a temp name, chmod 0755, rename over the target), and
// returns the final remote path.
func uploadBinary(client *ssh.Client, opts Options, label string) (string, error) {
	home, err := remoteHome(client)
	if err != nil {
		return "", fmt.Errorf("read remote home: %w", err)
	}
	dir := path.Join(home, remoteBinDir)
	target := path.Join(dir, remoteBinName)

	info, err := os.Stat(opts.BinaryPath)
	if err != nil {
		return "", fmt.Errorf("local binary: %w", err)
	}

	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		return "", fmt.Errorf("open sftp: %w", err)
	}
	defer func() { _ = sftpClient.Close() }()

	if err := sftpClient.MkdirAll(dir); err != nil {
		return "", fmt.Errorf("create %s on %s: %w", dir, label, err)
	}
	fmt.Fprintf(opts.Stdout, "Uploading %s (%s) → %s …\n",
		filepath.Base(opts.BinaryPath), humanBytes(info.Size()), target)

	src, err := os.Open(opts.BinaryPath)
	if err != nil {
		return "", fmt.Errorf("open local binary: %w", err)
	}
	defer func() { _ = src.Close() }()

	tmp := path.Join(dir, "."+remoteBinName+".install.tmp")
	w, err := sftpClient.Create(tmp)
	if err != nil {
		return "", fmt.Errorf("create remote file: %w", err)
	}
	if _, err := io.Copy(w, src); err != nil {
		_ = w.Close()
		_ = sftpClient.Remove(tmp)
		return "", fmt.Errorf("transfer: %w", err)
	}
	if err := w.Close(); err != nil {
		_ = sftpClient.Remove(tmp)
		return "", fmt.Errorf("finish remote file: %w", err)
	}
	if err := sftpClient.Chmod(tmp, 0o755); err != nil {
		_ = sftpClient.Remove(tmp)
		return "", fmt.Errorf("make executable: %w", err)
	}
	// Rename over an existing target: some servers refuse, so clear it first.
	if err := sftpClient.Rename(tmp, target); err != nil {
		if rmErr := sftpClient.Remove(target); rmErr != nil {
			_ = sftpClient.Remove(tmp)
			return "", fmt.Errorf("replace %s: %w", target, err)
		}
		if err := sftpClient.Rename(tmp, target); err != nil {
			_ = sftpClient.Remove(tmp)
			return "", fmt.Errorf("replace %s: %w", target, err)
		}
	}
	fmt.Fprintf(opts.Stdout, "Installed %s.\n", target)
	return target, nil
}

// remoteHome asks the destination for $HOME.
func remoteHome(client *ssh.Client) (string, error) {
	out, err := runCommand(client, `printf %s "$HOME"`)
	if err != nil {
		return "", err
	}
	home := strings.TrimSpace(out)
	if home == "" || !strings.HasPrefix(home, "/") {
		return "", fmt.Errorf("unexpected home directory %q", home)
	}
	return strings.TrimSuffix(home, "/"), nil
}

// ── remote command ─────────────────────────────────────────────────────

// runRemoteCommand runs the post-install command with the SSH session attached
// to the local terminal (PTY, raw mode), so the interactive wizard runs as if
// on the machine itself.
func runRemoteCommand(client *ssh.Client, opts Options, remoteBin string) error {
	parts := []string{posixQuote(remoteBin)}
	for _, arg := range opts.Command {
		parts = append(parts, posixQuote(arg))
	}
	cmdline := strings.Join(parts, " ")

	sess, err := client.NewSession()
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	defer func() { _ = sess.Close() }()

	sess.Stdin = opts.Stdin
	sess.Stdout = opts.Stdout
	sess.Stderr = opts.Stderr

	rows, cols := 24, 80
	if file, ok := opts.Stdin.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		if h, w, sizeErr := term.GetSize(int(file.Fd())); sizeErr == nil {
			rows, cols = h, w
		}
	}
	if err := sess.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}); err != nil {
		fmt.Fprintf(opts.Stderr, "warning: remote PTY unavailable: %v\n", err)
	}

	// Raw local terminal so the remote TUI receives keys unbuffered.
	if file, ok := opts.Stdin.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		oldState, rawErr := term.MakeRaw(int(file.Fd()))
		if rawErr == nil {
			defer func() { _ = term.Restore(int(file.Fd()), oldState) }()
		}
	}

	fmt.Fprintf(opts.Stdout, "Starting on %s: %s\n", opts.Host, cmdline)
	if err := sess.Run(cmdline); err != nil {
		return fmt.Errorf("remote command failed: %w", err)
	}
	return nil
}

// runCommand runs a one-shot command and returns its trimmed output.
func runCommand(client *ssh.Client, cmd string) (string, error) {
	sess, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer func() { _ = sess.Close() }()
	out, err := sess.CombinedOutput(cmd)
	if err != nil {
		return "", fmt.Errorf("%s: %w: %s", cmd, err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// ── helpers ────────────────────────────────────────────────────────────

// ParseTarget splits `<user>@<host>` (the split is at the last "@", so a
// bracketed IPv6 host such as user@[::1] works).
func ParseTarget(target string) (user, host string, err error) {
	target = strings.TrimSpace(target)
	idx := strings.LastIndex(target, "@")
	if idx <= 0 || idx == len(target)-1 {
		return "", "", fmt.Errorf("target must be <user>@<host>, got %q", target)
	}
	user = target[:idx]
	host = strings.TrimSuffix(strings.TrimPrefix(target[idx+1:], "["), "]")
	if strings.ContainsAny(host, " \t") || strings.ContainsAny(user, " \t") {
		return "", "", fmt.Errorf("target must be <user>@<host>, got %q", target)
	}
	return user, host, nil
}

// posixQuote wraps a value in single quotes for the remote shell.
func posixQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func homeDir() string {
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	return os.Getenv("HOME")
}

// humanBytes renders a byte count for progress messages.
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGT"[exp])
}
