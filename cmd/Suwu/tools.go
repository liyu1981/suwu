package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"suwu/pkg/bindir"
	"suwu/pkg/tools"
)

const toolsUsageText = `Usage: suwu tools <command> [flags]

The tools Suwu knows how to install: ripgrep, fzf, asdf, witr, pig, herdr and
herdr-core. They live in <data dir>/bin (~/.suwu/bin), each pinned to a version
and a sha256 in the catalog this build carries, and each recorded in a stamp so
it can be updated or removed cleanly.

Commands:
  suwu tools list [--json] [--refresh]
      what the catalog offers and what is installed here (installed, update,
      missing, unsupported on this platform, or unmanaged)
  suwu tools install <name>... [--force] [--refresh] [--dry-run]
      download, verify, extract and stamp one or more tools
  suwu tools update [<name>...]
      install every tool whose catalog version differs from the installed one
  suwu tools remove <name>...
      delete exactly the files the tool's stamp owns
  suwu tools path [--enable | --disable | --status]
      put <data dir>/bin on the PATH of your login shells, in a managed block
      marked "suwu-bin" (opt-in: Suwu's own sessions already see the directory)

Flags:
  --data-dir <dir>   data directory (default ~/.suwu, or $SUWU_VAR)
  --force            replace an existing install of the same version
  --dry-run          verify only; write nothing
  --refresh          ignore the cached catalog
  --json             machine-readable output (list)

Exit codes:
  0 success, 1 install/validation failure, 64 usage error
`

const execUsageText = `Usage: suwu exec [flags] <tool> [args...]

Run the copy of a tool that Suwu manages in <data dir>/bin (~/.suwu/bin), never
the one on your PATH: agents and extensions call this, and "which rg did I get"
must not depend on PATH order.

Flags:
  --list         print the managed tools and their versions
  --path <tool>  print the managed path of one tool
  --system       fall back to PATH when the managed copy is absent
  --             end flag parsing (for tools that take flags of their own)

Exit codes:
  0 the tool's own status, 127 when it is not installed, 64 usage error

Examples:
  suwu exec rg -n TODO .
  suwu exec --list
  suwu tools install rg fzf && suwu exec rg --version
`

func printToolsUsage() { fmt.Fprint(os.Stderr, toolsUsageText) }
func printExecUsage()  { fmt.Fprint(os.Stderr, execUsageText) }

// toolsMain implements `suwu tools`. It returns the process exit code.
func toolsMain(args []string) int {
	if len(args) == 0 {
		printToolsUsage()
		return 64
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "-h", "--help", "help":
		printToolsUsage()
		return 0
	case "list":
		return toolsList(rest)
	case "install":
		return toolsInstall(rest, false)
	case "update":
		return toolsInstall(rest, true)
	case "remove":
		return toolsRemove(rest)
	case "path":
		return toolsPath(rest)
	default:
		fmt.Fprintf(os.Stderr, "tools: unknown command %q\n\n", cmd)
		printToolsUsage()
		return 64
	}
}

// toolsFlags is the shared flag set; install and update differ only in what they
// default to installing.
type toolsFlags struct {
	dataDir string
	force   bool
	dryRun  bool
	refresh bool
	asJSON  bool
}

func parseToolsFlags(name string, args []string, set func(*flag.FlagSet, *toolsFlags)) (*toolsFlags, []string, error) {
	fl := flag.NewFlagSet(name, flag.ContinueOnError)
	fl.SetOutput(os.Stderr)
	f := &toolsFlags{}
	fl.StringVar(&f.dataDir, "data-dir", "", "data directory (default ~/.suwu)")
	fl.BoolVar(&f.force, "force", false, "replace an existing install")
	fl.BoolVar(&f.dryRun, "dry-run", false, "verify only; write nothing")
	fl.BoolVar(&f.refresh, "refresh", false, "ignore the cached catalog")
	fl.BoolVar(&f.asJSON, "json", false, "machine-readable output")
	set(fl, f)
	if err := fl.Parse(args); err != nil {
		return nil, nil, err
	}
	return f, fl.Args(), nil
}

func (f *toolsFlags) resolveDataDir() (string, error) {
	if f.dataDir != "" {
		return filepath.Abs(f.dataDir)
	}
	return installDataDir()
}

// loadCatalog returns the catalog and its origin. With --refresh, or when the
// network and cache both fail, the embedded catalog is the last resort so `list`
// still says what this build knows about.
func (f *toolsFlags) loadCatalog(ctx context.Context, dataDir string) (*tools.Catalog, tools.Origin, error) {
	src := tools.NewSource(dataDir)
	var (
		cat    *tools.Catalog
		origin tools.Origin
		err    error
	)
	if f.refresh {
		cat, origin, err = src.Refresh(ctx)
	} else {
		cat, origin, err = src.Load(ctx)
	}
	if err == nil {
		return cat, origin, nil
	}
	offline, offErr := tools.Offline()
	if offErr != nil {
		return nil, origin, err
	}
	origin.Stale = true
	// Say why, not just that: "no network" and "this build cannot read that
	// catalog" want different fixes.
	origin.Error = err.Error()
	return offline, origin, nil
}

func toolsList(args []string) int {
	f, _, err := parseToolsFlags("tools list", args, func(*flag.FlagSet, *toolsFlags) {})
	if err != nil {
		return 64
	}
	dataDir, err := f.resolveDataDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "tools: %v\n", err)
		return 1
	}
	cat, origin, err := f.loadCatalog(context.Background(), dataDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tools: %v\n", err)
		return 1
	}
	list, err := tools.Statuses(cat, runtime.GOOS, runtime.GOARCH, dataDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tools: %v\n", err)
		return 1
	}
	if f.asJSON {
		out := struct {
			BinDir string         `json:"binDir"`
			Source tools.Origin   `json:"source"`
			Tools  []tools.Status `json:"tools"`
		}{BinDir: bindir.Dir(dataDir), Source: origin, Tools: list}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(out); err != nil {
			fmt.Fprintf(os.Stderr, "tools: %v\n", err)
			return 1
		}
		return 0
	}
	fmt.Printf("Tools in %s\n", bindir.Dir(dataDir))
	if origin.Stale {
		fmt.Printf("  (using the catalog embedded in this build: %s)\n", origin.Error)
	}
	for _, s := range list {
		line := fmt.Sprintf("  %-11s %-9s %s", s.Name, s.Version, stateLabel(s))
		if s.Installed != nil && s.Installed.Version != s.Version {
			line += " " + s.Installed.Version
		}
		fmt.Println(strings.TrimRight(line, " "))
	}
	return 0
}

func stateLabel(s tools.Status) string {
	switch s.State {
	case tools.StateInstalled:
		return "installed"
	case tools.StateUpdate:
		return "update"
	case tools.StateUnsupported:
		return "not for this platform"
	case tools.StateUnmanaged:
		return "unmanaged file"
	default:
		return "available"
	}
}

// toolsInstall installs the named tools, or — with update and no names — every
// tool whose catalog version differs from the installed one.
func toolsInstall(args []string, update bool) int {
	f, names, err := parseToolsFlags("tools install", args, func(*flag.FlagSet, *toolsFlags) {})
	if err != nil {
		return 64
	}
	dataDir, err := f.resolveDataDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "tools: %v\n", err)
		return 1
	}
	cat, _, err := f.loadCatalog(context.Background(), dataDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tools: %v\n", err)
		return 1
	}
	if update && len(names) == 0 {
		list, err := tools.Statuses(cat, runtime.GOOS, runtime.GOARCH, dataDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "tools: %v\n", err)
			return 1
		}
		for _, s := range list {
			if s.State == tools.StateUpdate {
				names = append(names, s.Name)
			}
		}
		if len(names) == 0 {
			fmt.Println("Everything is up to date.")
			return 0
		}
	}
	if len(names) == 0 {
		fmt.Fprintln(os.Stderr, "tools: name a tool, or use 'suwu tools update' to update everything installed")
		return 64
	}

	failures := 0
	for _, name := range names {
		tool, ok := cat.Find(name)
		if !ok {
			fmt.Fprintf(os.Stderr, "tools: %s is not in the catalog\n", name)
			failures++
			continue
		}
		platform, ok := tool.For(runtime.GOOS, runtime.GOARCH)
		if !ok {
			fmt.Fprintf(os.Stderr, "tools: %s has no build for %s\n", name, tools.PlatformKey(runtime.GOOS, runtime.GOARCH))
			failures++
			continue
		}
		spec := tools.SpecFrom(tool, platform, runtime.GOOS, runtime.GOARCH)
		progress := newProgress(name, isTerminal(os.Stderr))
		res, err := tools.InstallFromURL(context.Background(), spec, tools.Options{
			DataDir:  dataDir,
			Force:    f.force,
			DryRun:   f.dryRun,
			Progress: progress.call,
		})
		progress.done()
		if err != nil {
			fmt.Fprintf(os.Stderr, "tools: %s: %v\n", name, err)
			failures++
			continue
		}
		switch {
		case res.Skipped:
			fmt.Printf("  %s %s is already installed\n", name, res.Version)
		case f.dryRun:
			fmt.Printf("  %s %s would be installed (%s)\n", name, res.Version, strings.Join(res.Files, ", "))
		default:
			fmt.Printf("  %s %s installed (%s)\n", name, res.Version, strings.Join(res.Files, ", "))
		}
	}
	if failures > 0 {
		return 1
	}
	return 0
}

// newProgress writes one rewritten line on a terminal and nothing at all in
// a pipe, so a captured log has the result and not a hundred carriage returns.
type progressPrinter struct {
	name  string
	last  int64
	tty   bool
	first bool
}

func newProgress(name string, tty bool) *progressPrinter {
	return &progressPrinter{name: name, tty: tty}
}

func (p *progressPrinter) call(_ string, done, total int64) {
	if !p.tty || total <= 0 {
		return
	}
	pct := done * 100 / total
	if pct == p.last {
		return
	}
	p.last = pct
	fmt.Fprintf(os.Stderr, "\r  %s %d%%", p.name, pct)
}

func (p *progressPrinter) done() {
	if p.tty && p.last > 0 {
		fmt.Fprint(os.Stderr, "\r")
	}
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

func toolsRemove(args []string) int {
	f, names, err := parseToolsFlags("tools remove", args, func(*flag.FlagSet, *toolsFlags) {})
	if err != nil {
		return 64
	}
	if len(names) == 0 {
		fmt.Fprintln(os.Stderr, "tools: name at least one tool to remove")
		return 64
	}
	dataDir, err := f.resolveDataDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "tools: %v\n", err)
		return 1
	}
	failures := 0
	for _, name := range names {
		res, err := tools.Uninstall(tools.Options{DataDir: dataDir, DryRun: f.dryRun}, name)
		if err != nil {
			fmt.Fprintf(os.Stderr, "tools: %s: %v\n", name, err)
			failures++
			continue
		}
		verb := "removed"
		if f.dryRun {
			verb = "would remove"
		}
		fmt.Printf("  %s %s (%s)\n", name, verb, strings.Join(res.Files, ", "))
		for _, w := range res.Warnings {
			fmt.Fprintf(os.Stderr, "  note: %s\n", w)
		}
	}
	if failures > 0 {
		return 1
	}
	return 0
}

func toolsPath(args []string) int {
	fl := flag.NewFlagSet("tools path", flag.ContinueOnError)
	fl.SetOutput(os.Stderr)
	enable := fl.Bool("enable", false, "add the tool directory to your shell PATH")
	disable := fl.Bool("disable", false, "remove that managed block")
	status := fl.Bool("status", false, "show what is configured")
	dataDirFlag := fl.String("data-dir", "", "data directory (default ~/.suwu)")
	if err := fl.Parse(args); err != nil {
		return 64
	}
	if *enable && *disable {
		fmt.Fprintln(os.Stderr, "tools path: --enable and --disable are exclusive")
		return 64
	}
	dataDir, err := (&toolsFlags{dataDir: *dataDirFlag}).resolveDataDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "tools: %v\n", err)
		return 1
	}
	dir := bindir.Dir(dataDir)
	switch {
	case *disable:
		changed, err := bindir.RemovePath(bindir.ToolsBlock)
		if err != nil {
			fmt.Fprintf(os.Stderr, "tools: %v\n", err)
			return 1
		}
		if len(changed) == 0 {
			fmt.Println("No suwu-bin PATH block found.")
			return 0
		}
		fmt.Printf("Removed the suwu-bin PATH block from %s\n", strings.Join(changed, ", "))
	case *enable:
		changed, err := bindir.EnsurePath(dir, bindir.ToolsBlock)
		if err != nil {
			fmt.Fprintf(os.Stderr, "tools: %v\n", err)
			return 1
		}
		if len(changed) == 0 {
			fmt.Printf("%s is already on PATH.\n", dir)
			return 0
		}
		fmt.Printf("Added %s to PATH in %s\n", dir, strings.Join(changed, ", "))
		fmt.Println("Open a new shell (or source that file) to use the tools there.")
	default:
		_ = status
		files, err := bindir.PathFiles(bindir.ToolsBlock)
		if err != nil {
			fmt.Fprintf(os.Stderr, "tools: %v\n", err)
			return 1
		}
		fmt.Printf("Tool directory: %s\n", dir)
		if len(files) == 0 {
			fmt.Println("PATH block:     not installed (Suwu's own sessions and 'suwu exec' do not need it)")
			return 0
		}
		fmt.Printf("PATH block:     %s\n", strings.Join(files, ", "))
	}
	return 0
}

// execMain implements `suwu exec`: the managed copy of a tool, never PATH.
func execMain(args []string) int {
	var (
		wantList   bool
		wantSystem bool
		wantPath   string
		dataDir    string
	)
	// Flags end at "--" or at the first argument that is not a flag, because
	// everything after the tool name belongs to the tool.
	i := 0
	for ; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			i++
			break
		}
		if !strings.HasPrefix(arg, "-") {
			break
		}
		switch {
		case arg == "--list" || arg == "-list":
			wantList = true
		case arg == "--system" || arg == "-system":
			wantSystem = true
		case arg == "--path" || arg == "-path":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "exec: --path needs a tool name")
				return 64
			}
			i++
			wantPath = args[i]
		case arg == "--data-dir":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "exec: --data-dir needs a directory")
				return 64
			}
			i++
			dataDir = args[i]
		case strings.HasPrefix(arg, "--data-dir="):
			dataDir = strings.TrimPrefix(arg, "--data-dir=")
		case arg == "-h" || arg == "--help":
			printExecUsage()
			return 0
		default:
			fmt.Fprintf(os.Stderr, "exec: unknown flag %q\n\n", arg)
			printExecUsage()
			return 64
		}
	}
	rest := args[i:]

	resolved, err := (&toolsFlags{dataDir: dataDir}).resolveDataDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "exec: %v\n", err)
		return 1
	}

	if wantList {
		names, err := tools.InstalledNames(resolved)
		if err != nil {
			fmt.Fprintf(os.Stderr, "exec: %v\n", err)
			return 1
		}
		if len(names) == 0 {
			fmt.Fprintf(os.Stderr, "no tools installed in %s; try 'suwu tools install rg'\n", bindir.Dir(resolved))
			return 1
		}
		for _, name := range names {
			stamp, err := tools.ReadStamp(resolved, name)
			version := "?"
			if err == nil {
				version = stamp.Version
			}
			fmt.Printf("%s\t%s\t%s\n", name, version, tools.Path(resolved, name))
		}
		return 0
	}
	if wantPath != "" {
		p, ok := tools.ResolveExecutable(resolved, wantPath)
		if !ok {
			fmt.Fprintf(os.Stderr, "exec: %s is not installed in %s\n", wantPath, bindir.Dir(resolved))
			return 1
		}
		fmt.Println(p)
		return 0
	}
	if len(rest) == 0 {
		printExecUsage()
		return 64
	}

	name := rest[0]
	path, ok := resolveExecTarget(resolved, name, wantSystem)
	if !ok {
		fmt.Fprintf(os.Stderr, "exec: %s is not installed in %s (install it with: suwu tools install %s)\n",
			name, bindir.Dir(resolved), name)
		return 127
	}
	return runTool(path, name, rest[1:], bindir.Dir(resolved))
}

// resolveExecTarget is the resolution rule in one place: the managed copy wins,
// and PATH is only consulted when the caller asked for it.
func resolveExecTarget(dataDir, name string, allowSystem bool) (string, bool) {
	if p, ok := tools.ResolveExecutable(dataDir, name); ok {
		return p, true
	}
	if allowSystem {
		if sys, err := exec.LookPath(name); err == nil {
			return sys, true
		}
	}
	return "", false
}

// runTool replaces this process with the tool. PATH is prefixed with the managed
// directory so a tool that shells out to its siblings finds the managed copies.
func runTool(path, name string, args []string, binDir string) int {
	env := withBinPath(os.Environ(), binDir)
	argv := append([]string{name}, args...)
	if err := syscall.Exec(path, argv, env); err != nil {
		cmd := exec.Command(path, args...)
		cmd.Args = argv
		cmd.Env = env
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if runErr := cmd.Run(); runErr != nil {
			var exit *exec.ExitError
			if errors.As(runErr, &exit) {
				return exit.ExitCode()
			}
			fmt.Fprintf(os.Stderr, "exec: %v\n", runErr)
			return 1
		}
	}
	return 0
}

// withBinPath puts dir first on PATH, without duplicating an entry already there.
func withBinPath(env []string, dir string) []string {
	sep := string(os.PathListSeparator)
	out := make([]string, 0, len(env)+1)
	found := false
	for _, kv := range env {
		if !strings.HasPrefix(kv, "PATH=") {
			out = append(out, kv)
			continue
		}
		found = true
		value := strings.TrimPrefix(kv, "PATH=")
		if value == dir || strings.HasPrefix(value, dir+sep) {
			out = append(out, kv)
			continue
		}
		out = append(out, "PATH="+dir+sep+value)
	}
	if !found {
		out = append(out, "PATH="+dir)
	}
	return out
}
