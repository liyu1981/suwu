// Command demo is the standalone ghostty-web terminal demo server. It serves a
// full terminal emulator in the browser, backed by a real shell PTY over
// WebSocket, protected by a per-run same-origin token.
//
// Usage:
//
//	demo                # production, single binary, port 8080
//	demo --dev          # dev mode with Go hot reload, port 8000
//	PORT=3000 demo      # custom port
//	HOST=0.0.0.0 GHOSTTY_ALLOWED_HOSTS=example.com demo
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

	"ghostty-web-demo/pkg/assets"
	"ghostty-web-demo/pkg/auth"
	"ghostty-web-demo/pkg/envfile"
	"ghostty-web-demo/pkg/pty"
	"ghostty-web-demo/pkg/server"
	"ghostty-web-demo/pkg/supervisor"
)

func main() {
	dev := flag.Bool("dev", false, "dev mode: hot reload on Go source changes")
	envFile := flag.String("env-file", ".env", "path to a .env file to load (missing file is ignored)")
	flag.Parse()

	if err := envfile.Load(*envFile); err != nil {
		log.Fatalf("envfile: %v", err)
	}

	// Dev mode: unless we are the supervised child, run the hot-reload
	// supervisor which owns this process tree.
	if *dev && os.Getenv(supervisor.ChildEnv) != "1" {
		supervisor.Run(signalContext(), os.Args)
		return
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

	assetsFS, err := assetFS(dev)
	if err != nil {
		return err
	}

	srv := server.New(cfg, assetsFS)

	httpServer := &http.Server{
		Addr:    net.JoinHostPort(cfg.BindHost, strconv.Itoa(port)),
		Handler: srv.Handler(),
	}

	errCh := make(chan error, 1)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	printBanner(dev, cfg, port)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-errCh:
		return fmt.Errorf("%w\nhint: another demo server may already be running on %s; stop it or set a different PORT",
			err, httpServer.Addr)
	case <-ctx.Done():
	}

	fmt.Println("\n\nShutting down...")
	server.CloseAll()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3_000_000_000)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	return nil
}

func assetFS(dev bool) (fs.FS, error) {
	if dev {
		// Serve from disk so HTML/asset edits apply without a rebuild.
		return os.DirFS(assets.DevDir), nil
	}
	// Single binary: serve from the embedded web/ tree.
	sub, err := fs.Sub(assets.FS, "web")
	if err != nil {
		return nil, err
	}
	return sub, nil
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

func printBanner(dev bool, cfg *auth.Config, port int) {
	home, _ := pty.Home()

	fmt.Println("\n" + strings.Repeat("═", 60))
	fmt.Printf("  🚀 ghostty-web demo server%s\n", devLabel(dev))
	fmt.Println(strings.Repeat("═", 60))
	fmt.Printf("\n  📺 Open: http://%s:%d\n", formatURLHost(cfg.BindHost), port)
	fmt.Println("  📡 WebSocket PTY: same endpoint /ws")
	fmt.Println("  🔐 WebSocket auth: per-run same-origin token")
	fmt.Printf("  🐚 Shell: %s\n", pty.ShellPath())
	fmt.Printf("  📁 Home: %s\n", home)
	if dev {
		fmt.Println("  🔥 Hot reload enabled (watching .go files)")
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

func signalContext() context.Context {
	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	return ctx
}
