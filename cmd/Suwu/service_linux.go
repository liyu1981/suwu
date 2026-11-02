//go:build linux

package main

import (
	"fmt"
)

// hasUserService reports whether a background service manager is available.
func hasUserService() bool { return hasSystemdUserService() }

// installUserService installs the background service.
func installUserService() error { return installSystemdService() }

// uninstallUserService removes the background service.
func uninstallUserService() error { return uninstallSystemdService() }

// startUserService starts the background service.
func startUserService() error { return systemctlUser("start", "suwu") }

// userServiceRedirect delegates daemon subcommands to the service manager when
// a service is installed. Returns handled=false to fall through to the
// embedded shell-script manager.
func userServiceRedirect(args []string) (bool, error) {
	if !hasSystemdUserService() || len(args) == 0 {
		return false, nil
	}
	switch args[0] {
	case "start", "stop", "restart", "status":
		return true, systemctlUser(args[0], "suwu")
	case "logs":
		return true, journalctlUser()
	case "install":
		fmt.Println("systemd service already installed")
		return true, nil
	case "uninstall":
		return true, uninstallSystemdService()
	}
	return false, nil
}
