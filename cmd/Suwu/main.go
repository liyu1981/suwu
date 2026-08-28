// Command suwu is the standalone Suwu terminal server. It serves a full
// terminal emulator in the browser, backed by a real shell PTY over
// WebSocket, protected by a per-run same-origin token.
//
// Usage:
//
//	suwu                # production, single binary, port 8080
//	suwu --dev          # dev defaults, port 8000 (hot reload via air)
//	PORT=3000 suwu      # custom port
//	HOST=0.0.0.0 GHOSTTY_ALLOWED_HOSTS=example.com suwu
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
	"strconv"
	"strings"
	"syscall"
	"time"

	"suwu/pkg/assets"
	"suwu/pkg/auth"
	"suwu/pkg/envfile"
	"suwu/pkg/pty"
	"suwu/pkg/server"
	"suwu/pkg/session"
)

func main() {
	dev := flag.Bool("dev", false, "dev mode: dev defaults (port 8000); run via air for hot reload")
	envFile := flag.String("env-file", ".env", "path to a .env file to load (missing file is ignored)")
	flag.Parse()

	if err := envfile.Load(*envFile); err != nil {
		log.Fatalf("envfile: %v", err)
	}

	if err := run(*dev); err != nil {
		log.Fatal(err)
	}
}

func run(dev bool) error {
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

	// HTTPS is opt-in via TLS_CERT_FILE + TLS_KEY_FILE (e.g. mkcert output).
	// A secure context is required for browser clipboard access, so pasting
	// into the terminal only works over https (or from localhost).
	certFile, keyFile := os.Getenv("TLS_CERT_FILE"), os.Getenv("TLS_KEY_FILE")
	useTLS := certFile != "" && keyFile != ""
	if (certFile == "") != (keyFile == "") {
		sessions.Close()
		return errors.New("TLS_CERT_FILE and TLS_KEY_FILE must be set together")
	}

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

	printBanner(dev, cfg, port, useTLS)

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

func printBanner(dev bool, cfg *auth.Config, port int, useTLS bool) {
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
		fmt.Println("  🔒 TLS enabled: browser clipboard APIs (terminal paste) available")
	} else {
		fmt.Println("  ⚠️  Plain HTTP: browser clipboard APIs unavailable outside localhost (no paste into the terminal)")
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
	if auth.IsWildcardBindHost(cfg.BindHost) || !auth.IsLoopbackHost(cfg.BindHost) {
		fmt.Println("     Remote access requires GHOSTTY_ALLOWED_HOSTS and can expose your shell if misconfigured.")
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
