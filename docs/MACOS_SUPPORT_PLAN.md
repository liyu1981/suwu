# macOS Support — Feature Plan

> **Status:** planned, not started.
> **Goal:** Suwu ships a signed, working `darwin/amd64` + `darwin/arm64` release;
> `install.sh` + `suwu onboard` configure it; the background service uses
> launchd; and the handful of Linux-only subsystems (`/proc`, systemd,
> `setsid`, apt-based tool installs) have macOS equivalents instead of
> silently returning nothing.

Companion docs: `docs/WSL_SUPPORT_PLAN.md` (shares `pkg/platform` and the
`OpenBrowser` helper), `docs/INSTALL_PLAN.md` (install/onboard plumbing).

Owner area: `.github/workflows/{release,ci}.yml`, `install.sh`, new
`pkg/platform/`, `pkg/pty/foreground*.go`, `cmd/Suwu/{systemd,daemon,onboard,devenv}.go`,
new `cmd/Suwu/launchd.go`, `cmd/Suwu/serve_suwu.sh`, `serve-dev.sh`,
`pkg/server/forward.go`, `cmd/Suwu/devenv-checklist.json`, website docs.

---

## 1. Goal

Suwu is a Linux-first server, but nothing in it is actually Linux-specific at
the language level: it already cross-compiles (`GOOS=darwin GOARCH=arm64
CGO_ENABLED=0 go build ./...` exits 0), and its dependencies — `creack/pty`,
`xgb`, `modernc.org/sqlite`, the wazero-backed `libghostty-go` and `qjs` — are
pure Go. The gaps are:

- there is no `darwin` release artifact and no install path for one;
- four subsystems read Linux kernel interfaces (`/proc`, systemd, `setsid`,
  GNU `stat`) and degrade to silence or failure on macOS;
- the dev-tool installer and docs only know Linux.

Success:

```sh
curl -fsSL https://raw.githubusercontent.com/liyu1981/suwu/refs/heads/master/install.sh | sh
#   → downloads suwu-<ver>-darwin-arm64.tar.gz, runs onboard
suwu daemon start          # → launchd LaunchAgent, survives logout/login
# open https://localhost:8181 in Safari/Chrome
```

---

## 2. What already works (baseline)

Verified rather than assumed:

| Piece | Status on macOS |
|---|---|
| `GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build ./...` | **exits 0** today |
| PTY create/resize/signal | `creack/pty` supports darwin; `syscall.Kill(-pgid, sig)` is POSIX |
| Terminal emulation | libghostty ran as embedded WASM (wazero) — pure Go |
| Extensions sandbox | `qjs` via wazero — pure Go |
| SQLite / MySQL / Postgres | `modernc` pure-Go sqlite; pure-Go drivers |
| HTTP/WS server, TLS, certs | unaffected |
| `suwu send` | unix-domain socket; `~/.suwu/suwu.sock` is well under the 104-byte `sun_path` limit |
| Port forwarding (TCP/UDP) | unaffected |
| `install.sh` | POSIX `sh`, `curl`/`tar`/`find -maxdepth`/`mktemp -d`/`/dev/tty` all exist on macOS |
| Apple Silicon ad-hoc signature | Go's darwin/arm64 linker signs automatically, so a `CGO_ENABLED=0` build runs |

So the work is shipping + four portability fixes, not a rewrite.

---

## 3. Concrete gaps

### 3.1 No darwin release artifact or install path

`.github/workflows/release.yml` matrix is `linux-amd64` + `linux-arm64` only.
`install.sh` hardcodes `ASSET_NAME="suwu-${ASSET_VERSION}-linux-${ARCH}.tar.gz"`
and rejects non-linux `uname -m` values only by arch, not by OS. On macOS it
either 404s or downloads the Linux binary (which then fails with
`exec format error`). `pkg/update.FindAsset` already keys off
`runtime.GOOS`/`GOARCH`, so it will match `darwin` assets the moment they exist.

### 3.2 `/proc`-based CWD + foreground detection

`pkg/pty/foreground.go` (no build tag) reads:

- `os.Readlink("/proc/<pid>/cwd")` for the shell's CWD,
- `/proc/<pid>/stat` field 6 (`tpgid`) for the foreground process group,
- `/proc/<tpgid>/cmdline` for the foreground command line.

macOS has no `/proc`. The file compiles but every read fails, so
`GetSessionState` always returns `("", "")`. Consequences: restore-on-refresh
loses the working directory and running command; `pkg/session/session.go`
(`Client.Write`, `pollState`) can no longer tell whether the shell or a TUI is
foreground, so `pty.StripMouseReports` is applied unconditionally.

### 3.3 Background service is systemd-only

`cmd/Suwu/systemd.go` is Linux/systemd throughout (`systemctl --user`,
`loginctl enable-linger`, `journalctl`, `~/.config/systemd/user/suwu.service`).
`printOnboardPreflight`/`collectOnboardRuntime`/`executeOnboardPlan`/
`verifyOnboardPlan` all gate on `hasSystemctl()`, and `installSystemdService`
is the only service installer. On macOS there is no equivalent, so onboarding
never offers a durable background service.

### 3.4 The daemon fallback shell script is GNU/Linux-only

`cmd/Suwu/serve_suwu.sh` (embedded by `cmd/Suwu/daemon.go`) uses:

- `nohup setsid "$BIN" serve` — macOS has **no `setsid`**;
- `stat -c%s` — BSD/macOS `stat` uses `-f%z`, so `rotate()` never sees a size;
- `kill -INT "-$pid"` — assumes the server is its own process-group leader,
  which only holds because of `setsid`; without it this targets the caller's
  group.

`serve-dev.sh` additionally uses `readlink /proc/<pid>/cwd` for stray-air
detection (dev-only, lower priority).

### 3.5 Dev-tool checklist is Linux-only

`cmd/Suwu/devenv-checklist.json`:

- every `install_cmd` branches over `apt-get`/`dnf`/`yum`/`pacman`/`apk` — no
  Homebrew;
- the hidden `libatomic1` item is Linux-only (`ldconfig -p | grep libatomic`);
- GitHub-release asset names are hardcoded Linux:
  - `rustTarget()` in `devenv.go` returns `x86_64-unknown-linux-musl` /
    `aarch64-unknown-linux-musl` → ripgrep misses `*-apple-darwin`;
  - asdf `asdf-v{{ .Version }}-linux-{{ .Arch }}.tar.gz`;
  - fzf `fzf-{{ .Version }}-linux_{{ .Arch }}.tar.gz`;
  - lazygit `lazygit_{{ .Version }}_linux_{{ .Arch }}.tar.gz` with a single
    `arch_override: "x86_64"` — wrong on darwin (uppercase `Darwin`) *and*
    already wrong on `linux-arm64`.

### 3.6 `/proc/net/tcp` port listing

`pkg/server/forward.go::readListeningPorts` parses `/proc/net/tcp` and
`/proc/net/tcp6`. On macOS it returns an empty list, so the port-forward tile's
"server ports" picker is empty.

### 3.7 Shell integration assumes bash

`onboard.go::ensureLocalBinInPath` / `ensureAsdfDataDir` append to the first of
`.bashrc`, `.profile`, `.zshrc` that **exists**. macOS's default shell is zsh,
and `.zshrc` usually exists, so this mostly works — but `.bash_profile` is
ignored, and the asdf `post_install_cmd` in the checklist hardcodes `~/.bashrc`.
Low risk, but worth pinning.

### 3.8 Distribution, Gatekeeper, signing

- `curl | sh` does **not** set the `com.apple.quarantine` attribute, so a
  downloaded binary runs. A tarball downloaded in a *browser* is quarantined
  and Gatekeeper blocks an unsigned/ad-hoc binary.
- `go build` for darwin/arm64 applies an ad-hoc signature automatically;
  darwin/amd64 needs none. Developer ID signing + notarization is a
  distribution nicety, not a v1 blocker.
- Homebrew tap/formula would smooth install but is optional.

### 3.9 X display tile is X11-only

`pkg/xdisplay` (Xorg + xdotool + picom) and `suwu use` (X displays) have no
macOS story. Acceptable: the dependency check already reports what is missing.
Document it rather than port it.

### 3.10 Docs say "Linux"

`website/docs/pages/get-started.content.html` ("Suwu runs on Linux (amd64,
arm64)"), README, and `install.sh` say nothing about macOS.

---

## 4. Design

### 4.1 Release + install

**`.github/workflows/release.yml`** — extend the cross-compile matrix (still on
`ubuntu-latest`; `CGO_ENABLED=0` makes darwin cross-compiles deterministic):

```yaml
- { goos: darwin, goarch: amd64, platform: darwin-amd64 }
- { goos: darwin, goarch: arm64, platform: darwin-arm64 }
```

Archive naming stays `suwu-<version>-<platform>.tar.gz`.

**`install.sh`** — detect the OS, not just the arch:

```sh
case "$(uname -s)" in
  Linux)  OS=linux  ;;
  Darwin) OS=darwin ;;
  *)      die "unsupported OS: $(uname -s)" ;;
esac
ASSET_NAME="suwu-${ASSET_VERSION}-${OS}-${ARCH}.tar.gz"
```

Also, after install on macOS, print the Gatekeeper hint when needed
(`xattr -d com.apple.quarantine "${INSTALL_DIR}/suwu"` if
`xattr -p com.apple.quarantine` shows a flag). Keep the `onboard` exec
unchanged.

**`suwu upgrade`** needs no change: `pkg/update.FindAsset` already matches
`darwin-<arch>`; note in the plan that replacing a running binary via
unlink+rename is safe on macOS (the old inode stays mapped).

### 4.2 `pkg/platform` (shared with the WSL plan)

Add macOS to the same package the WSL plan introduces:

```go
func IsDarwin() bool // or callers use runtime.GOOS directly
```

`platform.OpenBrowser(url string) error` (WSL plan §4.4) already routes macOS
to `open <url>`; no extra work beyond making sure the darwin branch is real.

If the WSL plan has not landed, do the trivial `runtime.GOOS` checks inline and
fold them into `pkg/platform` when it appears.

### 4.3 PTY foreground/CWD on darwin

Split `pkg/pty/foreground.go` by build tag and keep the public API identical:

- `foreground_linux.go` — the current `/proc` implementation.
- `foreground_darwin.go` — pure Go, no cgo:
  - **CWD**: `proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, …)` via the raw
    `proc_info` syscall. `golang.org/x/sys/unix` already exposes
    `unix.SYS_PROC_INFO = 336` on both darwin arches, so define the
    `proc_vnodepathinfo` struct locally and call `unix.Syscall6`.
  - **Foreground pgid**: `ioctl(fd, TIOCGPGRP)` — `unix.TIOCGPGRP` exists on
    darwin — reading `tpgid` from the session's PTY master fd. Fall back to
    `ps -o tpgid= -p <pid>` when only a pid is available.
  - **Foreground command**: `sysctl kern.procargs2` for the tpgid (parse the
    `argc` + argv block) or `ps -o command= -p <tpgid>` as fallback.
- `foreground_other.go` (`//go:build !linux && !darwin`) — return empty so
  `go build ./...` stays green on other platforms.

Because `TIOCGPGRP` is cheap and the `proc_info` syscall is cheap, add
session-scoped entry points so the hot paths stop spawning processes:

```go
func (s *Session) Foreground() string   // uses the ptmx fd
func (s *Session) State() (cwd, foreground string)
```

`pkg/session/session.go` (`Client.Write` line ~160 and `Manager.pollState` line
~346) switches from `pty.GetSessionState(pid)` to `c.s.pty.Foreground()` /
`s.pty.State()`. Keep `GetSessionState(pid)` for the pid-only HTTP path.

Risk: `PROC_PIDVNODEPATHINFO`/`kern.procargs2` struct layouts are ABI-stable but
informal; pin them with a test against the live process on a macOS CI runner.

### 4.4 launchd runtime

New `cmd/Suwu/launchd.go`, mirroring `systemd.go`:

- Label `dev.suwu.server`, file
  `~/Library/LaunchAgents/dev.suwu.server.plist`.
- `ProgramArguments` = `[<bin>, serve]`, `WorkingDirectory` = config dir,
  `EnvironmentVariables` = `SUWU_BIN`/`SUWU_VAR`/`SUWU_CONFIG_DIR` (same values
  the systemd unit sets), `RunAtLoad=true`, `KeepAlive` (use
  `<dict><key>SuccessfulExit</key><false/></dict>` to mirror
  `Restart=on-failure`), `StandardOutPath`/`StandardErrorPath` =
  `~/.suwu/suwu.log`.
- Lifecycle via `launchctl`:
  - install: `launchctl bootstrap gui/$(id -u) <plist>`
  - start/restart: `launchctl kickstart -k gui/$(id -u)/dev.suwu.server`
  - stop: `launchctl kill SIGTERM gui/$(id -u)/dev.suwu.server`
  - status: `launchctl print gui/$(id -u)/dev.suwu.server` (or `launchctl list`)
  - uninstall: `launchctl bootout gui/$(id -u)/dev.suwu.server` + remove plist
  - logs: `tail -f ~/.suwu/suwu.log` (launchd has no `journalctl` analog)
- `cmd/Suwu/daemon.go` dispatch order becomes: darwin + LaunchAgent installed →
  `launchctl`; else linux + systemd installed → `systemctl`; else the embedded
  shell fallback.
- `onboard.go`: replace the hardcoded systemd wording/prompts with a small
  service-backend abstraction (`systemd` on Linux, `launchd` on darwin) so the
  preflight, runtime section, and verify step are OS-aware. **No linger
  equivalent**: a LaunchAgent starts at user login, not at boot before login.
  State that in the prompt.

### 4.5 Daemon shell-script portability

In `cmd/Suwu/serve_suwu.sh` (and `serve-dev.sh`):

- `start()`: branch on `uname -s`:

  ```sh
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$BIN" serve >>"$LOG" 2>&1 &
  else
    nohup "$BIN" serve >>"$LOG" 2>&1 &
  fi
  echo $! >"$PID"
  ```

- `stop()`: on macOS the server is **not** a process-group leader, so signal
  the pid (and `pkill -f` the server regex) rather than `kill -INT "-$pid"`.
  Keep the group form only when `setsid` was used.
- `rotate()`: portable size helper

  ```sh
  file_size() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0; }
  ```

- `serve-dev.sh`: replace `readlink /proc/<pid>/cwd` with `lsof -a -p <pid> -d cwd -Fn`
  on darwin (dev-only).

On macOS the *primary* path is launchd anyway; the shell fallback only needs to
be correct, not pretty.

### 4.6 Dev-tool checklist: Homebrew + per-OS assets

**Package managers** — add a `brew` branch to each `install_cmd`, e.g.:

```sh
if command -v apt-get ...; then ...
elif command -v brew >/dev/null 2>&1; then brew install git
elif ... fi
```

**Linux-only items** — gate `libatomic1` (and any `ldconfig` check) to Linux,
with an `os` allow-list on the checklist item so it is skipped (and hidden) on
darwin.

**GitHub-release assets** — make selection OS-aware instead of hardcoding
`linux`:

- `rustTarget(goos, goarch)` → `{x86_64,aarch64}-apple-darwin` on darwin,
  keeping the linux-musl triples;
- extend `githubRelease` with per-OS patterns, e.g.
  `asset_patterns: { "linux": "…-linux_{{ .Arch }}.tar.gz",
  "darwin": "…-darwin_{{ .Arch }}.tar.gz" }` with `asset_pattern` as fallback;
- fix lazygit's capitalization and arch mapping (`Darwin_arm64` /
  `Darwin_x86_64`, `Linux_arm64` / `Linux_x86_64`) — the current single
  `arch_override: "x86_64"` is wrong on `linux-arm64` too;
- fzf uses `darwin_arm64`/`darwin_amd64`; asdf uses `darwin-arm64`/`darwin-amd64`
  (`amd64`, not `x86_64`) — pin all of these with golden tests.

**Shell rc target** — replace the hardcoded `~/.bashrc` in the asdf
`post_install_cmd` with `~/.zshrc` on darwin (or a shared helper that appends to
the detected login shell's rc).

### 4.7 Port listing on darwin

Give `readListeningPorts` build-tagged implementations:

- `pkg/server/ports_linux.go` — the current `/proc/net/tcp` parser.
- `pkg/server/ports_darwin.go` — parse
  `lsof -nP -iTCP -sTCP:LISTEN -F n` (field mode, parse the `n` lines and take
  the port) or `netstat -anv -p tcp`; dedupe and sort to match the Linux
  version's contract (`[]int`).
- `pkg/server/ports_other.go` — empty slice.

Keep the HTTP handler signature unchanged.

### 4.8 Onboarding and shell integration

- `printOnboardPreflight`: report "systemd user service" only on Linux, "launchd
  LaunchAgent" on darwin; otherwise "no background service available".
- `collectOnboardRuntime`/`executeOnboardPlan`/`verifyOnboardPlan`: route to the
  launchd backend on darwin (see §4.4), and verify with
  `launchctl print …` instead of `systemctl --user is-active`.
- `ensureLocalBinInPath`/`ensureAsdfDataDir`: also consider `.bash_profile` and
  prefer `$SHELL`'s rc on macOS. Keep the log/pid/data dirs unchanged
  (`~/.suwu`, `~/.config/suwu`).
- Local profile on macOS keeps `HOST=127.0.0.1`; the browser is on the same
  machine, so no host-display change is needed.

### 4.9 Signing / Gatekeeper

- v1: rely on Go's automatic ad-hoc signature for darwin/arm64 and document the
  quarantine removal for browser-downloaded tarballs.
- Future (not in this plan): Developer ID signing + `notarytool` notarization in
  the release workflow (needs Apple credentials in CI), and a Homebrew tap.

### 4.10 X display behavior

`pkg/xdisplay` and `suwu use` stay Linux-only. On darwin the dependency check
should produce the existing "missing dependencies" error; `suwu use` should say
"X displays are not supported on macOS" rather than "start an XDisplay tile
first". `xvfb`/`Xorg`/`picom` must never be probed as installable on macOS.

---

## 5. Phases

| Phase | Deliverable | Files |
|---|---|---|
| **1** | darwin release artifacts + `install.sh` OS detection | `.github/workflows/release.yml`, `install.sh` |
| **2** | `/proc`-free pty CWD/foreground + session-scoped API | `pkg/pty/foreground*.go`, `pkg/pty/session.go`, `pkg/session/session.go` |
| **3** | launchd backend + daemon dispatch + onboarding service abstraction | new `cmd/Suwu/launchd.go`, `cmd/Suwu/{daemon,onboard,systemd}.go` |
| **4** | Portable daemon shell script (`setsid`/`stat`/group-kill) | `cmd/Suwu/serve_suwu.sh`, `serve-dev.sh` |
| **5** | Dev-tool checklist: Homebrew + per-OS release assets | `cmd/Suwu/devenv.go`, `cmd/Suwu/devenv-checklist.json` |
| **6** | macOS port listing | `pkg/server/ports_*.go`, `pkg/server/forward.go` |
| **7** | Docs + macOS CI test job | `website/docs/pages/get-started.content.html`, `README.md`, `.github/workflows/ci.yml` |

Phases 1–3 are the feature (ship it and keep it running); 4–7 are correctness
and polish. Phases 2 and 3 have no dependency on the WSL plan; phase 4/6 overlap
with it only in spirit.

---

## 6. Testing

**Native CI** — add a `go test ./...` + `go build ./cmd/Suwu` job on
`macos-latest` (in addition to `ubuntu-latest`). This is what catches
`/proc`-dependent runtime behaviour that cross-compilation cannot.

**Unit (Go)**

- `pkg/pty`: darwin tests that start a real shell on a PTY, `cd /tmp`, run a
  long-lived child, and assert `State()` returns `/tmp` and the child's command
  line — the same shape as any existing Linux foreground tests, guarded by
  build tag so it only runs on darwin/linux respectively.
- `launchd.go`: golden test for the rendered plist (mirrors
  `cmd/Suwu/systemd_test.go::renderSystemdService`), plus argument-construction
  tests for `launchctl bootstrap/kickstart/bootout`.
- `devenv`: golden tests that render every release pattern for both
  `linux`/`darwin` × `amd64`/`arm64` and match the real upstream asset names
  (fixing the existing lazygit-arm64 hole while we are here).
- `readListeningPorts` darwin: parse a captured `lsof -F n` fixture, no live
  process required.
- `install.sh`: shell test asserting `uname -s` → `darwin` asset name (pattern
  used by the repo's existing shell-script checks).

**Manual matrix**

| Env | Expected |
|---|---|
| macOS arm64 (Apple Silicon), fresh | `curl \| sh` installs darwin-arm64, onboard succeeds, LaunchAgent starts server, Safari opens `https://localhost:8181` |
| macOS amd64 (Intel) | same artifact path `darwin-amd64`, runs |
| `suwu daemon restart` / login again | LaunchAgent restarts; server reachable after re-login |
| Refresh a terminal tile after `cd`/running app | CWD + foreground command restored (the §3.2 test) |
| `suwu install --github` | ripgrep/fzf/asdf land for darwin; no linux binaries |
| Port-forward tile | server port list is populated |
| Linux regression | `go test ./...` green; release matrix unchanged for linux |

---

## 7. Documentation

- `website/docs/pages/get-started.content.html`: change "runs on Linux
  (amd64, arm64)" to "Linux and macOS (amd64, arm64)"; add a short macOS note
  (install command, Gatekeeper tip, `suwu daemon` = launchd LaunchAgent).
- `README.md`: features/install mention macOS.
- `install.sh`: OS-aware `die` messages.
- `upgrading.html`: note `suwu upgrade` works on macOS.
- Document the X-display limitation and the "no start-before-login" launchd
  difference from systemd+linger.

---

## 8. Out of scope

- **Developer ID signing + notarization.** v1 relies on Go's ad-hoc signature;
  notarization needs Apple credentials in CI and is a separate release task.
- **Homebrew tap/formula.** A nice second install channel; not required when
  `install.sh` works.
- **A macOS-native X display / screen-capture tile.** Porting `pkg/xdisplay` to
  `CGDisplayStream`/`ScreenCaptureKit` is its own feature, not macOS support.
- **`launchd` `LaunchDaemon` (root, start-before-login).** User LaunchAgents
  only run at login; a system daemon would run Suwu as root, which is
  undesirable.
- **Windows-native build.** Out of scope here; see `docs/WSL_SUPPORT_PLAN.md`.

---

## 9. Open questions

1. **`KeepAlive` shape.** Plain `KeepAlive=true` restarts on every exit,
   including a clean `suwu daemon stop` (it would come straight back). Use
   `SuccessfulExit=false` and a `ThrottleInterval`, or manage stop via
   `launchctl bootout` instead of `kill`? Proposal: `SuccessfulExit=false` +
   stop via `bootout`.
2. **Label namespace.** `dev.suwu.server` vs `com.suwu.server`. Pick one and
   use it for both the plist filename and the `launchctl` target.
3. **`proc_info`/`kern.procargs2` struct drift.** These are documented but not
   versioned headers. Is a runtime sanity test (CWD equals the value the shell
   actually `cd`'d to) sufficient, or do we want a `ps`-based fallback behind a
   env switch?
4. **Signing timing.** Ad-hoc is enough for `curl | sh`, but a browser-downloaded
   tarball is quarantined. Is documenting `xattr -d com.apple.quarantine`
   acceptable for v1, or should notarization ship with the first darwin
   release?
5. **Intel vs. Apple Silicon CI.** `macos-latest` is Apple Silicon. darwin/amd64
   is only exercised by cross-compilation unless a second runner is added. Is
   cross-compile coverage sufficient for amd64, or do we want an explicit
   `macos-13` job?
