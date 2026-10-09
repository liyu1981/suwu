# Running Suwu inside WSL — Feature Plan

> **Status:** planned, not started.
> **Goal:** `suwu` installs, onboards, runs in the background, and is reachable
> from the *Windows* browser with no WSL-specific guesswork — whether the
> distro boots systemd or not.

Companion docs: `docs/INSTALL_PLAN.md` (install/onboard plumbing),
`docs/DB_BROWSER_PLAN.md` (plan format).

Owner area: new `pkg/platform/`, `cmd/Suwu/{main,onboard,systemd,daemon}.go`,
`cmd/Suwu/serve_suwu.sh`, `serve-dev.sh`, `install.sh`,
`website/docs/pages/get-started.content.html`.

---

## 1. Goal

WSL is just Linux with a Windows-adjacent network and an optional init system.
Most of Suwu already works there; the feature is about removing the handful of
places where Suwu assumes a "normal" Linux host and therefore lies to the user
or fails outright.

Success looks like this, from a fresh Ubuntu WSL distro:

```sh
curl -fsSL https://raw.githubusercontent.com/liyu1981/suwu/refs/heads/master/install.sh | sh
#   → wizard runs, no systemd crash
#   → final line prints a URL the Windows browser can actually open
#   → suwu daemon status works with no terminal open, and (if opted in at the
#     prompt) Suwu is running again after the next Windows logon
```

and, deliberately, **zero new configuration keys** for the common case.

---

## 2. What already works (baseline)

Be honest about the starting point — this is de-risking, not a port:

| Piece | Why it works in WSL |
|---|---|
| Release binary | `CGO_ENABLED=0` → static linux/amd64,arm64 runs on any WSL distro |
| `install.sh` | `uname -m` → `amd64`/`arm64`; `curl`/`tar`/`/dev/tty` all present |
| Default bind | `HOST=127.0.0.1`; WSL2 `localhostForwarding` (default on) forwards Windows `localhost` → WSL loopback |
| TLS cert | `certs.DetectHosts()` already includes `localhost` and `127.0.0.1` |
| PTY state | `/proc/<pid>/cwd` and `/proc/<pid>/stat` exist under WSL |
| Notifications | `suwu send` unix socket at `~/.suwu/suwu.sock` |
| Upgrade | `pkg/update.FindAsset` matches `linux-<arch>` |
| Dev tools | `devenv-checklist.json` shells out to `apt-get`/`dnf`/`pacman`, which WSL distros have |

**One thing the baseline does not give you:** a WSL distro does not boot at
Windows startup. Its background processes survive closing every terminal and
last until `wsl --shutdown` or a Windows restart — after that, something must
invoke `wsl.exe` before systemd (or the `nohup` daemon) can run again. systemd
inside WSL only decides *when the distro is up*; it does not make the distro
boot. This plan therefore treats "what happens across a Windows reboot" as a
Windows-side concern (§4.8), separate from the in-distro service backend (§4.3).

So the default *foreground* `suwu serve` already runs in WSL. The gaps below
are what turns "runs if you know the tricks" into "just works".

---

## 3. Concrete gaps

Each gap is tied to the exact code that causes it.

### 3.1 No WSL detection anywhere

`grep -ri wsl` over the repo returns nothing. Every platform decision is
implicit: `runtime.GOOS == "linux"`. WSL needs to be distinguishable from
desktop Linux because its *browser is on another OS* and its *init system is
optional*.

### 3.2 Misleading URL when `HOST=auto`

The `auto` profile (LAN) does this:

- `pkg/auth/auth.go::CreateConfig` → `DisplayHost = localMachineHosts()[0]`
  (the WSL hostname, e.g. `DESKTOP-ABC`).
- `pkg/auth/auth.go::localMachineHosts` also adds the WSL NAT address
  (`172.x.x.x` on `eth0`) to `AllowedHosts`.
- `cmd/Suwu/serve_suwu.sh` → `DISPLAY_HOST="$(hostname)"` for the same case.
- `serve-dev.sh` does the same.

`DESKTOP-ABC` and `172.x.x.x` are **not reachable from the Windows browser**
(WSL2 NAT; the Windows host resolves neither). The banner sends the user to a
dead URL. Loopback is fine (it prints `localhost`), but `auto`/`0.0.0.0` is
wrong.

### 3.3 `hasSystemctl()` is not a systemd-liveness check

`cmd/Suwu/systemd.go::hasSystemctl()` only does
`exec.LookPath("systemctl")`. On a WSL distro that ships the `systemd` package
but boots as PID 1 = `init`, `/usr/bin/systemctl` exists and returns
`System has not been booted with systemd as init system (PID 1). Can't operate.`

Consequences:

- `onboard.go::printOnboardPreflight` prints
  "systemd user service is available" (false).
- `onboard.go::collectOnboardRuntime` asks to install the service (default yes).
- `executeOnboardPlan` → `installSystemdService()` → `systemctl --user
  daemon-reload` fails → onboarding aborts after writing config, leaving a
  half-finished setup.
- `verifyOnboardPlan` requires `systemctl --user is-active suwu`.

The non-systemd path (`cmd/Suwu/daemon.go` → embedded `serve_suwu.sh`, which
uses `nohup setsid`) already exists and is solid — onboarding just never offers
it.

### 3.4 No Windows-browser handoff

Nothing ever opens the browser, so the WSL user must copy the URL out of the
WSL terminal into Windows themselves. WSL has first-class interop for this
(`wslview`, `explorer.exe`, `cmd.exe /c start`, `powershell.exe Start-Process`).

### 3.5 No Windows path interop for CLI

`suwu open`, `suwu code`, `suwu diff`, `suwu gitgraph` accept a path and resolve
it on the server. A Windows user naturally types a Windows path:

```sh
suwu open 'C:\Users\me\report.pdf'      # filepath.Abs/Stat fails
suwu code '\\wsl$\Ubuntu\home\me\x'     # fails
```

`wslpath -u` bridges this; `wslpath -w` can translate back for printed output.

### 3.6 Docs say "Linux", nothing says "WSL"

`website/docs/pages/get-started.content.html` says "Suwu runs on Linux
(amd64, arm64)". A WSL user has no idea whether that includes them, how to
reach the UI from Windows, or what happens without systemd. README's Install
section has the same silence.

---

## 4. Design

### 4.1 New package `pkg/platform`

One small package, no dependencies on the rest of Suwu, fully unit-testable by
injecting the environment and the osrelease text (mirroring the
`auth.CreateConfig(env func(string) string)` pattern).

```go
package platform

// IsWSL reports whether the process runs under Windows Subsystem for Linux.
func IsWSL() bool

// WSLVersion returns 2, 1, or 0 when not WSL.
func WSLVersion() int

// InteropAvailable reports whether Windows executables can be launched
// (explorer.exe/cmd.exe on PATH and /mnt/c mounted). WSL2 only.
func InteropAvailable() bool

// BrowserHost returns the host the *Windows* browser should use for a server
// bound to bindHost, and ok=false when this is not WSL (caller keeps its own
// logic). Loopback and wildcard both map to "localhost"; non-loopback
// literal hosts are returned unchanged.
func BrowserHost(bindHost string) (host string, ok bool)

// WindowsToLinuxPath translates a Windows path via wslpath -u. Returns the
// input unchanged on any failure or when not WSL.
func WindowsToLinuxPath(path string) string

// LinuxToWindowsPath is the inverse (wslpath -w).
func LinuxToWindowsPath(path string) string

// OpenBrowser opens url with the platform's browser, preferring Windows
// interop under WSL. Returns an error only when no launcher succeeded.
func OpenBrowser(url string) error
```

Detection heuristics, in order:

1. `WSL_DISTRO_NAME` or `WSL_INTEROP` set → WSL.
2. `/proc/sys/kernel/osrelease` or `/proc/version` contains
   `microsoft`/`WSL` (case-insensitive) → WSL.
3. Version: `WSL_INTEROP` set → 2; osrelease contains `WSL2` → 2;
   osrelease contains `4.4.0` / `Microsoft` (capital) → 1; else 2 when
   `/mnt/c` exists, otherwise unknown.

Detection is split into a pure function so tests do not depend on the host:

```go
type probe struct {
    getenv     func(string) string
    osrelease  string // contents of /proc/sys/kernel/osrelease
    version    string // contents of /proc/version
    lookPath   func(string) (string, error)
    stat       func(string) error
}
func detect(p probe) info
```

`IsWSL()`, `WSLVersion()`, etc. are thin wrappers around a package-level
`detect(defaultProbe())`.

### 4.2 Correct host display

Single source of truth so the banner, the daemon script, and onboarding agree.

- Add `platform.BrowserHost(bindHost)` and call it:
  - in `cmd/Suwu/main.go::printBanner` (or earlier, when building
    `auth.Config`) so `DisplayHost` becomes `localhost` under WSL for both
    loopback and wildcard/auto binds.
  - in `auth.CreateConfig`, so `AllowedHosts` still contains loopback **and**
    the banner URL is the reachable one. Keep the NAT IPs in `AllowedHosts` —
    harmless and useful for mirrored networking.
- Mirror the same rule in the shell scripts with a small helper, because they
  print their own URL before the Go banner:

  ```sh
  is_wsl() { grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease /proc/version 2>/dev/null; }
  ```

  In `serve_suwu.sh` and `serve-dev.sh`, when `is_wsl` and the host is
  `auto`/wildcard, set `DISPLAY_HOST=localhost`.

- For the **LAN** profile under WSL, do not pretend auto-detection works.
  Print an explicit note in `printBanner` / onboarding review:

  > Running inside WSL: Windows can reach this server on `localhost`.
  > To reach it from other devices, expose the port on Windows
  > (`netsh interface portproxy add v4tov4 listenport=8181 listenaddress=0.0.0.0
  > connectport=8181 connectaddress=127.0.0.1` + a firewall rule) and use the
  > Windows machine's LAN IP.

  An optional Phase 3 best-effort can discover the Windows LAN IP via
  `powershell.exe -NoProfile -Command "(Get-NetIPAddress …)"`, but the plan
  does not depend on it.

### 4.3 systemd liveness and the runtime fallback

Replace path-presence with the standard `sd_booted()` heuristic:

```go
// systemdBooted reports whether systemd is PID 1. /run/systemd/system is the
// directory systemd itself creates (sd_booted()); it is absent on WSL and
// containers that boot a different init.
func systemdBooted() bool {
    fi, err := os.Stat("/run/systemd/system")
    return err == nil && fi.IsDir()
}

// systemdUsable is the check every caller should use.
func systemdUsable() bool { return hasSystemctl() && systemdBooted() }
```

Keep `hasSystemctl()` (still meaningful for "the CLI exists"), but:

- `printOnboardPreflight` → uses `systemdUsable()`; under WSL without systemd
  print the enable snippet (§ below) instead of "available".
- `collectOnboardRuntime` → only offers the systemd service when
  `systemdUsable()`.
- `installSystemdService` → return a typed, non-fatal error when
  `!systemdBooted()` and never run `systemctl` in that case.
- `verifyOnboardPlan` → only run `systemctl --user is-active` when the chosen
  backend is systemd.

Extend `onboardPlan` with an explicit backend so the two paths are not
entangled:

```go
type serviceBackend string
const (
    serviceNone    serviceBackend = "none"
    serviceSystemd serviceBackend = "systemd"
    serviceDaemon  serviceBackend = "daemon" // nohup+setsid via serve_suwu.sh
)
```

The backend decides how Suwu restarts *inside a running distro*. It is
orthogonal to whether the distro boots at Windows logon — neither backend
survives a Windows restart on its own. See §4.8.

**When systemd is not usable** (the WSL default), onboarding offers:

1. *Start Suwu in the background now (no systemd)* — runs the existing
   `suwu daemon start` path (`cmd/Suwu/daemon.go`), default on.
2. *Enable systemd for this distro* — prints, and offers (with `sudo`) to write:

   ```ini
   # /etc/wsl.conf
   [boot]
   systemd=true
   ```

   followed by: "In Windows, run `wsl --shutdown`, then reopen the distro."
   Never write `/etc/wsl.conf` silently; append/merge carefully if the file
   already exists, and back it up first (reuse the onboarding backup idiom).
3. *Autostart on Linux shell login* — optional guarded snippet appended to
   `~/.profile` (only when the user chose the daemon backend and declined
   systemd). This is distinct from the Windows logon task in §4.8: it fires
   when a *WSL shell* starts, not when the Windows user logs in:

   ```sh
   # Start Suwu if it is not already running.
   command -v suwu >/dev/null 2>&1 && suwu daemon status >/dev/null 2>&1 || \
     { command -v suwu >/dev/null 2>&1 && suwu daemon start >/dev/null 2>&1; }
   ```

   Keep this off by default — a login that silently spawns a daemon is
   surprising — and only offer it when `platform.IsWSL()`.

`daemon.go` already redirects to `systemctl` when `hasSystemdUserService()`;
that check should also become `systemdUsable() && hasSystemdUserService()` so
a stale unit file on a no-systemd WSL distro does not send `suwu daemon start`
into a failing `systemctl`.

### 4.4 Browser handoff (opt-in)

Add `openBrowser(url) error` in `pkg/platform` and a flag on the foreground
server:

```sh
suwu serve --open        # open the default browser at the banner URL
SUWU_OPEN_BROWSER=true   # environment/default equivalent (onboard can set it)
```

- Non-WSL Linux → `xdg-open`; macOS → `open`; Windows → `rundll32 url.dll,FileProtocolHandler`.
- WSL → try, in order: `wslview` (wslu), `explorer.exe`, `cmd.exe /c start "" <url>`,
  `powershell.exe -NoProfile -Command Start-Process <url>`.
- **Never** auto-open from `suwu daemon start` or from systemd — background
  services must not spawn Windows processes. Only the foreground
  `suwu serve --open` (and an explicit `suwu open-url`-style helper, if we
  want one) opens anything.
- Quoting: pass the URL as a single `exec.Command` argument; do not
  shell-interpolate it. For `cmd.exe`, `start` and an empty title argument are
  required so a URL containing `&` cannot be re-split.

### 4.5 Windows path interop

At the CLI edge only — the server keeps receiving Linux paths:

- `cmd/Suwu/main.go::openMain`
- `cmd/Suwu/code.go::codeMain`
- `cmd/Suwu/diff.go::diffMain`
- `cmd/Suwu/main.go::gitgraphMain`

Run each path argument through `platform.WindowsToLinuxPath` before
`filepath.Abs`/`Stat`. Detection regex: `^[A-Za-z]:[\\/]` or `^\\\\` (UNC,
including `\\wsl$\...`). Internally call `wslpath -u` via `exec.Command` with
the path as one argument; on any error return the original string so non-WSL
and broken-interop cases are unchanged.

Optional, lower value: translate paths **back** with `wslpath -w` in
human-facing output ("opened /home/me/x" → also show `\\wsl$\Ubuntu\home\me\x`).
Defer unless users ask.

### 4.6 Onboarding WSL profile

No new top-level profile is required — "Local workstation / LAN / reverse
proxy" already describe intent. Instead, make the *preflight and runtime*
WSL-aware:

- Preflight line: `ℹ️  running inside WSL (WSL2, systemd off)`.
- Local profile under WSL: keep `HOST=127.0.0.1`, but label it explicitly
  "reachable from the Windows browser at https://localhost:8181".
- TLS hosts: unchanged — `certs.DetectHosts()` already covers `localhost`,
  so no cert regeneration is needed when the browser uses `localhost`.
- Generated `.env` comment: when WSL, add a line documenting the portproxy
  recipe for LAN use.

### 4.7 `install.sh`

Works as-is; add one WSL-aware courtesy after install:

- If `/proc/version`/`osrelease` matches WSL, print the "open this on Windows"
  hint (and, when `SUWU_OPEN_BROWSER`/`--open` is used later, nothing more).
- Do **not** attempt to write `/etc/wsl.conf` or run Windows commands from the
  installer; that belongs to onboarding where it can prompt.

### 4.8 Windows logon autostart (opt-in)

Systemd + linger makes Suwu start at *distro* boot with no login shell, but the
distro only boots when something invokes `wsl.exe` (§3, §4.3). Neither service
backend survives a Windows restart by itself.

So, when `platform.IsWSL()`, onboarding offers **one** Windows-side trigger —
"Start Suwu automatically when you log in to Windows" — and it is **default
off**. It is offered for **both** backends (systemd and the plain daemon),
because both need the distro to be booted.

- Registers a per-user Scheduled Task through interop (`schtasks.exe`):

  ```
  schtasks.exe /Create /TN "Suwu" /SC ONLOGON /RL LIMITED /F \
      /TR "wsl.exe -d <distro> -e /bin/true"
  ```

  `wsl.exe` is `%SystemRoot%\System32\wsl.exe`; `<distro>` is
  `$WSL_DISTRO_NAME`. The `/bin/true` call only boots the distro — systemd's
  linger user service (or the `~/.profile` guard) then starts Suwu. An
  `ONLOGON` task for the current user needs no admin rights.
- `ONLOGON` fires when the Windows user logs in, not at Windows boot before
  login. A true `ONSTART` task needs admin/service credentials and is out of
  scope (§8); say so in the prompt so the choice is honest.
- The runtime step gains `plan.windowsLogonAutostart bool` (default `false`),
  and the review screen shows it as `Autostart (Windows logon): off`.
- Reversible without re-running the wizard: ship
  `suwu wsl-autostart {enable|disable|status}` (interop wrapper around
  `schtasks.exe /Create|/Delete|/Query /TN Suwu`), and have `suwu daemon
  uninstall` / the onboarding uninstall path delete the task too.
- Probe interop first (`platform.InteropAvailable()`). If `schtasks.exe` is
  missing or fails, print the exact command for the user to run in an elevated
  Windows PowerShell and continue onboarding instead of aborting.
- Never register silently, never when not on WSL, and never for a distro other
  than the one Suwu is running in.

---

## 5. Phases

Ordered so each phase is independently shippable and reviewable.

| Phase | Deliverable | Files |
|---|---|---|
| **1** | `pkg/platform` detection + tests; `systemdUsable()` + tests | `pkg/platform/*.go`, `cmd/Suwu/systemd.go` |
| **2** | Correct URL: `BrowserHost` wired into `auth.CreateConfig`, `printBanner`, `serve_suwu.sh`, `serve-dev.sh`; WSL LAN note | `pkg/auth/auth.go`, `cmd/Suwu/main.go`, `cmd/Suwu/serve_suwu.sh`, `serve-dev.sh` |
| **3** | Onboarding no longer crashes without systemd: backend field, daemon fallback, `/etc/wsl.conf` guidance, verify gating; **opt-in Windows logon autostart task + `suwu wsl-autostart` helper** | `cmd/Suwu/onboard.go`, `cmd/Suwu/daemon.go`, `cmd/Suwu/systemd.go`, new `cmd/Suwu/wsl.go`, `pkg/platform/*.go` |
| **4** | `suwu serve --open` / `SUWU_OPEN_BROWSER` with WSL interop | `pkg/platform/*.go`, `cmd/Suwu/main.go` |
| **5** | Windows path translation in `open`/`code`/`diff`/`gitgraph` | `cmd/Suwu/{main,code,diff}.go` |
| **6** | Docs: get-started WSL section, README, `.env.example` comment, upgrade page note | `website/docs/pages/get-started.content.html`, `README.md`, `.env.example` |

Phases 1–3 are the real feature (it "runs and stays running"); 4–6 are polish
and can slip without blocking the goal.

---

## 6. Testing

**Unit (Go)**

- `pkg/platform`: table-driven `detect()` tests over osrelease/version/env
  combinations → WSL none/1/2; `BrowserHost` for loopback, `0.0.0.0`, `::`,
  `auto`, literal host; non-WSL passthrough.
- Path regex + `WindowsToLinuxPath` with a fake `wslpath` (inject the runner,
  or use a `PATH` shim in a `t.TempDir()` test).
- `systemdUsable()` with an injectable stat dir; assert `onboardPlan` picks
  `serviceDaemon` when `!systemdBooted`.
- Windows logon autostart: inject the interop runner and assert the exact
  `schtasks.exe /Create … /TR "wsl.exe -d <distro> -e /bin/true"` arguments,
  that the plan default is `false`, and that the option is only surfaced when
  `platform.IsWSL()`.
- Banner: refactor the display-host decision into a pure function and pin it
  with a golden test (mirrors the existing preflight tests in
  `cmd/Suwu/onboard_test.go`).
- `serve_suwu.sh` WSL branch: assert the script contains the `is_wsl` guard and
  maps `auto` → `localhost` when the marker file is present (pattern used by
  the existing shell-script checks).

**Manual matrix (document in the plan PR, not automated CI)**

| Env | systemd | Expected |
|---|---|---|
| WSL2 Ubuntu, default | off | install → onboard succeeds → `suwu daemon status` running → Windows browser opens `https://localhost:8181` |
| WSL2 Ubuntu, `[boot] systemd=true` | on | onboarding installs `suwu.service`; Suwu runs with no terminal open and returns whenever the distro is started again — it does **not** survive `wsl --shutdown` on its own |
| WSL2 + Windows logon task opted in | either | after `wsl --shutdown` then a Windows logon, the distro boots and Suwu is running with no user action |
| WSL2 + Windows logon task declined | either | Suwu stays down after `wsl --shutdown` until a terminal or another `wsl.exe` call boots the distro (expected) |
| WSL1 Ubuntu | n/a | `HOST=127.0.0.1`, localhost works (shared stack) |
| WSL2, `HOST=auto` | either | banner/Copy URL shows `localhost`, not the NAT IP/hostname |
| WSL2 + `networkingMode=mirrored` | either | localhost works; LAN note still accurate |
| Native Linux (regression) | on | banner/onboard/daemon unchanged |

CI stays Linux-only; the platform package is tested by injection, so no WSL
runner is required.

---

## 7. Documentation

- `website/docs/pages/get-started.content.html`: a short **"Windows (WSL)"**
  section after Install — install command, "open the printed URL in your
  Windows browser", and a callout for "no systemd? onboarding starts the
  built-in daemon; or enable systemd in `/etc/wsl.conf`". Document the opt-in
  Windows logon task (what it does, that it is off by default, and how to
  remove it with `suwu wsl-autostart disable`).
- `README.md`: one bullet/paragraph under Install.
- `.env.example` / `envExample` in `onboard.go`: comment on `HOST` noting WSL
  loopback reachability and the portproxy recipe.
- `upgrading.html`: note that `suwu upgrade` is unaffected (it replaces a Linux
  binary inside the distro).

---

## 8. Out of scope

- **Windows-native build.** Suwu stays a Linux binary; WSL is a Linux target.
  A `.exe` port is a different project.
- **Auto-configuring Windows firewall/portproxy.** Requires admin and touches
  the host OS; we print the commands, we do not run them.
- **Windows clipboard bridging / OSC 52 to the Win32 clipboard.** The browser
  owns the clipboard; on `localhost` the secure-context clipboard APIs already
  work. Revisit only if users report a gap.
- **X display / `xvfb` graphic tile under WSL.** WSLg provides `:0`, but the
  `pkg/xdisplay` capture path (Xorg + xdotool + picom) is a separate feature;
  it should degrade with the existing dependency error, not gain WSL code here.
- **`suwu send` from PowerShell without `wsl.exe`.** A Windows-side client
  would need a TCP/HTTP notification endpoint; not part of WSL support.
- **Windows-boot (`ONSTART`) autostart.** Starting the distro before any user
  logs in needs admin/service credentials; only the per-user `ONLOGON` task is
  offered (§4.8).

---

## 9. Open questions

1. **`auto` on WSL: should it bind `127.0.0.1` or `0.0.0.0`?** `auto` today
   means "bind all interfaces". On WSL that needlessly exposes the server to
   the distro's NAT network. Proposal: under WSL, keep `auto` semantics for
   LAN/portproxy users but set the *display* host to `localhost` and print the
   exposure warning. Alternative: define an `wsl` profile that binds loopback
   and documents portproxy separately. Decide during phase 2.
2. **Should onboarding write `/etc/wsl.conf`?** It is the single most useful
   WSL fix (gets real systemd), but it edits a host-level file. Proposal:
   prompt, back up, and only append a `[boot]` section that is missing;
   default to *printing* the snippet unless the user opts in.
3. **Windows logon autostart is in scope as opt-in** (decided): onboarding
   offers a per-user `ONLOGON` Scheduled Task, **default off**, removable via
   `suwu wsl-autostart disable`. Open sub-question: exact task name (proposal
   `Suwu`) and whether `suwu daemon uninstall` should delete the task
   automatically. The Linux-side `~/.profile` login autostart stays deferred
   to a later ask.
4. **`wslview` vs. `explorer.exe` first.** `wslview` is a separate package
   (wslu) and not installed everywhere; `explorer.exe <url>` opens the default
   browser but can flash an Explorer window. Try `wslview` first, fall back to
   `explorer.exe`/`cmd start`.
5. **Naming.** `pkg/platform` vs. folding the helpers into `pkg/auth` (host) and
   `cmd/Suwu` (everything else). A dedicated package keeps `auth` free of
   process-spawning and is easier to test; confirm no name collision with
   existing `platform` symbols (`pkg/server/update.go` has a local `platform`
   variable).
