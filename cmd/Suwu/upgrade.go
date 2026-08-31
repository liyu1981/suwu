package main

import (
	"context"
	"flag"
	"fmt"
	"os"

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
		return nil
	}

	if *checkOnly {
		if update.IsNewer(current, latest) {
			fmt.Println("Update available.")
		} else {
			fmt.Println("Already up to date.")
		}
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
	return nil
}
