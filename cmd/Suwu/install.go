// Command suwu install puts backgrounds and extensions into the Suwu data
// directory, from a zip archive or from the first-party GitHub catalog, and
// with an interactive picker when a terminal is available.
//
// It is a filesystem operation, not a server operation: the registries are read
// from disk per request, so anything installed here is live on the next page
// load without restarting Suwu.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"

	"suwu/pkg/extension"
	"suwu/pkg/install"
)

// installExitUsage is the usage-error exit code, matching `suwu gq`.
const installExitUsage = 64

// valueFlags are the flags that consume the following argument, which reorder
// flags must know about so it does not mistake a value for a name.
var valueFlags = map[string]bool{
	"extension": true, "background": true, "kind": true,
	"repo": true, "ref": true, "token": true, "id": true,
}

// reorderFlags moves non-flag arguments after the flags, stopping at "--".
// It is a convenience, not a parser: a malformed combination is still
// reported by flag.Parse.
func reorderFlags(args []string, takesValue map[string]bool) []string {
	var flags, names []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--":
			// Everything after "--" is positional by convention.
			names = append(names, args[i+1:]...)
			return append(flags, names...)
		case strings.HasPrefix(arg, "-") && arg != "-":
			flags = append(flags, arg)
			// A "--flag=value" carries its value; a bare "--flag value" does not.
			if !strings.Contains(arg, "=") {
				name := strings.TrimLeft(arg, "-")
				if takesValue[name] && i+1 < len(args) {
					i++
					flags = append(flags, args[i])
				}
			}
		default:
			names = append(names, arg)
		}
	}
	return append(flags, names...)
}

func printInstallUsage() {
	fmt.Print(`Usage: suwu install [flags] [<name>...]

Install backgrounds and extensions into the Suwu data directory
(default ~/.suwu, override with SUWU_VAR). With no mode flag and a terminal,
an interactive picker offers the catalog from GitHub.

Modes (mutually exclusive):
  (none)                    interactive catalog picker (requires a TTY)
  --github                  the same picker, named explicitly
  --extension <file.zip>    install one extension from a zip archive
  --background <file.zip>   install one background from a zip archive

Catalog flags (with --github, or the bare form):
  --kind <extension|background>  restrict the picker to one kind
  --all                          install every item of --kind
  --list                         print the catalog and exit
  --repo <owner/name>            source repository (default ` + install.DefaultRepo + `)
  --ref <ref>                    source ref (default ` + install.DefaultRef + `)
  --token <token>                GitHub token; or $SUWU_GITHUB_TOKEN
  --refresh                      bypass the cached catalog

Common flags:
  --force         replace an existing install of the same id
  --dry-run       report what would be written; change nothing

Names may be given positionally to install without a TTY:
  suwu install --github eye note
  suwu install --github --kind background matrix-rain

Archive layout:
  extension/<id>/…            for --extension
  background/webgpu/<id>/…    for --background
A zip containing a single bare <id>/… directory is also accepted.

Exit codes: 0 ok · 1 install failure · ` + fmt.Sprint(installExitUsage) + ` usage error
`)
}

// installFlags mirrors the command line.
type installFlags struct {
	github     bool
	extension  string
	background string
	kind       string
	all        bool
	list       bool
	repo       string
	ref        string
	token      string
	refresh    bool
	force      bool
	dryRun     bool
	ids        idList
	names      []string
}

// idList collects a repeatable --id flag.
type idList []string

func (l *idList) String() string     { return strings.Join(*l, ",") }
func (l *idList) Set(v string) error { *l = append(*l, v); return nil }

func installCmd(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.Usage = printInstallUsage
	var f installFlags
	fs.BoolVar(&f.github, "github", false, "install from the GitHub catalog")
	fs.StringVar(&f.extension, "extension", "", "install one extension from a zip archive")
	fs.StringVar(&f.background, "background", "", "install one background from a zip archive")
	fs.StringVar(&f.kind, "kind", "", "restrict to one kind (extension or background)")
	fs.Var(&f.ids, "id", "install this catalog id (repeatable)")
	fs.BoolVar(&f.all, "all", false, "install every catalog item of --kind")
	fs.BoolVar(&f.list, "list", false, "print the catalog and exit")
	fs.StringVar(&f.repo, "repo", install.DefaultRepo, "source repository")
	fs.StringVar(&f.ref, "ref", install.DefaultRef, "source ref")
	fs.StringVar(&f.token, "token", "", "GitHub token")
	fs.BoolVar(&f.refresh, "refresh", false, "bypass the cached catalog")
	fs.BoolVar(&f.force, "force", false, "replace an existing install of the same id")
	fs.BoolVar(&f.dryRun, "dry-run", false, "report what would be written")
	// Go's flag package stops at the first positional argument, so
	// `suwu install --github eye --force` would silently treat --force as a
	// name. Reordering keeps both spellings working.
	if err := fs.Parse(reorderFlags(args, valueFlags)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		os.Exit(installExitUsage)
	}
	f.names = append(append([]string{}, f.ids...), fs.Args()...)

	if err := f.checkModes(); err != nil {
		fmt.Fprintf(os.Stderr, "install: %v\n", err)
		os.Exit(installExitUsage)
	}
	dataDir, err := installDataDir()
	if err != nil {
		return err
	}
	opt := install.Options{DataDir: dataDir, Force: f.force, DryRun: f.dryRun}

	switch {
	case f.extension != "":
		item, err := install.FromArchiveFile(install.KindExtension, f.extension, opt)
		if err := reportItem(item, err, opt); err != nil {
			return err
		}
		installSummary(1, 0, opt, map[install.Kind]bool{item.Kind: true})
		return nil
	case f.background != "":
		item, err := install.FromArchiveFile(install.KindBackground, f.background, opt)
		if err := reportItem(item, err, opt); err != nil {
			return err
		}
		installSummary(1, 0, opt, map[install.Kind]bool{item.Kind: true})
		return nil
	}

	client := install.NewClient(f.repo, f.ref, f.tokenOrEnv())
	cat, err := loadCatalog(client, dataDir, f.refresh, f.list)
	if err != nil {
		return err
	}
	if f.list {
		printCatalog(cat, dataDir)
		return nil
	}

	selected, err := f.selectItems(cat, dataDir)
	if err != nil {
		return err
	}
	if len(selected) == 0 {
		fmt.Println("\n  Nothing selected.")
		return nil
	}
	if !f.force && f.confirmReplace(selected, dataDir) == false {
		fmt.Println("  Cancelled. No changes were made.")
		return nil
	}
	return f.installAll(client, selected, opt)
}

// checkModes rejects conflicting or unusable flag combinations before anything
// is fetched or written.
func (f *installFlags) checkModes() error {
	modes := 0
	for _, on := range []bool{f.github, f.extension != "", f.background != ""} {
		if on {
			modes++
		}
	}
	if modes > 1 {
		return errors.New("--github, --extension and --background are mutually exclusive")
	}
	if f.extension != "" && f.background != "" {
		return errors.New("--extension and --background are mutually exclusive")
	}
	if f.kind != "" {
		if _, err := install.KindFromString(f.kind); err != nil {
			return err
		}
		if f.extension != "" || f.background != "" {
			return errors.New("--kind does not apply to a zip archive; use --extension or --background")
		}
	}
	if f.all && len(f.names) > 0 {
		return errors.New("--all and explicit names cannot be combined")
	}
	if f.refresh && f.extension != "" {
		return errors.New("--refresh does not apply to a zip archive")
	}
	return nil
}

func (f *installFlags) tokenOrEnv() string {
	if f.token != "" {
		return f.token
	}
	if v := os.Getenv("SUWU_GITHUB_TOKEN"); v != "" {
		return v
	}
	return os.Getenv("GITHUB_TOKEN")
}

// installDataDir resolves the data directory the same way the server does.
func installDataDir() (string, error) {
	if v := strings.TrimSpace(os.Getenv("SUWU_VAR")); v != "" {
		abs, err := filepath.Abs(v)
		if err != nil {
			return "", err
		}
		return abs, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate the data directory: %w", err)
	}
	return filepath.Join(home, ".suwu"), nil
}

// loadCatalog fetches the catalog, showing a spinner-free progress line because
// it is one request.
func loadCatalog(client *install.Client, dataDir string, refresh, quiet bool) (*install.Catalog, error) {
	if !quiet {
		fmt.Printf("  Reading the catalog from %s …\n", client.Source())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cacheDir := filepath.Join(dataDir, "cache")
	cat, err := client.LoadCatalog(ctx, cacheDir, refresh)
	if err != nil {
		return nil, fmt.Errorf("read the catalog: %w", err)
	}
	return cat, nil
}

// printCatalog is the non-interactive view: one line per item, marked when it
// is already installed.
func printCatalog(cat *install.Catalog, dataDir string) {
	for _, kind := range install.Kinds() {
		entries := cat.OfKind(kind)
		fmt.Printf("\n  %s\n", strings.ToUpper(kind.Label()))
		if len(entries) == 0 {
			fmt.Println("  (none found in the catalog)")
			continue
		}
		for _, e := range entries {
			mark := " "
			if e.Installed {
				mark = "•"
			}
			label := e.Name
			if label == "" {
				label = e.ID
			}
			fmt.Printf("  %s %-16s %-4s %s\n", mark, e.ID, fmt.Sprintf("%dF", len(e.Files)), label)
		}
	}
	fmt.Printf("\n  %d item(s) from %s. %s marks an installed item.\n",
		len(cat.Entries), cat.Repo+"@"+cat.Ref, "•")
}

// selectItems resolves what to install: explicit names, --all, or the TUI.
func (f *installFlags) selectItems(cat *install.Catalog, dataDir string) ([]install.CatalogEntry, error) {
	for i := range cat.Entries {
		e := &cat.Entries[i]
		e.Installed = e.Kind.Installed(dataDir, e.ID)
	}

	if len(f.names) > 0 {
		return pickByName(cat, f.names)
	}
	kind, err := requestedKind(f.kind)
	if err != nil {
		return nil, err
	}
	if f.all {
		return cat.OfKind(kind), nil
	}
	return f.pickInteractively(cat, dataDir, kind)
}

func requestedKind(s string) (install.Kind, error) {
	if s == "" {
		return install.KindExtension, nil
	}
	return install.KindFromString(s)
}

// pickByName matches names against "<kind>/<id>" or a bare id, so both kinds can
// be named on one command line.
func pickByName(cat *install.Catalog, names []string) ([]install.CatalogEntry, error) {
	var out []install.CatalogEntry
	var missing []string
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		kind := ""
		id := name
		if k, rest, ok := strings.Cut(name, "/"); ok {
			parsed, err := install.KindFromString(k)
			if err != nil {
				return nil, fmt.Errorf("%q: %w", name, err)
			}
			kind, id = string(parsed), rest
		}
		found := false
		for _, kindWant := range install.Kinds() {
			if kind != "" && string(kindWant) != kind {
				continue
			}
			if e, ok := cat.Find(kindWant, id); ok {
				out = append(out, e)
				found = true
				break
			}
		}
		if !found {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("not in the catalog: %s (see --list)", strings.Join(missing, ", "))
	}
	return out, nil
}

// pickInteractively asks which kind, then which items, then confirms a
// replacement. It mirrors `suwu agent`, including the isatty guard: a
// non-interactive run gets a pointer to the flags instead of a TUI it cannot
// draw.
func (f *installFlags) pickInteractively(cat *install.Catalog, dataDir string, kind install.Kind) ([]install.CatalogEntry, error) {
	interactive := isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd())
	if !interactive {
		return nil, fmt.Errorf("no interactive terminal; pass names, --all or --list " +
			"(e.g. suwu install --github --all)")
	}

	if f.kind == "" {
		kinds := make([]huh.Option[string], 0, len(install.Kinds()))
		counts := map[string]int{}
		for _, e := range cat.Entries {
			counts[string(e.Kind)]++
		}
		for _, k := range install.Kinds() {
			if counts[string(k)] == 0 {
				continue
			}
			kinds = append(kinds, huh.NewOption(
				fmt.Sprintf("%s (%d)", titleCase(string(k)), counts[string(k)]),
				string(k)))
		}
		if len(kinds) == 0 {
			return nil, errors.New("the catalog is empty")
		}
		choice := string(install.KindExtension)
		form := huh.NewForm(huh.NewGroup(
			huh.NewSelect[string]().
				Title("What do you want to install?").
				Options(kinds...).
				Value(&choice),
		)).WithTheme(tuiTheme())
		if err := form.Run(); err != nil {
			return nil, err
		}
		parsed, err := install.KindFromString(choice)
		if err != nil {
			return nil, err
		}
		kind = parsed
	}

	entries := cat.OfKind(kind)
	if len(entries) == 0 {
		return nil, fmt.Errorf("no %ss in the catalog at %s", kind.Label(), cat.Repo+"@"+cat.Ref)
	}
	// Already-installed items are pre-selected so a refresh is one keypress.
	selected := make([]string, 0, len(entries))
	options := make([]huh.Option[string], 0, len(entries))
	for _, e := range entries {
		label := e.Name
		if label == "" {
			label = e.ID
		}
		opt := huh.NewOption(fmt.Sprintf("%-16s %s", e.ID, label), e.ID)
		if e.Installed {
			opt = opt.Selected(true)
			selected = append(selected, e.ID)
		}
		options = append(options, opt)
	}
	form := huh.NewForm(huh.NewGroup(
		huh.NewMultiSelect[string]().
			Title(fmt.Sprintf("Install which %ss?", kind.Label())).
			Description("Installed items are pre-selected. Space toggles, enter confirms.").
			Options(options...).
			Value(&selected),
	)).WithTheme(tuiTheme())
	if err := form.Run(); err != nil {
		return nil, err
	}

	var out []install.CatalogEntry
	for _, id := range selected {
		if e, ok := cat.Find(kind, id); ok {
			out = append(out, e)
		}
	}
	return out, nil
}

// confirmReplace asks once when any selected item already exists and --force
// was not passed.
func (f *installFlags) confirmReplace(entries []install.CatalogEntry, dataDir string) bool {
	var existing []string
	for _, e := range entries {
		if e.Kind.Installed(dataDir, e.ID) {
			existing = append(existing, e.ID)
		}
	}
	if len(existing) == 0 {
		return true
	}
	if !isatty.IsTerminal(os.Stdin.Fd()) {
		// Non-interactive: refuse rather than destroy something.
		fmt.Fprintf(os.Stderr, "  Already installed: %s\n", strings.Join(existing, ", "))
		return false
	}
	ok := false
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().
			Title(fmt.Sprintf("%d item(s) already exist. Replace them?", len(existing))).
			Description(strings.Join(existing, ", ") + "\nA copy is kept until the new one is in place.").
			Affirmative("Replace").
			Negative("Cancel").
			Value(&ok),
	)).WithTheme(tuiTheme())
	if err := form.Run(); err != nil {
		return false
	}
	return ok
}

// installAll installs the selected catalog items, reporting each one and
// continuing past a single failure so a bad item does not abort the batch.
func (f *installFlags) installAll(client *install.Client, entries []install.CatalogEntry, opt install.Options) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	var failed int
	kinds := map[install.Kind]bool{}
	for _, e := range entries {
		item, err := client.InstallCatalogEntry(ctx, e, opt)
		kinds[e.Kind] = true
		if err != nil {
			failed++
			fmt.Printf("  ❌ %-10s %-16s %v\n", e.Kind.Label(), e.ID, err)
			continue
		}
		reportItem(item, nil, opt)
	}
	installSummary(len(entries)-failed, failed, opt, kinds)
	if failed > 0 {
		return fmt.Errorf("%d of %d item(s) failed", failed, len(entries))
	}
	return nil
}

// reportItem prints one install result, or the error that replaced it.
func reportItem(item install.Item, err error, opt install.Options) error {
	if err != nil {
		label := item.ID
		if label == "" {
			label = "archive"
		}
		fmt.Printf("  ❌ %-10s %-16s %v\n", item.Kind.Label(), label, err)
		return err
	}
	mark := "✅"
	if opt.DryRun {
		mark = "would install"
	}
	fmt.Printf("  %-13s %-10s %-16s %s  %d file(s), %s\n",
		mark, item.Kind.Label(), item.ID, item.Dir, item.Files, humanBytes(item.Bytes))
	for _, w := range item.Warnings {
		fmt.Printf("     ⚠️  %s\n", w)
	}
	return nil
}

// installSummary prints the "what now" block once per run, with only the hints
// for the kinds that were actually installed.
func installSummary(ok, _ int, opt install.Options, kinds map[install.Kind]bool) {
	if ok == 0 {
		return
	}
	if opt.DryRun {
		fmt.Printf("\n  Dry run: nothing was written, so nothing in %s changed.\n", opt.DataDir)
		return
	}
	fmt.Printf("\n%s\n", strings.Repeat("-", 60))
	if notice := extensionLegacyNotice(opt.DataDir); notice != "" {
		fmt.Print(notice)
	}
	fmt.Println("  Reload the Suwu tab to pick them up.")
	if kinds[install.KindExtension] {
		fmt.Println("  Extensions: enable the Extension app in the App Menu, then add a tile with the id above.")
	}
	if kinds[install.KindBackground] {
		fmt.Println("  Backgrounds: choose one in Settings → Background.")
	}
}

// extensionLegacyNotice returns the migration hint when the pre-rename
// extensions directory still holds extensions. suwu install never writes there,
// so the user moves it themselves.
func extensionLegacyNotice(dataDir string) string {
	if !extension.ResolveDir(dataDir).LegacyPresent {
		return ""
	}
	return fmt.Sprintf("  Note: %s still holds extensions; move it to %s to keep using it.\n",
		extension.LegacyDir(dataDir), extension.Dir(dataDir))
}

// titleCase upper-cases the first letter. The kinds are ASCII words, so this is
// all the capitalisation the picker needs.
func titleCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// humanBytes formats a size for the install summary.
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit && exp < 3; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGT"[exp])
}
