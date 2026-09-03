package server

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"runtime"

	"suwu/pkg/update"
)

// handleUpdateCheck returns the current and latest version.
// GET /api/update/check
func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	current := update.CurrentVersion()

	if update.IsDevBuild() {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"current":         current,
			"latest":          "",
			"updateAvailable": false,
		})
		return
	}

	info, err := update.CheckLatest(context.Background())
	if err != nil {
		slog.Error("update check failed", "error", err)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"current":         current,
			"latest":          "",
			"updateAvailable": false,
			"error":           err.Error(),
		})
		return
	}

	platform := runtime.GOOS + "-" + runtime.GOARCH
	asset, _ := update.FindAsset(info.Assets)

	result := map[string]interface{}{
		"current":         current,
		"latest":          info.Version,
		"updateAvailable": update.IsNewer(current, info.Version),
		"releaseNotes":    info.ReleaseNotes,
		"platform":        platform,
	}
	if asset != nil {
		result["downloadUrl"] = asset.BrowserDownloadURL
	}

	writeJSON(w, http.StatusOK, result)
}

// handleUpdateUpgrade downloads the latest release and replaces the binary.
// POST /api/update/upgrade
func (s *Server) handleUpdateUpgrade(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	current := update.CurrentVersion()
	if update.IsDevBuild() {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"ok":    false,
			"error": "cannot upgrade a dev build",
		})
		return
	}

	info, err := update.CheckLatest(context.Background())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"ok":    false,
			"error": "failed to check for updates: " + err.Error(),
		})
		return
	}

	if !update.IsNewer(current, info.Version) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"ok":      true,
			"version": current,
			"message": "already up to date",
		})
		return
	}

	asset, err := update.FindAsset(info.Assets)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"ok":    false,
			"error": err.Error(),
		})
		return
	}

	binPath, err := os.Executable()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"ok":    false,
			"error": "failed to resolve executable: " + err.Error(),
		})
		return
	}

	wasRunning := update.IsDaemonRunning()
	usesSystemd := update.HasSystemdService()

	if usesSystemd {
		// systemd handles restart — just replace the binary and restart.
		slog.Info("downloading and replacing binary (systemd)", "version", info.Version)
		if err := update.DownloadAndReplace(context.Background(), *asset, binPath); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
				"ok":    false,
				"error": "upgrade failed: " + err.Error(),
			})
			return
		}
		slog.Info("restarting systemd service")
		if err := update.SystemctlRestart(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
				"ok":    false,
				"error": "binary replaced but restart failed: " + err.Error(),
			})
			return
		}
	} else {
		// Embedded script — stop, replace, start.
		if wasRunning {
			slog.Info("stopping daemon for upgrade")
			if err := update.StopDaemon(); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
					"ok":    false,
					"error": "failed to stop daemon: " + err.Error(),
				})
				return
			}
		}

		slog.Info("downloading and replacing binary", "version", info.Version)
		if err := update.DownloadAndReplace(context.Background(), *asset, binPath); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
				"ok":    false,
				"error": "upgrade failed: " + err.Error(),
			})
			return
		}

		if wasRunning {
			slog.Info("restarting daemon after upgrade")
			_ = update.StartDaemon()
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":        true,
		"version":   info.Version,
		"restarted": wasRunning || usesSystemd,
	})
}
