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
