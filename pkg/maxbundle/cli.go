package maxbundle

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"suwu/pkg/bindir"
)

// Main is the suwu-max entry point. bundle is the embedded payload FS; it may
// be nil when the launcher was built without the `max` tag.
//
// One run installs and then becomes the app:
//
//	suwu-max [flags] [args…]   install (idempotent), then exec ~/.local/bin/suwu
//	suwu-max setup-path        only put ~/.local/bin on PATH
//	suwu-max unsetup-path      only remove that block
func Main(bundle fs.FS, launcherVersion string, argv []string) int {
	if len(argv) > 0 {
		switch argv[0] {
		case "setup-path":
			return setupPathCmd(argv[1:])
		case "unsetup-path":
			return removePathCmd(argv[1:])
		}
	}

	fl := flag.NewFlagSet("suwu-max", flag.ContinueOnError)
	fl.SetOutput(os.Stderr)
	dataDir := fl.String("data-dir", "", "data directory (default ~/.suwu)")
	dirFlag := fl.String("dir", "", "tool directory (default <data-dir>/bin)")
	appDir := fl.String("app-dir", "", "where the app goes (default ~/.local/bin)")
	noPath := fl.Bool("no-path", false, "do not modify shell rc files")
	extractOnly := fl.Bool("extract-only", false, "install and exit, without running the app")
	force := fl.Bool("force", false, "re-install the app and every tool")
	showVersion := fl.Bool("version", false, "print launcher and payload versions")
	printPath := fl.Bool("print-path", false, "print the tool directory and exit")
	if err := fl.Parse(argv); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	rest := fl.Args()

	opt := Options{Force: *force, NoPath: *noPath}
	opt.DataDir = firstNonEmpty(*dataDir, os.Getenv("SUWU_MAX_DATA_DIR"))
	opt.AppDir = firstNonEmpty(*appDir, os.Getenv("SUWU_MAX_APP_DIR"))
	// --dir has always meant the tool directory; it still does, and the data dir
	// follows from it so the stamps and the lock land beside the tools.
	opt.BinDir = firstNonEmpty(*dirFlag, os.Getenv("SUWU_MAX_DIR"))
	if opt.DataDir == "" && opt.BinDir != "" {
		opt.DataDir = dataDirForBinDir(opt.BinDir)
	}
	opt.NoPath = opt.NoPath || envNoPath()

	if *showVersion {
		printVersion(bundle, launcherVersion)
		return 0
	}
	res, prepared, err := prepare(opt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu-max: %v\n", err)
		return 1
	}
	if *printPath {
		fmt.Println(prepared.BinDir)
		return 0
	}

	res, err = Install(bundle, opt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu-max: %v\n", err)
		return 1
	}
	report(res)

	if *extractOnly {
		return 0
	}
	return execApp(res.AppPath, rest)
}

// dataDirForBinDir recovers the data dir from a tool directory override, so
// `--dir /opt/tools` keeps its stamps in /opt (and not in the default home).
func dataDirForBinDir(binDir string) string {
	abs, err := filepath.Abs(binDir)
	if err != nil {
		return binDir
	}
	if filepath.Base(abs) == "bin" {
		return filepath.Dir(abs)
	}
	return abs
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func envNoPath() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("SUWU_MAX_NO_PATH"))) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// report prints what changed, and only what changed: a second run says nothing
// but "already installed".
func report(res *Result) {
	if res.AppInstalled {
		fmt.Printf("Installed %s\n", res.AppPath)
	} else {
		fmt.Printf("%s is already installed (kept; use --force to replace it)\n", res.AppPath)
	}
	for _, t := range res.Tools {
		switch {
		case t.Skipped:
			fmt.Printf("  %s %s kept: installed here, the bundle does not overwrite it\n", t.Name, t.Version)
		case t.Installed:
			fmt.Printf("  %s %s\n", t.Name, t.Version)
		}
	}
	fmt.Printf("Tools are in %s\n", res.BinDir)
	for _, f := range res.PathChanged {
		fmt.Printf("Added %s to PATH in %s\n", filepath.Dir(res.AppPath), f)
	}
	for _, f := range res.PathRemoved {
		fmt.Printf("Removed the old suwu-max PATH block from %s (the tool directory no longer needs to be on PATH)\n", f)
	}
	for _, w := range res.Warnings {
		fmt.Fprintln(os.Stderr, "warning: "+w)
	}
}

// execApp replaces this process with the app: signals, exit status and the
// terminal belong to it, with no extra parent in between.
func execApp(path string, args []string) int {
	if err := syscall.Exec(path, append([]string{path}, args...), os.Environ()); err != nil {
		cmd := exec.Command(path, args...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if runErr := cmd.Run(); runErr != nil {
			var exit *exec.ExitError
			if errors.As(runErr, &exit) {
				return exit.ExitCode()
			}
			fmt.Fprintf(os.Stderr, "suwu-max: run %s: %v\n", path, runErr)
			return 1
		}
	}
	return 0
}

func setupPathCmd(args []string) int {
	fl := flag.NewFlagSet("suwu-max setup-path", flag.ContinueOnError)
	appDir := fl.String("app-dir", "", "directory holding the app (default ~/.local/bin)")
	if err := fl.Parse(args); err != nil {
		return 2
	}
	dir := *appDir
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintf(os.Stderr, "suwu-max: %v\n", err)
			return 1
		}
		dir = filepath.Join(home, ".local", "bin")
	}
	changed, err := bindir.EnsurePath(dir, bindir.MaxBlock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu-max: %v\n", err)
		return 1
	}
	if len(changed) == 0 {
		fmt.Println("PATH is already configured.")
	} else {
		fmt.Printf("Added %s to PATH in %s\n", dir, strings.Join(changed, ", "))
	}
	return 0
}

func removePathCmd(args []string) int {
	fl := flag.NewFlagSet("suwu-max unsetup-path", flag.ContinueOnError)
	if err := fl.Parse(args); err != nil {
		return 2
	}
	changed, err := bindir.RemovePath(bindir.MaxBlock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu-max: %v\n", err)
		return 1
	}
	if len(changed) == 0 {
		fmt.Println("No suwu-max PATH block found.")
	} else {
		fmt.Printf("Removed the suwu-max PATH block from %s\n", strings.Join(changed, ", "))
	}
	return 0
}

func printVersion(bundle fs.FS, launcherVersion string) {
	payload := "none"
	if bundle != nil {
		if data, err := fs.ReadFile(bundle, "manifest.json"); err == nil {
			if manifest, err := ParseManifest(data); err == nil {
				payload = fmt.Sprintf("%s (%s/%s, %d tools)", manifest.Version, manifest.GOOS, manifest.GOARCH, len(manifest.Tools))
			}
		}
	}
	fmt.Printf("suwu-max %s · payload %s · %s/%s\n", launcherVersion, payload, runtime.GOOS, runtime.GOARCH)
}

// dependencyWarnings names the one bundled tool with an external runtime
// dependency: asdf shells out to git for every install.
func dependencyWarnings(manifest *Manifest) []string {
	var out []string
	for _, t := range manifest.Tools {
		if t.Name != "asdf" {
			continue
		}
		if _, err := exec.LookPath("git"); err != nil {
			out = append(out, "asdf is installed but git was not found on PATH; install git to manage runtimes with asdf")
		}
	}
	return out
}
