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

### Tile Design — Font Sizes

- Font must use **normal text size** as the base (the default body size, no `text-sm` or `text-xs` on containers).
- Never use `text-sm`, `text-xs`, `text-[10px]`, `text-[11px]`, or any pixel sizes smaller than the base font on tile panels, sidebars, toolbars, or their children.
- Use normal (base) text size for all body content. Do not shrink text for density.
- For differentiation within a tile (labels, badges, hints), use **color/opacity only** — not smaller font sizes.
- Icons and decorative elements may use arbitrary pixel sizes as needed.
