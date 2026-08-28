// Package gencerts implements the 'suwu gencerts' flow: an interactive TUI
// (or flag-driven) generation of a TLS certificate pair signed by suwu's
// persistent local CA, stored under the suwu config directory and picked up
// automatically by 'suwu serve'.
package gencerts

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"

	"suwu/pkg/certs"
	"suwu/pkg/envfile"
)

// ErrAborted reports that the user cancelled an interactive prompt.
var ErrAborted = errors.New("cancelled")

const usageText = `Usage: suwu gencerts [flags]

Generates a TLS certificate pair signed by suwu's persistent local CA
(~/.config/suwu/CA). By default the pair is written to
~/.config/suwu/tls-cert.pem and tls-key.pem and recorded in
~/.config/suwu/.env, so 'suwu serve' enables https automatically.

Flags:
  --hosts   comma/space-separated hosts and IPs for the certificate SANs
            (skips the interactive prompts)
  --out     output directory (default ~/.config/suwu)
  --no-env  do not write TLS_CERT_FILE/TLS_KEY_FILE into ~/.config/suwu/.env
  --force   overwrite an existing certificate pair
`

type options struct {
	hosts  string
	outDir string
	noEnv  bool
	force  bool
}

// Run executes the gencerts command.
func Run(args []string) error {
	fs := flag.NewFlagSet("gencerts", flag.ContinueOnError)
	hostsFlag := fs.String("hosts", "", "comma/space-separated hosts and IPs for the certificate SANs (skips interactive prompts)")
	outFlag := fs.String("out", "", "output directory for the certificate pair (default ~/.config/suwu)")
	noEnv := fs.Bool("no-env", false, "do not write TLS_CERT_FILE/TLS_KEY_FILE into ~/.config/suwu/.env")
	force := fs.Bool("force", false, "overwrite an existing certificate pair")
	fs.Usage = func() { fmt.Fprint(fs.Output(), usageText) }
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	configDir, err := certs.DefaultDir()
	if err != nil {
		return err
	}

	opts := options{
		hosts:  *hostsFlag,
		outDir: *outFlag,
		noEnv:  *noEnv,
		force:  *force,
	}
	interactive := opts.hosts == ""
	if interactive && !isTTY() {
		fs.Usage()
		return errors.New("gencerts needs a terminal for interactive use; pass --hosts (and --out) for non-interactive generation")
	}

	var (
		hosts    []string
		outDir   string
		writeEnv bool
	)
	if interactive {
		hosts, outDir, writeEnv, err = collectInteractive(configDir, opts)
		if err != nil {
			return err
		}
	} else {
		hosts = certs.SplitHosts(opts.hosts)
		if len(hosts) == 0 {
			return errors.New("no hosts given: pass --hosts or drop the flag for interactive mode")
		}
		outDir = strings.TrimSpace(opts.outDir)
		if outDir == "" {
			outDir = configDir
		}
		writeEnv = !opts.noEnv
	}

	outDir, err = absDir(outDir)
	if err != nil {
		return err
	}

	if certs.PairExists(outDir) && !opts.force {
		if !interactive {
			return fmt.Errorf("certificate pair already exists in %s; pass --force to overwrite", outDir)
		}
		ok, err := confirmOverwrite(outDir)
		if err != nil {
			return err
		}
		if !ok {
			return ErrAborted
		}
	}

	for _, h := range hosts {
		if err := certs.ValidateHost(h); err != nil {
			return err
		}
	}

	ca, caCreated, err := certs.LoadOrCreateCA(certs.CADir(configDir))
	if err != nil {
		return err
	}
	certPEM, keyPEM, err := certs.Issue(ca, hosts)
	if err != nil {
		return err
	}
	if err := certs.WritePair(outDir, certPEM, keyPEM); err != nil {
		return err
	}

	certPath, keyPath := certs.PairPaths(outDir)
	if writeEnv {
		if err := writeConfigEnv(configDir, certPath, keyPath); err != nil {
			return err
		}
	}

	printSummary(configDir, outDir, hosts, caCreated, writeEnv)
	return nil
}

// collectInteractive runs the form that gathers hosts, the output directory,
// and whether the global config file should be updated.
func collectInteractive(configDir string, opts options) (hosts []string, outDir string, writeEnv bool, err error) {
	detected := certs.DetectHosts()
	hostOptions := make([]huh.Option[string], 0, len(detected))
	for _, h := range detected {
		hostOptions = append(hostOptions, huh.NewOption(h, h).Selected(true))
	}

	var (
		selected   []string
		extraRaw   string
		outInput   = strings.TrimSpace(opts.outDir)
		confirmEnv = !opts.noEnv
		write      = !opts.noEnv
	)
	if outInput == "" {
		outInput = configDir
	}

	fields := []huh.Field{
		huh.NewMultiSelect[string]().
			Title("Serve HTTPS on").
			Description("Hosts and IPs already detected on this machine are pre-selected.").
			Options(hostOptions...).
			Value(&selected).
			Filterable(false),
		huh.NewInput().
			Title("Additional hosts").
			Description("Optional extra domains or IPs, comma or space separated.").
			Value(&extraRaw).
			Validate(func(s string) error {
				for _, h := range certs.SplitHosts(s) {
					if err := certs.ValidateHost(h); err != nil {
						return err
					}
				}
				return nil
			}),
		huh.NewInput().
			Title("Output directory").
			Description(fmt.Sprintf("Written as %s + %s (key is chmod 600).", certs.CertFileName, certs.KeyFileName)).
			Value(&outInput).
			Validate(func(s string) error {
				expanded, err := certs.ExpandPath(strings.TrimSpace(s))
				if err != nil {
					return err
				}
				if expanded == "" {
					return errors.New("output directory is required")
				}
				if err := os.MkdirAll(expanded, 0o700); err != nil {
					return fmt.Errorf("cannot create %s: %v", expanded, err)
				}
				return nil
			}),
	}
	if confirmEnv {
		globalEnv := filepath.Join(configDir, ".env")
		fields = append(fields, huh.NewConfirm().
			Title("Update "+globalEnv+"?").
			Description("Records TLS_CERT_FILE/TLS_KEY_FILE so 'suwu serve' enables https automatically.").
			Value(&write).
			Affirmative("Yes").
			Negative("No"))
	}

	form := huh.NewForm(huh.NewGroup(fields...)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		if errors.Is(err, huh.ErrUserAborted) {
			return nil, "", false, ErrAborted
		}
		return nil, "", false, fmt.Errorf("interactive prompt failed: %w", err)
	}

	hosts = append(hosts, selected...)
	for _, h := range certs.SplitHosts(extraRaw) {
		if !contains(hosts, h) {
			hosts = append(hosts, h)
		}
	}
	if len(hosts) == 0 {
		return nil, "", false, errors.New("no hosts selected")
	}
	return hosts, outInput, write, nil
}

func confirmOverwrite(dir string) (bool, error) {
	var ok bool
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().
			Title("Certificates already exist in " + dir + ". Overwrite?").
			Value(&ok).
			Affirmative("Yes").
			Negative("No"),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		if errors.Is(err, huh.ErrUserAborted) {
			return false, ErrAborted
		}
		return false, fmt.Errorf("interactive prompt failed: %w", err)
	}
	return ok, nil
}

// writeConfigEnv records the certificate paths in the user-global config
// file and warns when a project-local .env would override them.
func writeConfigEnv(configDir, certPath, keyPath string) error {
	globalEnv := filepath.Join(configDir, ".env")
	if err := envfile.Upsert(globalEnv, map[string]string{
		"TLS_CERT_FILE": certPath,
		"TLS_KEY_FILE":  keyPath,
	}); err != nil {
		return err
	}

	if projectKeys := envFileKeys(".env"); projectKeys["TLS_CERT_FILE"] || projectKeys["TLS_KEY_FILE"] {
		fmt.Println("  ⚠️  note: ./.env sets TLS_CERT_FILE/TLS_KEY_FILE and overrides " + globalEnv)
	}
	return nil
}

func envFileKeys(path string) map[string]bool {
	keys := map[string]bool{}
	f, err := os.Open(path)
	if err != nil {
		return keys
	}
	defer f.Close()
	_ = envfile.LoadFrom(f, func(k, _ string) { keys[k] = true })
	return keys
}

func printSummary(configDir, outDir string, hosts []string, caCreated, writeEnv bool) {
	certPath, keyPath := certs.PairPaths(outDir)
	caState := "reused"
	if caCreated {
		caState = "newly created"
	}

	fmt.Println()
	fmt.Println("  ✅ TLS certificate pair generated")
	fmt.Printf("     cert: %s\n", certPath)
	fmt.Printf("     key:  %s  (chmod 600)\n", keyPath)
	fmt.Printf("     SANs: %s\n", strings.Join(hosts, ", "))
	fmt.Printf("     local CA (%s): %s\n", caState, filepath.Join(certs.CADir(configDir), certs.CACertFileName))
	if writeEnv {
		fmt.Printf("     recorded in: %s\n", filepath.Join(configDir, ".env"))
	}
	fmt.Println()
	fmt.Printf("  ▶️  Start the server: suwu serve   (https is picked up automatically)\n")
	fmt.Println("  🔑 Client devices must trust the local CA once to avoid browser warnings:")
	fmt.Printf("     copy %s to the device and install it as a CA certificate\n", filepath.Join(certs.CADir(configDir), certs.CACertFileName))
	fmt.Println("     Linux: sudo cp <rootCA.pem> /usr/local/share/ca-certificates/suwu-local.crt && sudo update-ca-certificates")
}

func absDir(dir string) (string, error) {
	expanded, err := certs.ExpandPath(strings.TrimSpace(dir))
	if err != nil {
		return "", err
	}
	if expanded == "" {
		return "", errors.New("output directory is required")
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return "", fmt.Errorf("cannot create %s: %v", abs, err)
	}
	return abs, nil
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func isTTY() bool {
	return isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd())
}
