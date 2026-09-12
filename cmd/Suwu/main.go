// Command suwu is the standalone Suwu terminal server. It serves a full
// terminal emulator in the browser, backed by a real shell PTY over
// WebSocket, protected by a per-run same-origin token.
//
// Usage:
//
//	suwu help           # show this help
//	suwu serve          # run the server (reads SUWU_DEV from .env)
//	suwu gencerts       # interactive TLS certificate generation (local CA)
//	suwu version        # print version and exit
//	suwu onboard        # interactive setup wizard
//	suwu daemon {start|stop|restart|status|logs}  # manage background server
//
//	SERVER_MODE=http HTTP_PORT=3000 suwu serve   # plain HTTP on a custom port
//	HOST=0.0.0.0 suwu serve                     # bind all interfaces
//
// SUWU_DEV=true in the .env file enables the dev banner and air rebuild
// message. Configuration is resolved in order of precedence:
// shell environment, then ./.env (project), then ~/.config/suwu/.env
// (user-global, written by 'suwu gencerts'). TLS certificates come from
// TLS_CERT_FILE/TLS_KEY_FILE when set, falling back to the default pair
// 'suwu gencerts' writes into ~/.config/suwu/.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"suwu/pkg/assets"
	"suwu/pkg/auth"
	"suwu/pkg/certs"
	"suwu/pkg/envfile"
	"suwu/pkg/forward"
	"suwu/pkg/gencerts"
	"suwu/pkg/logging"
	"suwu/pkg/notify"
	"suwu/pkg/pty"
	"suwu/pkg/server"
	"suwu/pkg/session"
	"suwu/pkg/version"
	"suwu/pkg/xdisplay"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "serve":
			os.Args = append([]string{os.Args[0]}, os.Args[2:]...)
			serveMain()
			return
		case "gencerts":
			if err := gencerts.Run(os.Args[2:]); err != nil {
				if errors.Is(err, gencerts.ErrAborted) {
					return
				}
				log.Fatalf("gencerts: %v", err)
			}
			return
		case "help", "-h", "--help":
			if len(os.Args) > 2 {
				printSubcommandHelp(os.Args[2])
			} else {
				printUsage()
			}
			return
		case "version", "-v", "--version":
			fmt.Printf("suwu %s\n", version.Version)
			return
		case "onboard":
			if err := onboard(); err != nil {
				log.Fatalf("onboard: %v", err)
			}
			return
		case "daemon":
			if err := daemon(os.Args[2:]); err != nil {
				log.Fatalf("daemon: %v", err)
			}
			return
		case "send":
			if err := sendMsg(os.Args[2:]); err != nil {
				log.Fatalf("send: %v", err)
			}
			return
		case "open":
			if err := openMain(os.Args[2:]); err != nil {
				log.Fatalf("open: %v", err)
			}
			return
		case "gitgraph":
			if err := gitgraphMain(os.Args[2:]); err != nil {
				log.Fatalf("gitgraph: %v", err)
			}
			return
		case "diff":
			if err := diffMain(os.Args[2:]); err != nil {
				log.Fatalf("diff: %v", err)
			}
			return
		case "forward":
			if err := forwardCmd(os.Args[2:]); err != nil {
				log.Fatalf("forward: %v", err)
			}
			return
		case "upgrade":
			if err := upgradeCmd(os.Args[2:]); err != nil {
				log.Fatalf("upgrade: %v", err)
			}
			return
		case "use":
			if err := useCmd(os.Args[2:]); err != nil {
				log.Fatalf("use: %v", err)
			}
			return
		default:
			// Unknown subcommand: if it looks like a flag, assume
			// the user forgot "serve" and try to run the server.
			if !strings.HasPrefix(os.Args[1], "-") {
				printUsage()
				return
			}
			serveMain()
			return
		}
	}
	printUsage()
}

func printUsage() {
	fmt.Print(`Suwu — browser terminal emulator backed by a real shell PTY.

Usage:
  suwu help                show this help
  suwu serve [--env-file <path>]
                           run the server (reads SUWU_DEV from .env)
                           [--env-file] project .env path (default .env);
                           when explicitly set, the global env is skipped
  suwu send [--sock <path>] [<message>]
                           send a notification to the running server;
                           reads from stdin if no message is given
                           (e.g. cat log | suwu send)
  suwu open [--sock <path>] <path>
                           open a file or directory in the running Suwu session
  suwu gitgraph [--sock <path>] <dir>
                           open git graph for a repository directory
  suwu diff [--sock <path>] <file1> <file2>
                           open a side-by-side diff view between two files
  suwu forward [flags] <localport> [targethost] <targetport>
                           create TCP/UDP port forwarding through the server
  suwu gencerts [--hosts <list>] [--out <dir>] [--no-env] [--force]
                           generate a TLS certificate pair (interactive by default)
  suwu version             print version and exit
  suwu onboard             interactive setup wizard: server, security, tools
  suwu daemon {start|stop|restart|status|logs}
                           manage a background daemon (default data: ~/.suwu)
  suwu upgrade [--check] [--force]
                           check for updates and upgrade if available
  suwu use [--sock <path>] <command> [args...]
                           run command with DISPLAY set to available X display

Configuration precedence:
  --env-file explicitly given → that file only
  --env-file default (empty) → ./.env → ~/.config/suwu/.env → defaults
  SUWU_DEV=true              → ./.env only (global skipped)
TLS: TLS_CERT_FILE/TLS_KEY_FILE, else the default pair in ~/.config/suwu/
HTTP: SERVER_MODE selects https, http, or https+http; HTTPS_PORT defaults to 8181 and HTTP_PORT to 8180.
`)
}

func printSubcommandHelp(cmd string) {
	switch cmd {
	case "serve":
		fmt.Print(`Usage: suwu serve [flags]

Run the Suwu terminal server.

Flags:
  --env-file <path>    Path to a .env file to load (default .env;
                       when explicitly set, the global env is skipped)

Environment variables:
  SERVER_MODE          https, http, or https+http (default https)
  HTTPS_PORT           HTTPS listener port (default 8181)
  HTTP_PORT            HTTP listener port (default 8180)
  HOST                 Bind address (default 127.0.0.1)
  EXTRA_HOSTS          Comma-separated extra hostnames/IPs to allow, e.g.
                       EXTRA_HOSTS=example.com,*.example.net
                       Supports wildcards: * (all), *.example.com, example.*
  AUTH_PASS            SHA-256 hash of the required web access password;
                       configured by 'suwu onboard'
  SESSION_TTL          Idle session timeout (default 24h, e.g. 30m, 12h)
  SUWU_DEV=true        Enable the dev banner and air rebuild message
  SUWU_LOG_LEVEL       Log level: debug, info, warn, error (default: error)
  TLS_CERT_FILE        TLS certificate file path
  TLS_KEY_FILE         TLS key file path
  SUWU_SOCK_PATH       Unix socket path (default ~/.suwu/suwu.sock)

Server modes:
  https (default)      HTTPS only; certs are required.
  http                 HTTP only; certificates are not needed.
  https+http           HTTPS and HTTP at the same time; certs are required.

Examples:
  suwu serve                                      # HTTPS on :8181
  SERVER_MODE=http suwu serve                    # HTTP on :8180
  SERVER_MODE=http HTTP_PORT=9090 suwu serve     # HTTP on :9090
  SERVER_MODE=https+http suwu serve              # HTTPS :8181 + HTTP :8180
  suwu serve --env-file /path/to/.env
`)
	case "send":
		fmt.Print(`Usage: suwu send [flags] [<message>]

Send a notification to the running Suwu server. The message is displayed
in the browser notification panel. Reads from stdin if no message is given.

Flags:
  --sock <path>    Path to the notify socket (default ~/.suwu/suwu.sock,
                   or $SUWU_SOCK_PATH)

Examples:
  suwu send "Hello from CLI"
  echo "build complete" | suwu send
  cat log.txt | suwu send
`)
	case "open":
		fmt.Print(`Usage: suwu open [flags] <path>

Open a file or directory in the running Suwu session. Sends a notification
to the browser which can open the file in the file browser or viewer.

Flags:
  --sock <path>    Path to the notify socket (default ~/.suwu/suwu.sock,
                   or $SUWU_SOCK_PATH)

Examples:
  suwu open /home/user/project
  suwu open ~/Documents/report.pdf
`)
	case "forward":
		fmt.Print(`Usage: suwu forward [flags] <localport> [targethost] <targetport>

Create TCP/UDP port forwarding through the running Suwu server.
The server must be running for this command to work.

Flags:
  --proto <tcp|udp>    Protocol (default tcp)
  --stop <port>        Stop forward by local port
  --list               List all active forwards
  --sock <path>        Path to the notify socket (default ~/.suwu/suwu.sock)

Examples:
  suwu forward 23000 localhost 3000
  suwu forward 23000 192.168.1.10 3000
  suwu forward --proto udp 23000 localhost 3000
  suwu forward --stop 23000
  suwu forward --list
`)
	case "diff":
		fmt.Print(`Usage: suwu diff [flags] <file1> <file2>

Open a side-by-side diff view between two files in the browser.
Sends a notification to the running server which opens a diff tile.

Flags:
  --sock <path>    Path to the notify socket (default ~/.suwu/suwu.sock,
                   or $SUWU_SOCK_PATH)

Examples:
  suwu diff old.go new.go
  suwu diff ~/project/v1.go ~/project/v2.go
`)
	case "gencerts":
		fmt.Print(`Usage: suwu gencerts [flags]

Generate a TLS certificate pair for HTTPS access. Creates a local CA
and signs a leaf certificate for your machine.

Flags:
  --hosts <list>    Comma-separated list of hostnames/IPs
  --out <dir>       Output directory (default ~/.config/suwu/)
  --no-env          Don't write cert paths to ~/.config/suwu/.env
  --force           Overwrite existing certificates

Examples:
  suwu gencerts
  suwu gencerts --hosts localhost,192.168.1.100
  suwu gencerts --out /tmp/certs
`)
	case "onboard":
		fmt.Print(`Usage: suwu onboard

Interactive setup wizard. Requires an attached terminal and collects the
complete setup plan before making changes. Configures:
  - Server profile, bind host, ports, and session timeout
  - Required connection password
  - TLS certificates for HTTPS modes
  - Data directory and optional systemd service
  - Essential and advanced development tools
  - Optional shell integration

No non-interactive onboarding mode is provided.
`)
	case "daemon":
		fmt.Print(`Usage: suwu daemon <command>

Manage a background Suwu server daemon.

Commands:
  start       Start the daemon (systemd or embedded script)
  stop        Stop the daemon
  restart     Restart the daemon
  status      Show daemon status
  logs        Follow daemon logs
  install     Install systemd user service (if available)
  uninstall   Remove systemd user service

When a systemd user service is installed, start/stop/restart/status/logs
are delegated to systemctl --user / journalctl --user automatically.

Examples:
  suwu daemon start
  suwu daemon status
  suwu daemon logs
  suwu daemon install
`)
	case "upgrade":
		fmt.Print(`Usage: suwu upgrade [flags]

Check for updates and upgrade the binary if a newer version is available.
If the daemon is running, it will be stopped before the upgrade and
restarted afterwards.

Flags:
  --check     Check for updates without downloading or upgrading
  --force     Re-download even if already up to date

Examples:
  suwu upgrade
  suwu upgrade --check
  suwu upgrade --force
`)
	case "use":
		fmt.Print(`Usage: suwu use [--sock <path>] <command> [args...]

Run a command with DISPLAY set to an available X display.
Shows a TUI to select which display to use.

Flags:
  --sock <path>    Path to the notify socket (default ~/.suwu/suwu.sock)

Examples:
  suwu use chromium --new-window https://www.google.com
  suwu use firefox
  suwu use xterm
`)
	default:
		fmt.Printf("Unknown subcommand: %s\nRun 'suwu help' for usage.\n", cmd)
	}
}

func serveMain() {
	logging.Init()

	envFile := flag.String("env-file", "", "path to a .env file to load (default .env; when explicitly set, the global env is skipped)")
	flag.Parse()

	logging.Debug("pre-env state",
		slog.String("env-file-flag", *envFile),
		slog.String("SUWU_DEV", os.Getenv("SUWU_DEV")),
		slog.String("SERVER_MODE", os.Getenv("SERVER_MODE")),
		slog.String("HTTPS_PORT", os.Getenv("HTTPS_PORT")),
		slog.String("HTTP_PORT", os.Getenv("HTTP_PORT")),
		slog.String("HOST", os.Getenv("HOST")),
		slog.String("SUWU_LOG_LEVEL", os.Getenv("SUWU_LOG_LEVEL")),
	)

	// Resolve the project env file: explicit --env-file wins, else .env.
	projectEnv := *envFile
	if projectEnv == "" {
		projectEnv = ".env"
	}

	if *envFile != "" {
		logging.Debug("loading project env (explicit --env-file, overrides existing)",
			slog.String("path", projectEnv),
		)
		if err := envfile.LoadForce(projectEnv); err != nil {
			log.Fatalf("envfile: %v", err)
		}
	} else {
		logging.Debug("loading project env",
			slog.String("path", projectEnv),
		)
		if err := envfile.Load(projectEnv); err != nil {
			log.Fatalf("envfile: %v", err)
		}
	}
	logging.Debug("after project env",
		slog.String("SUWU_DEV", os.Getenv("SUWU_DEV")),
		slog.String("SERVER_MODE", os.Getenv("SERVER_MODE")),
		slog.String("HTTPS_PORT", os.Getenv("HTTPS_PORT")),
		slog.String("HTTP_PORT", os.Getenv("HTTP_PORT")),
		slog.String("HOST", os.Getenv("HOST")),
		slog.String("SUWU_LOG_LEVEL", os.Getenv("SUWU_LOG_LEVEL")),
	)

	// Load the user-global ~/.config/suwu/.env only when no explicit
	// --env-file was given and SUWU_DEV is not set.
	if *envFile == "" && os.Getenv("SUWU_DEV") != "true" {
		if dir, err := certs.DefaultDir(); err == nil {
			globalEnv := filepath.Join(dir, ".env")
			logging.Debug("loading global env",
				slog.String("path", globalEnv),
			)
			if err := envfile.Load(globalEnv); err != nil {
				log.Fatalf("envfile: %v", err)
			}
			logging.Debug("after global env",
				slog.String("SUWU_DEV", os.Getenv("SUWU_DEV")),
				slog.String("SERVER_MODE", os.Getenv("SERVER_MODE")),
				slog.String("HTTPS_PORT", os.Getenv("HTTPS_PORT")),
				slog.String("HTTP_PORT", os.Getenv("HTTP_PORT")),
				slog.String("HOST", os.Getenv("HOST")),
				slog.String("SUWU_LOG_LEVEL", os.Getenv("SUWU_LOG_LEVEL")),
			)
		}
	} else {
		logging.Debug("skipping global env",
			slog.Bool("env-file-explicit", *envFile != ""),
			slog.String("SUWU_DEV", os.Getenv("SUWU_DEV")),
		)
	}

	// Re-init logger now that SUWU_LOG_LEVEL is loaded from env.
	logging.Reinit()

	slog.Info("env loaded",
		"SUWU_DEV", os.Getenv("SUWU_DEV"),
		"SERVER_MODE", os.Getenv("SERVER_MODE"),
		"HTTPS_PORT", os.Getenv("HTTPS_PORT"),
		"HTTP_PORT", os.Getenv("HTTP_PORT"),
		"HOST", os.Getenv("HOST"),
		"SUWU_LOG_LEVEL", os.Getenv("SUWU_LOG_LEVEL"),
	)

	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	dev := os.Getenv("SUWU_DEV") == "true"
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("SERVER_MODE")))
	if mode == "" {
		mode = "https"
	}
	if mode != "https" && mode != "http" && mode != "https+http" {
		return fmt.Errorf("invalid SERVER_MODE %q: must be https, http, or https+http", mode)
	}

	var httpsPort, httpPort int
	if mode == "https" || mode == "https+http" {
		httpsPort = parsePort(os.Getenv("HTTPS_PORT"), 8181, "HTTPS_PORT")
	}
	if mode == "http" || mode == "https+http" {
		httpPort = parsePort(os.Getenv("HTTP_PORT"), 8180, "HTTP_PORT")
	}
	if mode == "https+http" && httpsPort == httpPort {
		return fmt.Errorf("HTTPS_PORT and HTTP_PORT must be different when SERVER_MODE=https+http")
	}

	cfg, err := auth.CreateConfig(nil)
	if err != nil {
		return err
	}

	// Assets are always embedded: dev hot reload (air) rebuilds the web tree
	// and the binary together before restarting.
	sub, err := fs.Sub(assets.FS, "web")
	if err != nil {
		return err
	}

	// Keyed PTY sessions with server-side terminal state (libghostty-vt), so
	// a browser refresh reattaches to the same shell with its screen intact.
	// Closed explicitly on every exit path below (no defer): a wedged close
	// must not depend on unwinding order.
	sessions, err := session.NewManager()
	if err != nil {
		return err
	}

	// SESSION_TTL overrides the default idle session timeout (24h).
	if ttlStr := os.Getenv("SESSION_TTL"); ttlStr != "" {
		if d, err := time.ParseDuration(ttlStr); err == nil && d > 0 {
			sessions.SetTTL(d)
		} else {
			slog.Warn("invalid SESSION_TTL, using default", "value", ttlStr, "error", err)
		}
	}

	notifySock, err := notify.SocketPath()
	if err != nil {
		sessions.Close()
		return err
	}
	notifyListener, err := notify.NewListener(notifySock)
	if err != nil {
		sessions.Close()
		return fmt.Errorf("notify listener: %w", err)
	}

	forwardManager := forward.NewManager()
	registerForwardHandlers(notifyListener, forwardManager)
	registerXDisplayHandlers(notifyListener)

	// Data directory (default ~/.suwu, override with SUWU_VAR).
	dataDir := os.Getenv("SUWU_VAR")
	if dataDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			dataDir = filepath.Join(home, ".suwu")
		}
	}

	srv := server.New(cfg, sub, sessions, notifyListener, forwardManager, dataDir)

	handler := srv.Handler()

	// Resolve TLS certificates only for modes that serve HTTPS. HTTP-only mode
	// deliberately does not require certificates to exist.
	var certFile, keyFile, tlsSource string
	if mode == "https" || mode == "https+http" {
		certFile, keyFile, tlsSource, err = resolveTLS()
		if err != nil {
			sessions.Close()
			return fmt.Errorf("SERVER_MODE=%s requires TLS certificates: %w\nhint: run 'suwu gencerts' to create a certificate pair, or use SERVER_MODE=http for plain HTTP", mode, err)
		}
	}

	// Build the list of servers to start.
	var listeners []srvListener

	if mode == "https" || mode == "https+http" {
		listeners = append(listeners, srvListener{
			server: &http.Server{Addr: net.JoinHostPort(cfg.BindHost, strconv.Itoa(httpsPort)), Handler: handler},
			useTLS: true,
			port:   httpsPort,
			source: tlsSource,
		})
	}
	if mode == "http" || mode == "https+http" {
		listeners = append(listeners, srvListener{
			server: &http.Server{Addr: net.JoinHostPort(cfg.BindHost, strconv.Itoa(httpPort)), Handler: handler},
			useTLS: false,
			port:   httpPort,
			source: "SERVER_MODE",
		})
	}

	errCh := make(chan error, 1)
	for _, l := range listeners {
		l := l
		go func() {
			var err error
			if l.useTLS {
				err = l.server.ListenAndServeTLS(certFile, keyFile)
			} else {
				err = l.server.ListenAndServe()
			}
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- err
			}
		}()
	}

	printBanner(dev, cfg, listeners)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-errCh:
		sessions.Close()
		return fmt.Errorf("%w\nhint: another server may already be running; check HTTPS_PORT and HTTP_PORT",
			err)
	case <-ctx.Done():
	}

	fmt.Println("\n\nShutting down...")
	// Watchdog: air (dev) waits for this process to exit before it can
	// rebuild and restart. A wedged close (PTY, WASM runtime, socket) must
	// never block that hand-off, so force the exit after a short grace
	// period no matter what the graceful path below is doing.
	go func() {
		time.Sleep(5 * time.Second)
		fmt.Println("  shutdown exceeded 5s; forcing exit")
		os.Exit(0)
	}()
	xdisplay.StopDisplay() // kill Xorg first — don't orphan it
	server.CloseAll()
	sessions.Close()
	notifyListener.Close()
	forwardManager.StopAll()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3_000_000_000)
	defer cancel()
	for _, l := range listeners {
		_ = l.server.Shutdown(shutdownCtx)
	}
	return nil
}

// resolveTLS decides which certificate pair the server should use.
// Precedence: TLS_CERT_FILE/TLS_KEY_FILE from the environment chain, then
// the default pair 'suwu gencerts' writes into the suwu config directory.
func resolveTLS() (certFile, keyFile, source string, err error) {
	envCert, envKey := os.Getenv("TLS_CERT_FILE"), os.Getenv("TLS_KEY_FILE")
	if envCert != "" || envKey != "" {
		if envCert == "" || envKey == "" {
			return "", "", "", errors.New("TLS_CERT_FILE and TLS_KEY_FILE must be set together")
		}
		certFile, err := certs.ExpandPath(envCert)
		if err != nil {
			return "", "", "", err
		}
		keyFile, err := certs.ExpandPath(envKey)
		if err != nil {
			return "", "", "", err
		}
		pairs := []struct{ path, label string }{
			{certFile, "TLS_CERT_FILE"},
			{keyFile, "TLS_KEY_FILE"},
		}
		for _, p := range pairs {
			if _, err := os.Stat(p.path); err != nil {
				return "", "", "", fmt.Errorf("%s: %v\nhint: run 'suwu gencerts' to create a certificate pair", p.label, err)
			}
		}
		return certFile, keyFile, "TLS_CERT_FILE/TLS_KEY_FILE", nil
	}

	configDir, err := certs.DefaultDir()
	if err != nil {
		return "", "", "", fmt.Errorf("cannot determine config directory: %w", err)
	}
	certPath, keyPath := certs.PairPaths(configDir)
	if _, err := os.Stat(certPath); err != nil {
		return "", "", "", fmt.Errorf("no certificates found in %s: %w\nhint: run 'suwu gencerts' to create a certificate pair", configDir, err)
	}
	if _, err := os.Stat(keyPath); err != nil {
		return "", "", "", fmt.Errorf("no key found in %s: %w\nhint: run 'suwu gencerts' to create a certificate pair", configDir, err)
	}
	return certPath, keyPath, "~/.config/suwu", nil
}

func parsePort(value string, def int, name string) int {
	if value == "" {
		return def
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 || n > 65535 {
		log.Fatalf("%s must be an integer from 1 to 65535: %v", name, value)
	}
	return n
}

func formatURLHost(host string) string {
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		return "[" + host + "]"
	}
	return host
}

// srvListener describes one HTTP or HTTPS server instance.
type srvListener struct {
	server *http.Server
	useTLS bool
	port   int
	source string
}

func printBanner(dev bool, cfg *auth.Config, listeners []srvListener) {
	home, _ := pty.Home()

	fmt.Println("\n" + strings.Repeat("═", 60))
	fmt.Printf("  🚀 Suwu server%s\n", devLabel(dev))
	fmt.Println(strings.Repeat("═", 60))
	for _, l := range listeners {
		scheme := "http"
		if l.useTLS {
			scheme = "https"
		}
		fmt.Printf("\n  📺 Open: %s://%s:%d\n", scheme, formatURLHost(cfg.DisplayHost), l.port)
		if l.useTLS {
			fmt.Printf("  🔒 TLS enabled (certs from %s): browser clipboard APIs available\n", l.source)
		} else {
			fmt.Println("  📡 Plain HTTP: browser clipboard APIs unavailable outside localhost")
		}
	}
	fmt.Println("  📡 WebSocket PTY: same endpoint /ws")
	fmt.Println("  🔐 WebSocket auth: per-run same-origin token")
	fmt.Printf("  🐚 Shell: %s\n", pty.ShellPath())
	fmt.Printf("  📁 Home: %s\n", home)
	if dev {
		fmt.Println("  🔥 Dev mode: air rebuilds web + server and restarts on change")
	}
	fmt.Println("\n  ⚠️  This server provides shell access.")
	fmt.Printf("     It binds to %s and rejects cross-origin WebSockets.\n", cfg.BindHost)
	fmt.Printf("     Browser-visible hosts: this machine's own names and addresses.\n")
	if auth.IsWildcardBindHost(cfg.BindHost) || !auth.IsLoopbackHost(cfg.BindHost) {
		fmt.Println("     Binding beyond loopback exposes the shell to everyone who can reach this machine.")
	}
	fmt.Println("     Only use for local development.")
	fmt.Println(strings.Repeat("═", 60))
	fmt.Println("  Press Ctrl+C to stop.")
}

func devLabel(dev bool) string {
	if dev {
		return " (dev mode)"
	}
	return ""
}

func sendMsg(args []string) error {
	fs := flag.NewFlagSet("send", flag.ContinueOnError)
	sock := fs.String("sock", "", "path to the notify socket (default ~/.suwu/suwu.sock, or $SUWU_SOCK_PATH)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	sockPath, err := resolveSockPath(*sock)
	if err != nil {
		return err
	}

	// Positional args: send as a single message.
	if fs.NArg() > 0 {
		message := strings.Join(fs.Args(), " ")
		if err := notify.Send(sockPath, message); err != nil {
			return err
		}
		fmt.Printf("Sent: %s\n", message)
		return nil
	}

	// No args: read from stdin (pipe support).
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 256), 64*1024)
	var msgs []string
	for scanner.Scan() {
		msgs = append(msgs, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}
	if len(msgs) == 0 {
		return fmt.Errorf("usage: suwu send [--sock <path>] <message>\n       cat file | suwu send")
	}
	if err := notify.Send(sockPath, msgs...); err != nil {
		return err
	}
	fmt.Printf("Sent %d message(s)\n", len(msgs))
	return nil
}

// openAction is the JSON payload sent by `suwu open`.
type openAction struct {
	Action  string      `json:"action"`
	Payload openPayload `json:"payload"`
}

type openPayload struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

func openMain(args []string) error {
	fs := flag.NewFlagSet("open", flag.ContinueOnError)
	sock := fs.String("sock", "", "path to the notify socket (default ~/.suwu/suwu.sock, or $SUWU_SOCK_PATH)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if fs.NArg() == 0 {
		return fmt.Errorf("usage: suwu open [--sock <path>] <path>")
	}
	rawPath := fs.Args()[0]

	absPath, err := filepath.Abs(rawPath)
	if err != nil {
		return fmt.Errorf("resolve path: %w", err)
	}

	info, err := os.Stat(absPath)
	if err != nil {
		return fmt.Errorf("stat %s: %w", absPath, err)
	}

	pathType := "file"
	if info.IsDir() {
		pathType = "dir"
	}

	action := openAction{
		Action: "open",
		Payload: openPayload{
			Type: pathType,
			Path: absPath,
		},
	}

	data, err := json.Marshal(action)
	if err != nil {
		return fmt.Errorf("marshal action: %w", err)
	}

	sockPath, err := resolveSockPath(*sock)
	if err != nil {
		return err
	}

	// Send the full Notification JSON so handleConn parses it with Data.
	n := notify.Notification{
		Message: fmt.Sprintf("Open %s: %s", pathType, absPath),
		Data:    data,
	}
	nJSON, err := json.Marshal(n)
	if err != nil {
		return fmt.Errorf("marshal notification: %w", err)
	}

	if err := notify.Send(sockPath, string(nJSON)); err != nil {
		return err
	}
	fmt.Printf("Opened: %s (%s)\n", absPath, pathType)
	return nil
}

// gitgraphAction is the JSON payload sent by `suwu gitgraph`.
type gitgraphAction struct {
	Action  string          `json:"action"`
	Payload gitgraphPayload `json:"payload"`
}

type gitgraphPayload struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

func gitgraphMain(args []string) error {
	fs := flag.NewFlagSet("gitgraph", flag.ContinueOnError)
	sock := fs.String("sock", "", "path to the notify socket (default ~/.suwu/suwu.sock, or $SUWU_SOCK_PATH)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if fs.NArg() == 0 {
		return fmt.Errorf("usage: suwu gitgraph [--sock <path>] <dir>")
	}
	rawPath := fs.Args()[0]

	absPath, err := filepath.Abs(rawPath)
	if err != nil {
		return fmt.Errorf("resolve path: %w", err)
	}

	info, err := os.Stat(absPath)
	if err != nil {
		return fmt.Errorf("stat %s: %w", absPath, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", absPath)
	}

	action := gitgraphAction{
		Action: "gitgraph",
		Payload: gitgraphPayload{
			Type: "gitgraph",
			Path: absPath,
		},
	}

	data, err := json.Marshal(action)
	if err != nil {
		return fmt.Errorf("marshal action: %w", err)
	}

	sockPath, err := resolveSockPath(*sock)
	if err != nil {
		return err
	}

	n := notify.Notification{
		Message: fmt.Sprintf("Git Graph: %s", absPath),
		Data:    data,
	}
	nJSON, err := json.Marshal(n)
	if err != nil {
		return fmt.Errorf("marshal notification: %w", err)
	}

	if err := notify.Send(sockPath, string(nJSON)); err != nil {
		return err
	}
	fmt.Printf("Git Graph: %s\n", absPath)
	return nil
}

func resolveSockPath(flagVal string) (string, error) {
	if flagVal != "" {
		return certs.ExpandPath(flagVal)
	}
	return notify.SocketPath()
}

func registerForwardHandlers(l *notify.Listener, mgr *forward.Manager) {
	l.RegisterHandler("forward-start", func(cmd notify.Command) notify.CommandResponse {
		var req struct {
			LocalPort  int    `json:"localPort"`
			TargetHost string `json:"targetHost"`
			TargetPort int    `json:"targetPort"`
			Protocol   string `json:"protocol"`
		}
		if err := json.Unmarshal(cmd.Payload, &req); err != nil {
			return notify.CommandResponse{OK: false, Error: "invalid payload"}
		}
		if req.LocalPort < forward.MinPort || req.LocalPort > forward.MaxPort {
			return notify.CommandResponse{OK: false, Error: fmt.Sprintf("port must be between %d and %d", forward.MinPort, forward.MaxPort)}
		}
		if req.TargetPort < 1 || req.TargetPort > forward.MaxPort {
			return notify.CommandResponse{OK: false, Error: fmt.Sprintf("target port must be between 1 and %d", forward.MaxPort)}
		}
		proto := req.Protocol
		if proto == "" {
			proto = "tcp"
		}
		if err := forward.ValidateProtocol(proto); err != nil {
			return notify.CommandResponse{OK: false, Error: err.Error()}
		}
		host := req.TargetHost
		if host == "" {
			host = "localhost"
		}
		f, err := mgr.Start(forward.ForwardConfig{
			ExternalPort: req.LocalPort,
			InternalHost: host,
			InternalPort: req.TargetPort,
			Protocol:     proto,
		})
		if err != nil {
			return notify.CommandResponse{OK: false, Error: err.Error()}
		}
		msg := fmt.Sprintf("Forward started: %d → %s:%d (%s)", req.LocalPort, host, req.TargetPort, proto)
		// Surface an action notification to the UI: the frontend's action
		// resolver can open the port-forwarding tile (auto-resolve is off by
		// default — the user clicks the action button instead).
		data, _ := json.Marshal(map[string]any{
			"action": "open",
			"payload": map[string]any{
				"type":       "forward",
				"localPort":  req.LocalPort,
				"targetHost": host,
				"targetPort": req.TargetPort,
				"protocol":   proto,
			},
		})
		l.Broadcast(notify.Notification{
			Message: msg,
			Data:    data,
		})
		return notify.CommandResponse{OK: true, ID: f.ID, Message: msg}
	})

	l.RegisterHandler("forward-stop", func(cmd notify.Command) notify.CommandResponse {
		var req struct {
			LocalPort int    `json:"localPort"`
			ID        string `json:"id"`
		}
		if err := json.Unmarshal(cmd.Payload, &req); err != nil {
			return notify.CommandResponse{OK: false, Error: "invalid payload"}
		}
		id := req.ID
		if id == "" && req.LocalPort > 0 {
			for _, f := range mgr.StatusAll() {
				if f.ExternalPort == req.LocalPort {
					id = f.ID
					break
				}
			}
		}
		if id == "" {
			return notify.CommandResponse{OK: false, Error: "no forward found"}
		}
		f, err := mgr.Stop(id)
		if err != nil {
			return notify.CommandResponse{OK: false, Error: err.Error()}
		}
		_ = mgr.Remove(id)
		msg := fmt.Sprintf("Forward stopped: %d → %s:%d", f.ExternalPort, f.InternalHost, f.InternalPort)
		// Surface a notification to the UI so the user sees the stop even when
		// it came from the command line (plain message, no action).
		l.Broadcast(notify.Notification{Message: msg})
		return notify.CommandResponse{OK: true, Message: msg}
	})

	l.RegisterHandler("forward-list", func(cmd notify.Command) notify.CommandResponse {
		all := mgr.StatusAll()
		data, _ := json.Marshal(all)
		return notify.CommandResponse{OK: true, Data: data}
	})
}

func registerXDisplayHandlers(l *notify.Listener) {
	l.RegisterHandler("xdisplay-list", func(cmd notify.Command) notify.CommandResponse {
		displays := xdisplay.ListActiveDisplays()
		data, _ := json.Marshal(struct {
			Displays []string `json:"displays"`
		}{Displays: displays})
		return notify.CommandResponse{OK: true, Data: data}
	})
}
