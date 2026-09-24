package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"suwu/pkg/gqjs"
)

// gqStringList collects repeatable string flags.
type gqStringList []string

func (s *gqStringList) String() string { return strings.Join(*s, ",") }
func (s *gqStringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

const gqUsageText = `Usage: suwu gq [flags] <script.js>

Run a single JavaScript file in a request-scoped QuickJS sandbox and print its
captured output. Mirrors the gqjs CLI: a fresh isolate per run, an optional
input payload, capability-scoped filesystem roots, and a hard deadline.

Flags:
  --timeout <dur>        per-request timeout (e.g. 2s); default 5s
  --root <virtual=real>  mount a host directory (repeatable), e.g. /app=./src
  --ro                   make the filesystem read-only
  --env <KEY=VALUE>      set an environment variable (repeatable)
  --input <json>         input payload as JSON
  --input-file <file>    read the input payload from a file
  --cwd <dir>            virtual working directory (default /)
  --arg <value>          append an entry to process.argv (repeatable)
  --print-result         print the JSON result to stdout

Exit codes:
  0 success, 1 script/runtime error, 2 timeout, 3 output limit, 64 usage error

Examples:
  suwu gq --print-result examples/gqjs/hello.js
  suwu gq --root /app=./examples/gqjs --input '{"n":21}' --print-result examples/gqjs/handler.js
  suwu gq --timeout 300ms examples/gqjs/timeout.js
`

func printGqUsage() { fmt.Fprint(os.Stderr, gqUsageText) }

// gqMain implements `suwu gq`. It returns the process exit code so the gqjs
// codes (2 timeout, 3 output limit, 64 usage) survive; the caller os.Exit's it.
func gqMain(args []string) int {
	fs := flag.NewFlagSet("gq", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.Usage = printGqUsage

	var (
		timeout     = fs.Duration("timeout", 0, "per-request timeout (e.g. 2s); default 5s")
		roots       gqStringList
		readOnly    = fs.Bool("ro", false, "make the filesystem read-only")
		vars        gqStringList
		input       = fs.String("input", "", "input payload as JSON")
		inputFile   = fs.String("input-file", "", "read the input payload from a file")
		cwd         = fs.String("cwd", "/", "virtual working directory")
		extraArgs   gqStringList
		printResult = fs.Bool("print-result", false, "print the JSON result to stdout")
	)
	fs.Var(&roots, "root", "mount a host directory as virtual=real (repeatable), e.g. /app=./src")
	fs.Var(&vars, "env", "set an environment variable KEY=VALUE (repeatable)")
	fs.Var(&extraArgs, "arg", "append an entry to process.argv (repeatable)")

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 64
	}
	if fs.NArg() != 1 {
		printGqUsage()
		return 64
	}
	scriptPath := fs.Arg(0)

	source, err := os.ReadFile(scriptPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu gq: read script: %v\n", err)
		return 1
	}

	env, err := buildGqEnv(*timeout, roots, *readOnly, vars, *input, *inputFile, *cwd, extraArgs, scriptPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu gq: %v\n", err)
		return 64
	}

	res, err := gqjs.New().Run(context.Background(), string(source), env)
	if err != nil {
		// gqjs errors already carry their own prefix.
		fmt.Fprintf(os.Stderr, "%v\n", err)
		switch {
		case errors.Is(err, gqjs.ErrTimeout):
			return 2
		case errors.Is(err, gqjs.ErrOutputLimit):
			return 3
		default:
			return 1
		}
	}

	// PHP-like echo semantics: script output goes to the process streams.
	if res.Stdout != "" {
		fmt.Fprint(os.Stdout, res.Stdout)
	}
	if res.Stderr != "" {
		fmt.Fprint(os.Stderr, res.Stderr)
	}
	if *printResult && res.JSON != "" && res.JSON != "null" {
		fmt.Fprintln(os.Stdout, res.JSON)
	}
	return 0
}

// buildGqEnv assembles a gqjs.Env from the CLI flags.
func buildGqEnv(
	timeout time.Duration,
	roots gqStringList,
	readOnly bool,
	vars gqStringList,
	input string,
	inputFile string,
	cwd string,
	extraArgs gqStringList,
	scriptPath string,
) (gqjs.Env, error) {
	env := gqjs.Env{
		Timeout: timeout,
		CWD:     cwd,
		Args:    []string{scriptPath},
		Vars:    map[string]string{},
		FS:      gqjs.FSConfig{ReadOnly: readOnly},
	}

	for _, kv := range vars {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			return env, fmt.Errorf("invalid --env %q, want KEY=VALUE", kv)
		}
		env.Vars[k] = v
	}

	if len(roots) > 0 {
		env.FS.Roots = make(map[string]string, len(roots))
		for _, r := range roots {
			virtual, real, ok := strings.Cut(r, "=")
			if !ok || virtual == "" || real == "" {
				return env, fmt.Errorf("invalid --root %q, want VIRTUAL=REAL", r)
			}
			env.FS.Roots[virtual] = real
		}
	}

	env.Args = append(env.Args, extraArgs...)

	switch {
	case inputFile != "":
		b, err := os.ReadFile(inputFile)
		if err != nil {
			return env, fmt.Errorf("read input file: %w", err)
		}
		if !json.Valid(b) {
			return env, fmt.Errorf("input file %q is not valid JSON", inputFile)
		}
		env.InputJSON = b
	case input != "":
		if !json.Valid([]byte(input)) {
			return env, fmt.Errorf("--input is not valid JSON")
		}
		env.InputJSON = []byte(input)
	}

	return env, nil
}
