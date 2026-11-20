<!-- taolu-enforce:git-workflow -->
- Follow the taolu git-workflow (v1) in .opencode/skills/git-workflow/SKILL.md

<!-- taolu-enforce:apple-design -->
- Follow the taolu apple-design (v1) in .opencode/skills/apple-design/SKILL.md


### Release Workflow

When creating a new release version:

1. **Bump version** in both `package.json` (root) and `frontend/package.json` to the new version.
2. **Commit** the version bump (`chore(release): bump version to X.Y.Z`).
3. **Tag and push** — create the git tag (`git tag vX.Y.Z`) and push both commit and tag (`git push origin master && git push origin vX.Y.Z`).
4. **Wait for CI** — the `release.yml` workflow triggers on tag push and builds binaries via GitHub Actions. Never create the GitHub release manually before CI completes. Monitor with `gh run list --workflow=release.yml --limit=1` and `gh run watch <id> --exit-status`.
5. **Verify binaries** — after CI finishes, confirm the release has `suwu-X.Y.Z-linux-amd64.tar.gz` and `suwu-X.Y.Z-linux-arm64.tar.gz` assets attached using `gh release view vX.Y.Z`.
6. **Release notes** — the release body MUST document what changed between this version and the previous version. Use `git log PREV..HEAD --oneline` to enumerate commits, group them by type (features, fixes, improvements), and write a clear summary.

**Never delete and recreate a release with `gh release create`** — this removes CI-built binaries. If the release notes need updating, use `gh release edit vX.Y.Z --notes '...'` instead.

### Commit Permission

- **Never commit unprompted.** After staging changes, always ask the user for permission before running `git commit`.
- **Exception:** When the user explicitly says "git commit changes", you are permitted to commit once without further confirmation. After that commit, return to requiring permission for subsequent commits.
- Do not batch or chain commits without asking each time.

### Co-Authored-By

Do NOT add `Co-Authored-By` trailers to commit messages unless the user explicitly requests it. If you want to add one, confirm with the user first.

### Environment Files

- **Never modify `.env` files.** The `.env` file contains the user's personal development/test settings. Do not read, write, or modify `.env` under any circumstances.

### Tile Design — Typography

Follow the type scale and tile design rules in
`.opencode/skills/suwu-tile-plugin-design/SKILL.md` (§11 *Material, typography &
layout rules*). Do not invent font sizes outside that scale.

### Headless Browser & Process Hygiene

Headless Chrome is for verification only. **An instance must never outlive the
check that started it** — leftovers hold ports and memory, and the next test then
silently talks to a stale profile.

- **Bound it by construction.** Launch with `timeout <seconds> chromium-browser
  --headless …`, and in Go tests use `exec.CommandContext` with a deadline. A
  crashed script must not leave a browser behind.
- **Check the port before starting:** `ss -tlnp | grep 9222`. If it is busy, that
  is a leftover — kill the PID that owns it (from `ss`) instead of starting a
  second browser.
- **Kill by PID, never by pattern.** Use the PID you launched, or the owner from
  `ss -tlnp | grep <port>`. Never `pkill -f chrome` / `pkill -f chromium` /
  `pgrep -f …`: the pattern matches the user's desktop browser *and* the checking
  shell itself.
- **Give each run its own `--user-data-dir`** under a temp directory, and delete
  it afterwards.
- **Verify clean before finishing:** no listener on the debugging port, and
  `ps -eo args | grep '[c]hrom' | grep -- '--headless'` prints nothing. Same for
  any scratch test server and its temp dir/screenshots.
