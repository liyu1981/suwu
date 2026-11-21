package herdr

// Integration tests against a real herdr-core. Opt-in: they start a daemon and
// are skipped unless SUWU_HC_IT=1 and SUWU_HC_BIN points at a herdr-core binary.
// They use scratch XDG directories and a private session, and stop the core at
// the end (AGENTS.md: every child is bounded, nothing is left running).

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func startIntegrationCore(t *testing.T) *Core {
	t.Helper()
	if os.Getenv("SUWU_HC_IT") != "1" {
		t.Skip("set SUWU_HC_IT=1 (and SUWU_HC_BIN) to run herdr-core integration tests")
	}
	if os.Getenv("SUWU_HC_BIN") == "" {
		t.Skip("SUWU_HC_BIN is not set")
	}
	bin := os.Getenv("SUWU_HC_BIN")
	scratch := t.TempDir()
	t.Setenv("XDG_STATE_HOME", filepath.Join(scratch, "state"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(scratch, "config"))
	t.Setenv("HC_SESSION", "suwu-it")
	core := NewCore("")
	t.Cleanup(func() {
		core.Close()
		// The daemon must not outlive the test: stop it with the same scratch
		// environment, then wait briefly for the holder to go.
		stop := exec.Command(bin, "server", "stop")
		stop.Env = os.Environ()
		_ = stop.Run()
	})
	return core
}

func TestIntegrationRunAttachRead(t *testing.T) {
	core := startIntegrationCore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	version, err := core.Ping(ctx)
	if err != nil {
		t.Fatalf("ping: %v", err)
	}
	if version == "" {
		t.Fatal("no core version")
	}

	dir := t.TempDir()
	terminal, spaceID, err := core.RunShell(ctx, dir, "", "itest")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if terminal.Address == "" || spaceID == "" {
		t.Fatalf("run returned %+v / %q", terminal, spaceID)
	}

	snap, err := core.Snapshot(ctx)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	var found bool
	for _, space := range snap.Spaces {
		if space.ID != spaceID {
			continue
		}
		found = true
		if space.Name != filepath.Base(dir) {
			t.Errorf("space name = %q, want the directory name %q", space.Name, filepath.Base(dir))
		}
		if len(space.Terminals) != 1 || space.Terminals[0].Address != terminal.Address {
			t.Errorf("space terminals = %+v", space.Terminals)
		}
	}
	if !found {
		t.Fatalf("space %q missing from %+v", spaceID, snap.Spaces)
	}

	// Rename it: the custom name wins and is stored in the baikal document.
	if err := core.SetSpaceMeta(ctx, spaceID, func(m *SpaceMeta) { m.CustomName = "renamed" }); err != nil {
		t.Fatalf("rename: %v", err)
	}
	snap, err = core.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, space := range snap.Spaces {
		if space.ID == spaceID && space.Name != "renamed" {
			t.Errorf("after rename: %q", space.Name)
		}
	}

	// Attach and type.
	stream, err := core.Attach(ctx, terminal.Address, 100, 30, false)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	defer stream.Close()
	collect := make(chan string, 1)
	go func() {
		var b strings.Builder
		for {
			select {
			case chunk, ok := <-stream.Data():
				if !ok {
					return
				}
				b.Write(chunk)
				stream.Credit(len(chunk))
				if strings.Contains(b.String(), "billow") {
					collect <- b.String()
					return
				}
			case <-time.After(20 * time.Second):
				collect <- b.String()
				return
			}
		}
	}()
	if err := stream.Write([]byte("echo billow-ok\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-collect:
		if !strings.Contains(got, "billow") {
			t.Fatalf("stream output did not include the typed command: %q", got)
		}
	case <-ctx.Done():
		t.Fatal("no output from the attached terminal")
	}

	if text, err := core.ReadText(ctx, terminal.Address, 5); err != nil || !strings.Contains(text, "billow") {
		t.Fatalf("read = %q, %v", text, err)
	}

	if err := core.Kill(ctx, terminal.Address); err != nil {
		t.Fatalf("kill: %v", err)
	}
}
