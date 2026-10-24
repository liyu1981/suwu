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
)

// Main is the suwu-max entry point. bundle is the embedded payload FS; it may
// be nil when the launcher was built without the `max` tag.
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
	dirFlag := fl.String("dir", "", "install directory (default ~/.suwu/bin)")
	noPath := fl.Bool("no-path", false, "do not modify shell rc files")
	extractOnly := fl.Bool("extract-only", false, "extract the payload and exit")
	force := fl.Bool("force", false, "re-extract even if this version is installed")
	showVersion := fl.Bool("version", false, "print launcher and payload versions")
	printPath := fl.Bool("print-path", false, "print the install directory and exit")
	if err := fl.Parse(argv); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	rest := fl.Args()

	dir, err := resolveDir(*dirFlag)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu-max: %v\n", err)
		return 1
	}

	if *showVersion {
		printVersion(bundle, launcherVersion)
		return 0
	}
	if *printPath {
		fmt.Println(dir)
		return 0
	}

	if bundle == nil {
		fmt.Fprintln(os.Stderr, "suwu-max: this executable was built without a payload; build it with 'go build -tags max'")
		return 1
	}

	if *extractOnly {
		res, err := Ensure(bundle, dir, *force)
		if err != nil {
			fmt.Fprintf(os.Stderr, "suwu-max: extract: %v\n", err)
			return 1
		}
		if res.FirstRun {
			fmt.Printf("Extracted suwu-max payload to %s\n", dir)
		} else {
			fmt.Printf("Already installed in %s\n", dir)
		}
		if !*noPath && !envNoPath() {
			printPathChange(dir)
		}
		return 0
	}

	res, err := Ensure(bundle, dir, *force)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu-max: extract: %v\n", err)
		return 1
	}
	if res.FirstRun {
		fmt.Fprintf(os.Stderr, "Installed suwu-max payload in %s\n", dir)
		if !*noPath && !envNoPath() {
			printPathChange(dir)
		}
		warnMissingDependencies(bundle)
	}

	target := filepath.Join(dir, MainBinary)
	env := withPath(os.Environ(), dir)
	env = append(env, "SUWU_MAX=1", "SUWU_BIN="+dir)

	// Replace this process with the real binary: signals, exit status and the
	// terminal belong to it, with no extra parent in between.
	if err := syscall.Exec(target, append([]string{target}, rest...), env); err != nil {
		cmd := exec.Command(target, rest...)
		cmd.Env = env
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if runErr := cmd.Run(); runErr != nil {
			var exit *exec.ExitError
			if errors.As(runErr, &exit) {
				return exit.ExitCode()
			}
			fmt.Fprintf(os.Stderr, "suwu-max: run %s: %v\n", target, runErr)
			return 1
		}
	}
	return 0
}

// resolveDir applies --dir, then SUWU_MAX_DIR, then ~/.suwu/bin.
func resolveDir(flagValue string) (string, error) {
	if flagValue != "" {
		return filepath.Abs(flagValue)
	}
	if env := strings.TrimSpace(os.Getenv("SUWU_MAX_DIR")); env != "" {
		return filepath.Abs(env)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot find home directory: %w", err)
	}
	return BundlePath(home), nil
}

func envNoPath() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("SUWU_MAX_NO_PATH"))) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// withPath returns env with dir prepended to PATH (replacing any existing PATH).
func withPath(env []string, dir string) []string {
	out := make([]string, 0, len(env)+1)
	replaced := false
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			out = append(out, "PATH="+dir+string(os.PathListSeparator)+strings.TrimPrefix(kv, "PATH="))
			replaced = true
			continue
		}
		out = append(out, kv)
	}
	if !replaced {
		out = append(out, "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	return out
}

func printPathChange(dir string) {
	changed, err := EnsurePath(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu-max: could not update PATH: %v\n", err)
		return
	}
	if len(changed) == 0 {
		return
	}
	fmt.Printf("Added %s to PATH in %s\n", dir, strings.Join(changed, ", "))
	fmt.Println("Open a new shell (or source the file) to use the bundled tools there.")
}

func setupPathCmd(args []string) int {
	fl := flag.NewFlagSet("suwu-max setup-path", flag.ContinueOnError)
	dirFlag := fl.String("dir", "", "install directory (default ~/.suwu/bin)")
	if err := fl.Parse(args); err != nil {
		return 2
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu-max: %v\n", err)
		return 1
	}
	changed, err := EnsurePath(dir)
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
	changed, err := RemovePath()
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
				payload = manifest.Version + " (" + manifest.GOOS + "/" + manifest.GOARCH + ")"
			}
		}
	}
	fmt.Printf("suwu-max %s · payload %s · %s/%s\n", launcherVersion, payload, runtime.GOOS, runtime.GOARCH)
}

// warnMissingDependencies flags the one bundled tool with an external runtime
// dependency: asdf needs git.
func warnMissingDependencies(bundle fs.FS) {
	manifestData, err := fs.ReadFile(bundle, "manifest.json")
	if err != nil {
		return
	}
	manifest, err := ParseManifest(manifestData)
	if err != nil {
		return
	}
	hasAsdf := false
	for _, e := range manifest.Entries {
		if e.Name == "asdf" || e.File == "asdf" {
			hasAsdf = true
			break
		}
	}
	if hasAsdf {
		if _, err := exec.LookPath("git"); err != nil {
			fmt.Fprintln(os.Stderr, "warning: asdf is bundled but git was not found on PATH; install git to manage runtimes with asdf.")
		}
	}
}
