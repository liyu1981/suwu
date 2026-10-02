package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"suwu/pkg/backup"
	"suwu/pkg/update"
)

func upgradeCmd(args []string) error {
	fs := flag.NewFlagSet("upgrade", flag.ContinueOnError)
	checkOnly := fs.Bool("check", false, "check for updates without upgrading")
	force := fs.Bool("force", false, "re-download even if already up to date")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if update.IsDevBuild() {
		fmt.Println("Warning: running a dev build — skipping update check.")
		fmt.Println("Build with version tag to enable self-updates.")
		reportBackup()
		return nil
	}

	fmt.Println("Checking for updates...")

	info, err := update.CheckLatest(context.Background())
	if err != nil {
		return fmt.Errorf("check for updates: %w", err)
	}

	current := update.CurrentVersion()
	latest := info.Version

	fmt.Printf("Current version: %s\n", current)
	fmt.Printf("Latest version:  %s\n", latest)

	if !update.IsNewer(current, latest) && !*force {
		fmt.Println("Already up to date.")
		reportBackup()
		return nil
	}

	if *checkOnly {
		if update.IsNewer(current, latest) {
			fmt.Println("Update available.")
		} else {
			fmt.Println("Already up to date.")
		}
		reportBackup()
		return nil
	}

	asset, err := update.FindAsset(info.Assets)
	if err != nil {
		return err
	}

	fmt.Printf("Download: %s (%s)\n", asset.Name, asset.BrowserDownloadURL)

	binPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}

	wasRunning := update.IsDaemonRunning()
	if wasRunning {
		fmt.Println("Stopping daemon...")
		if err := update.StopDaemon(); err != nil {
			return fmt.Errorf("stop daemon: %w", err)
		}
	}

	fmt.Println("Downloading and replacing binary...")
	if err := update.DownloadAndReplace(context.Background(), *asset, binPath); err != nil {
		return fmt.Errorf("upgrade: %w", err)
	}

	fmt.Printf("Upgraded: %s -> %s\n", current, latest)

	if wasRunning {
		fmt.Println("Restarting daemon...")
		if err := update.StartDaemon(); err != nil {
			return fmt.Errorf("restart daemon: %w", err)
		}
		fmt.Println("Daemon restarted.")
	}

	fmt.Println("Done.")
	reportBackup()
	return nil
}

// reportBackup tells the user whether an encrypted settings backup is present
// in the data directory. Replacing the binary never touches it — the backup
// lives beside the data, not inside the executable — and this line confirms
// that after the upgrade, so an empty or unreadable backup directory is visible
// here rather than at the next restore. It is informational only: a missing or
// broken store must never fail an upgrade.
func reportBackup() {
	dataDir, err := installDataDir()
	if err != nil || dataDir == "" {
		return
	}
	store, err := backup.New(dataDir)
	if err != nil {
		return
	}
	summaries, err := store.Summarize()
	if err != nil || len(summaries) == 0 {
		return
	}
	var totalGen int
	var totalBytes int64
	var newest string
	for _, s := range summaries {
		totalGen += s.Generations
		totalBytes += s.Bytes
		if s.LatestMTime > newest {
			newest = s.LatestMTime
		}
	}
	fmt.Printf("Backup: %d generation(s) across %d slot(s), %s (latest %s)\n",
		totalGen, len(summaries), humanBytes(totalBytes), newest)
}
