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
//	suwu install        # seed ~/.config/suwu/.env from defaults
//	suwu daemon {start|stop|restart|status|logs}  # manage background server
//
//	PORT=3000 suwu serve   # custom port
//	HOST=0.0.0.0 suwu serve   # bind all interfaces
//
// SUWU_DEV=true in the .env file enables dev defaults (port 8000, air
// rebuild message). Configuration is resolved in order of precedence:
// shell environment, then ./.env (project), then ~/.config/suwu/.env
// (user-global, written by 'suwu gencerts'). TLS certificates come from
// TLS_CERT_FILE/TLS_KEY_FILE when set, falling back to the default pair
// 'suwu gencerts' writes into ~/.config/suwu/.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
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
	"suwu/pkg/gencerts"
	"suwu/pkg/pty"
	"suwu/pkg/server"
	"suwu/pkg/session"
	"suwu/pkg/version"
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
			printUsage()
			return
		case "version", "-v", "--version":
			fmt.Printf("suwu %s\n", version.Version)
			return
		case "install":
			if err := install(); err != nil {
				log.Fatalf("install: %v", err)
			}
			return
		case "daemon":
			if err := daemon(os.Args[2:]); err != nil {
				log.Fatalf("daemon: %v", err)
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
  suwu gencerts [--hosts <list>] [--out <dir>] [--no-env] [--force]
                           generate a TLS certificate pair (interactive by default)
  suwu version             print version and exit
  suwu install             seed ~/.config/suwu/.env and choose data directory
  suwu daemon {start|stop|restart|status|logs}
                           manage a background daemon (default data: ~/.suwu)

Configuration precedence:
  --env-file explicitly given → that file only
  --env-file default (empty) → ./.env → ~/.config/suwu/.env → defaults
  SUWU_DEV=true              → ./.env only (global skipped)
TLS: TLS_CERT_FILE/TLS_KEY_FILE, else the default pair in ~/.config/suwu/
`)
}

func serveMain() {
	envFile := flag.String("env-file", "", "path to a .env file to load (default .env; when explicitly set, the global env is skipped)")
	flag.Parse()

	debugf("env-file flag = %q (empty = default)", *envFile)
	debugf("initial state: SUWU_DEV=%q PORT=%q HOST=%q", os.Getenv("SUWU_DEV"), os.Getenv("PORT"), os.Getenv("HOST"))

	// Resolve the project env file: explicit --env-file wins, else .env.
	projectEnv := *envFile
	if projectEnv == "" {
		projectEnv = ".env"
	}
	debugf("loading project env: %s", projectEnv)
	if *envFile != "" {
		// Explicit --env-file: force-set values (override anything in
		// the process environment, e.g. air's own .env injection).
		if err := envfile.LoadForce(projectEnv); err != nil {
			log.Fatalf("envfile: %v", err)
		}
	} else {
		if err := envfile.Load(projectEnv); err != nil {
			log.Fatalf("envfile: %v", err)
		}
	}
	debugf("after project env: SUWU_DEV=%q PORT=%q HOST=%q", os.Getenv("SUWU_DEV"), os.Getenv("PORT"), os.Getenv("HOST"))

	// Load the user-global ~/.config/suwu/.env only when no explicit
	// --env-file was given and SUWU_DEV is not set.
	if *envFile == "" && os.Getenv("SUWU_DEV") != "true" {
		if dir, err := certs.DefaultDir(); err == nil {
			globalEnv := filepath.Join(dir, ".env")
			debugf("loading global env: %s", globalEnv)
			if err := envfile.Load(globalEnv); err != nil {
				log.Fatalf("envfile: %v", err)
			}
			debugf("after global env: SUWU_DEV=%q PORT=%q HOST=%q", os.Getenv("SUWU_DEV"), os.Getenv("PORT"), os.Getenv("HOST"))
		}
	} else {
		debugf("skipping global env (env-file explicit=%v, SUWU_DEV=%q)", *envFile != "", os.Getenv("SUWU_DEV"))
	}

	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func debugf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[suwu-env] "+format+"\n", args...)
}

func run() error {
	dev := os.Getenv("SUWU_DEV") == "true"
	port := parsePort(os.Getenv("PORT"), defaultPort(dev))

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

	srv := server.New(cfg, sub, sessions)

	httpServer := &http.Server{
		Addr:    net.JoinHostPort(cfg.BindHost, strconv.Itoa(port)),
		Handler: srv.Handler(),
	}

	// HTTPS uses TLS_CERT_FILE/TLS_KEY_FILE when set, falling back to the
	// default pair 'suwu gencerts' writes into ~/.config/suwu/. A secure
	// context is required for browser clipboard access, so pasting into the
	// terminal only works over https (or from localhost).
	certFile, keyFile, tlsSource, err := resolveTLS()
	if err != nil {
		sessions.Close()
		return err
	}
	useTLS := certFile != "" && keyFile != ""

	errCh := make(chan error, 1)
	go func() {
		var err error
		if useTLS {
			err = httpServer.ListenAndServeTLS(certFile, keyFile)
		} else {
			err = httpServer.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	printBanner(dev, cfg, port, useTLS, tlsSource)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-errCh:
		sessions.Close()
		return fmt.Errorf("%w\nhint: another Suwu server may already be running on %s; stop it or set a different PORT",
			err, httpServer.Addr)
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
	server.CloseAll()
	sessions.Close()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3_000_000_000)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
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
		return "", "", "", nil
	}
	certPath, keyPath := certs.PairPaths(configDir)
	if _, err := os.Stat(certPath); err != nil {
		return "", "", "", nil
	}
	if _, err := os.Stat(keyPath); err != nil {
		return "", "", "", nil
	}
	return certPath, keyPath, "~/.config/suwu", nil
}

func parsePort(value string, def int) int {
	if value == "" {
		return def
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 || n > 65535 {
		log.Fatalf("PORT must be an integer from 1 to 65535: %v", value)
	}
	return n
}

func defaultPort(dev bool) int {
	if dev {
		return 8000
	}
	return 8080
}

func formatURLHost(host string) string {
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		return "[" + host + "]"
	}
	return host
}

func printBanner(dev bool, cfg *auth.Config, port int, useTLS bool, tlsSource string) {
	home, _ := pty.Home()
	scheme := "http"
	if useTLS {
		scheme = "https"
	}

	fmt.Println("\n" + strings.Repeat("═", 60))
	fmt.Printf("  🚀 Suwu server%s\n", devLabel(dev))
	fmt.Println(strings.Repeat("═", 60))
	fmt.Printf("\n  📺 Open: %s://%s:%d\n", scheme, formatURLHost(cfg.BindHost), port)
	if useTLS {
		fmt.Printf("  🔒 TLS enabled (certs from %s): browser clipboard APIs (terminal paste) available\n", tlsSource)
	} else {
		fmt.Println("  ⚠️  Plain HTTP: browser clipboard APIs unavailable outside localhost (no paste into the terminal)")
		fmt.Println("     hint: run 'suwu gencerts' to enable https")
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
