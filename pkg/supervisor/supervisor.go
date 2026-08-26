// Package supervisor implements a self-contained hot-reload supervisor for dev
// mode. It watches the project's Go source and automatically rebuilds and
// restarts the server on change, so editing .go files does not require manual
// restarting. It is dependency-light and uses only fsnotify.
package supervisor

import (
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// ChildEnv marks a process as the supervised server (child), telling main to
// run the server directly instead of spawning another supervisor.
const ChildEnv = "_DEMO_CHILD"

// Run acts as the supervisor: it builds and starts the server, then watches
// the project for Go source changes and rebuilds/restarts on change. It only
// returns when ctx is cancelled.
func Run(ctx context.Context, args []string) {
	wd, err := os.Getwd()
	if err != nil {
		log.Fatalf("supervisor: getwd: %v", err)
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Fatalf("supervisor: watcher: %v", err)
	}
	defer watcher.Close()

	if err := watchProject(watcher, wd); err != nil {
		log.Fatalf("supervisor: watch: %v", err)
	}

	var (
		mu        sync.Mutex
		child     *exec.Cmd
		gen       int
		startTime time.Time
	)

	getChild := func() (*exec.Cmd, int, time.Time) {
		mu.Lock()
		defer mu.Unlock()
		return child, gen, startTime
	}

	setChild := func(c *exec.Cmd) {
		mu.Lock()
		defer mu.Unlock()
		child = c
		gen++
		startTime = time.Now()
	}

	killCurrent := func() {
		mu.Lock()
		c := child
		child = nil
		mu.Unlock()
		if c != nil && c.Process != nil {
			_ = c.Process.Kill()
			_, _ = c.Process.Wait()
		}
	}

	start := func() {
		killCurrent()

		tmp, err := os.CreateTemp("", "ghostty-demo-*.bin")
		if err != nil {
			log.Printf("supervisor: create temp: %v", err)
			return
		}
		binPath := tmp.Name()
		tmp.Close()
		_ = os.Remove(binPath)

		build := exec.Command("go", "build", "-o", binPath, "./cmd/demo")
		build.Dir = wd
		if out, err := build.CombinedOutput(); err != nil {
			log.Printf("supervisor: build failed: %v\n%s", err, out)
			return
		}

		cmd := exec.Command(binPath, args[1:]...)
		cmd.Dir = wd
		cmd.Env = append(os.Environ(), ChildEnv+"=1")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		if err := cmd.Start(); err != nil {
			log.Printf("supervisor: start: %v", err)
			return
		}
		setChild(cmd)
		log.Printf("supervisor: restarted (pid %d)", cmd.Process.Pid)
	}

	restart := make(chan struct{}, 1)
	signal := func() {
		select {
		case restart <- struct{}{}:
		default:
		}
	}

	start()
	defer killCurrent()

	// Restart if the child exits on its own (crash). If it crashes repeatedly
	// within a short window (e.g. port already in use), stop looping and exit
	// so the failure is visible instead of an endless restart cycle.
	const fastExit = 2 * time.Second
	fastFailures := 0
	go func() {
		for {
			c, g, start := getChild()
			if c == nil {
				time.Sleep(200 * time.Millisecond)
				continue
			}
			_ = c.Wait()
			if ctx.Err() != nil {
				return
			}
			cur, curGen, _ := getChild()
			if cur != c || curGen != g {
				continue // intentionally replaced by a new start()
			}
			if time.Since(start) < fastExit {
				fastFailures++
			} else {
				fastFailures = 0
			}
			if fastFailures >= 5 {
				log.Printf("supervisor: server failed to stay up %d times in a row.", fastFailures)
				log.Printf("supervisor: check the error above (likely a port already in use). Exiting.")
				os.Exit(1)
			}
			log.Printf("supervisor: server exited unexpectedly, restarting...")
			time.Sleep(500 * time.Millisecond)
			signal()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case <-restart:
			start()
		case ev, ok := <-watcher.Events:
			if !ok {
				return
			}
			if ev.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Rename|fsnotify.Remove) == 0 {
				continue
			}
			if isGoSource(ev.Name) {
				log.Printf("supervisor: change detected: %s", filepath.Base(ev.Name))
				time.Sleep(100 * time.Millisecond) // debounce
				signal()
			}
		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			log.Printf("supervisor: watch error: %v", err)
		}
	}
}

func watchProject(watcher *fsnotify.Watcher, root string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			if d.Name() == "origin_demo_ts" {
				return filepath.SkipDir
			}
			return watcher.Add(path)
		}
		return nil
	})
}

func isGoSource(name string) bool {
	switch filepath.Ext(name) {
	case ".go", ".mod", ".sum":
		return true
	}
	return false
}
