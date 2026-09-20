package main

import (
	"strings"
	"testing"
)

// TestRenderSystemdServicePinsEnvFile guards the fix for the service loading
// a stray `$HOME/.env` instead of the onboard-written global config: the unit
// must pin the working directory and load the config file explicitly.
func TestRenderSystemdServicePinsEnvFile(t *testing.T) {
	const (
		bin       = "/home/u/.local/bin/suwu"
		varDir    = "/home/u/.suwu"
		configDir = "/home/u/.config/suwu"
	)
	unit, err := renderSystemdService(bin, varDir, configDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"[Service]",
		"WorkingDirectory=" + configDir,
		"EnvironmentFile=-" + configDir + "/.env",
		"ExecStart=" + bin + " serve",
		"Environment=SUWU_BIN=" + bin,
		"Environment=SUWU_VAR=" + varDir,
		"Environment=SUWU_CONFIG_DIR=" + configDir,
		"[Install]",
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit missing %q:\n%s", want, unit)
		}
	}
	if strings.Count(unit, "EnvironmentFile=") != 1 {
		t.Errorf("expected exactly one EnvironmentFile line:\n%s", unit)
	}
}
