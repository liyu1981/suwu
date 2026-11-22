package herdr

// The herdr-core pins (version, per-platform archive URL and sha256) live in
// tools/catalog.json, entry "herdr-core". Keeping them there rather than in a
// second lock file means the engine a release embeds, the archive a server
// downloads on demand, and the tool the settings page installs can never drift
// apart. PinnedLock reads it through the catalog embedded in this build.
