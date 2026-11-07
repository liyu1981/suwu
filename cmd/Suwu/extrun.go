// `suwu ext-run <ext_id> <command> [args…]` — run a command an extension
// registers in its package.json (`suwu.commands`).
//
// Commands are how an extension does something without a tile: create a new
// document, import a file, run a migration. The handler is a gqjs script with
// the same shape as an API handler, and it runs through the same sandbox policy
// as a render or an API call (pkg/extension.ExecSandbox): the extensions tree is
// always readable, and with `suwu.fs` the extension also gets its own data
// directory plus a writable mount of the directory the command was pointed at.
//
// This is a local operation, not a server one: the command runs where you ran
// it, so `suwu ext-run bento new deck.bento.html` in ~/decks creates
// ~/decks/deck.bento.html whether or not Suwu is running.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"suwu/pkg/extension"
)

// extRunExitUsage is the usage-error exit code, matching `suwu gq` and `install`.
const extRunExitUsage = 64

func printExtRunUsage() {
	fmt.Print(`Usage: suwu ext-run [flags] <ext_id> <command> [args...]

Run a command registered by an extension (package.json → suwu.commands).
Commands are local: they run in the directory you point them at, whether or not
the Suwu server is running.

Flags:
  --dir <path>       directory the command works in (default: current directory)
  --timeout <dur>    per-command timeout (default 30s)
  --list             list the extension's commands and exit
  --json             print the handler's raw JSON result instead of its body

An extension that declares suwu.fs gets a writable mount of --dir at /fs (and its
own data directory at /ext-data); without it the run is read-only.

Examples:
  suwu ext-run bento new deck.bento.html
  suwu ext-run excalidraw new notes/plan.excalidraw
  suwu ext-run --dir ~/decks bento new
  suwu ext-run --list bento

Exit codes: 0 ok · 1 command failed · 2 timeout · ` + fmt.Sprint(extRunExitUsage) + ` usage error
`)
}

// extRunFlags mirrors the command line.
type extRunFlags struct {
	dir     string
	timeout time.Duration
	list    bool
	json    bool
}

func extRunCmd(args []string) error {
	fs := flag.NewFlagSet("ext-run", flag.ContinueOnError)
	fs.Usage = printExtRunUsage
	var f extRunFlags
	fs.StringVar(&f.dir, "dir", "", "directory the command works in (default: current directory)")
	fs.DurationVar(&f.timeout, "timeout", 30*time.Second, "per-command timeout")
	fs.BoolVar(&f.list, "list", false, "list the extension's commands and exit")
	fs.BoolVar(&f.json, "json", false, "print the raw JSON result")
	// reorderFlags needs to know which flags consume the next argument, or
	// `--dir <path>` would leave the path among the positionals.
	if err := fs.Parse(reorderFlags(args, map[string]bool{"dir": true, "timeout": true})); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		os.Exit(extRunExitUsage)
	}

	rest := fs.Args()
	if len(rest) == 0 {
		printExtRunUsage()
		os.Exit(extRunExitUsage)
	}

	dataDir, err := installDataDir()
	if err != nil {
		return err
	}
	res := extension.ResolveDir(dataDir)
	ext, err := extension.Resolve(res.Dir, rest[0])
	if err != nil {
		return fmt.Errorf("ext-run: %w", err)
	}

	if f.list {
		if len(ext.Commands) == 0 {
			fmt.Printf("  %s registers no commands\n", ext.ID)
			return nil
		}
		for _, c := range ext.Commands {
			if c.Description == "" {
				fmt.Printf("  %-16s %s\n", c.Name, c.Handler)
				continue
			}
			fmt.Printf("  %-16s %s\n", c.Name, c.Description)
		}
		return nil
	}

	if len(rest) < 2 {
		return fmt.Errorf("usage: suwu ext-run <ext_id> <command> [args...] (try --list)")
	}
	name := rest[1]
	cmd, ok := ext.Command(name)
	if !ok {
		return fmt.Errorf("ext-run: %s has no command %q (try: suwu ext-run --list %s)", ext.ID, name, ext.ID)
	}
	handler, err := ext.HandlerPath(cmd.Handler)
	if err != nil {
		return fmt.Errorf("ext-run: %w", err)
	}

	dir := f.dir
	if dir == "" {
		dir, err = os.Getwd()
		if err != nil {
			return err
		}
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return fmt.Errorf("resolve --dir: %w", err)
	}
	if info, statErr := os.Stat(dir); statErr != nil || !info.IsDir() {
		return fmt.Errorf("ext-run: %s is not a directory", dir)
	}

	body, status, err := runExtensionCommand(ext, res.Dir, handler, dir, name, rest[2:], f.timeout)
	if err != nil {
		return fmt.Errorf("ext-run: %w", err)
	}
	if status >= 400 {
		return fmt.Errorf("ext-run: %s %s failed: %s", ext.ID, name, strings.TrimSpace(body))
	}

	if f.json {
		fmt.Println(body)
		return nil
	}
	// Handlers answer with a body: a created path, a summary line, JSON. Print it
	// as-is, which is what makes `suwu ext-run bento new x` pipeable.
	if s := strings.TrimSpace(body); s != "" {
		fmt.Println(s)
	}
	return nil
}

// runExtensionCommand executes one command handler and returns its body/status.
//
// The child process contract matches the server's runner (docs/EXTENSION_API_PLAN.md):
// the input travels in a file, the result is read back from another, and the
// sandbox comes from extension.ExecSandbox.
func runExtensionCommand(
	ext extension.Extension,
	extRoot, handler, dir, name string,
	args []string,
	timeout time.Duration,
) (body string, status int, err error) {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	input := map[string]any{
		"action":  "command",
		"id":      ext.ID,
		"command": name,
		"args":    args,
		"cwd":     dir,
		// Handlers write through the virtual mount, never the host path.
		"dir": virtualTargetDir(ext, dir),
	}
	if ext.Net {
		input["net"] = true
	}
	inputJSON, err := json.Marshal(input)
	if err != nil {
		return "", 0, err
	}

	inFile, err := os.CreateTemp("", "suwu-extrun-in-*.json")
	if err != nil {
		return "", 0, fmt.Errorf("create input temp: %w", err)
	}
	inPath := inFile.Name()
	defer func() { _ = os.Remove(inPath) }()
	if _, err = inFile.Write(inputJSON); err != nil {
		_ = inFile.Close()
		return "", 0, fmt.Errorf("write input temp: %w", err)
	}
	if err = inFile.Close(); err != nil {
		return "", 0, fmt.Errorf("write input temp: %w", err)
	}

	out, err := os.CreateTemp("", "suwu-extrun-out-*.json")
	if err != nil {
		return "", 0, fmt.Errorf("create result temp: %w", err)
	}
	outPath := out.Name()
	_ = out.Close()
	_ = os.Remove(outPath)
	defer func() { _ = os.Remove(outPath) }()

	gqArgs := []string{"gq", "--timeout", timeout.String(), "--result-file", outPath, "--input-file", inPath}
	if ext.Net {
		gqArgs = append(gqArgs, "--allow-net")
	}
	mounts, readOnly := extension.ExecSandbox(ext, extRoot, dir)
	for _, m := range mounts {
		_ = os.MkdirAll(m.Real, 0o755)
		gqArgs = append(gqArgs, "--root", m.Virtual+"="+m.Real)
	}
	if readOnly {
		gqArgs = append(gqArgs, "--ro")
	}
	gqArgs = append(gqArgs, handler)

	binary, binErr := os.Executable()
	if binErr != nil || binary == "" {
		binary = "suwu"
	}
	cmd := exec.Command(binary, gqArgs...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
	cmd.Stdout = os.Stderr // handler console output is diagnostics, not the result
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 2 {
			return "", 0, errors.New("timed out")
		}
		return "", 0, err
	}

	raw, err := os.ReadFile(outPath)
	if err != nil {
		return "", 0, fmt.Errorf("read result: %w", err)
	}
	res, err := parseCommandResult(raw)
	if err != nil {
		return "", 0, err
	}
	if res.Status == 0 {
		res.Status = 200
	}
	return res.Body, res.Status, nil
}

// virtualTargetDir is where a handler should write: the mounted /fs when the
// extension has filesystem access, empty otherwise.
func virtualTargetDir(ext extension.Extension, dir string) string {
	if !ext.FS || dir == "" {
		return ""
	}
	return "/fs"
}

// commandResult is the JSON a command handler returns. A bare string is the body.
type commandResult struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

func parseCommandResult(raw []byte) (commandResult, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return commandResult{}, nil
	}
	var s string
	if err := json.Unmarshal([]byte(trimmed), &s); err == nil {
		return commandResult{Body: s}, nil
	}
	var obj commandResult
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return commandResult{}, fmt.Errorf("invalid result: %w", err)
	}
	return obj, nil
}
