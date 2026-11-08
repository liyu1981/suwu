module suwu

go 1.27.1

// wazero is pinned to v1.11.x: qjs v0.0.6 fails to instantiate on v1.12+
// (store-local FunctionTypeID mismatch during import resolution).
// "go get -u ./..." bumps it anyway; re-pin afterwards with
// "go get github.com/tetratelabs/wazero@v1.11.0" and check
// "go list -m github.com/tetratelabs/wazero".
// See docs/GQJS_INTEGRATION_PLAN.md §3 before upgrading.
require (
	github.com/charmbracelet/huh v1.0.0
	github.com/coder/websocket v1.8.15
	github.com/creack/pty v1.1.24
	github.com/fastschema/qjs v0.0.6
	github.com/go-sql-driver/mysql v1.10.1
	github.com/jackc/pgx/v5 v5.12.0
	github.com/jezek/xgb v1.3.1
	github.com/jezek/xgbutil v0.0.0-20260124183602-9fd151d6a51a
	github.com/mattn/go-isatty v0.0.24
	github.com/muesli/termenv v0.16.0
	github.com/pkg/sftp v1.13.12
	github.com/tetratelabs/wazero v1.11.0
	golang.org/x/crypto v0.58.0
	golang.org/x/mod v0.42.0
	golang.org/x/term v0.47.0
	modernc.org/sqlite v1.62.0
)

require (
	filippo.io/edwards25519 v1.2.0 // indirect
	github.com/atotto/clipboard v0.1.4 // indirect
	github.com/aymanbagabas/go-osc52/v2 v2.0.1 // indirect
	github.com/catppuccin/go v0.3.0 // indirect
	github.com/charmbracelet/bubbles v1.0.0 // indirect
	github.com/charmbracelet/bubbletea v1.3.10 // indirect
	github.com/charmbracelet/colorprofile v0.4.3 // indirect
	github.com/charmbracelet/lipgloss v1.1.0 // indirect
	github.com/charmbracelet/x/ansi v0.11.9 // indirect
	github.com/charmbracelet/x/cellbuf v0.0.15 // indirect
	github.com/charmbracelet/x/exp/strings v0.1.0 // indirect
	github.com/charmbracelet/x/term v0.2.2 // indirect
	github.com/clipperhouse/displaywidth v0.11.0 // indirect
	github.com/clipperhouse/uax29/v2 v2.7.0 // indirect
	github.com/dustin/go-humanize v1.1.0 // indirect
	github.com/erikgeiser/coninput v0.0.0-20211004153227-1c3628e74d0f // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.3 // indirect
	github.com/kr/fs v0.1.0 // indirect
	github.com/lucasb-eyer/go-colorful v1.4.1 // indirect
	github.com/mattn/go-localereader v0.0.1 // indirect
	github.com/mattn/go-runewidth v0.0.31 // indirect
	github.com/mitchellh/hashstructure/v2 v2.0.2 // indirect
	github.com/muesli/ansi v0.0.0-20230316100256-276c6243b2f6 // indirect
	github.com/muesli/cancelreader v0.2.2 // indirect
	github.com/ncruces/go-strftime v1.1.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/xo/terminfo v1.3.1 // indirect
	golang.org/x/sync v0.24.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	modernc.org/libc v1.80.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)
