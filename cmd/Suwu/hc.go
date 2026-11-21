package main

// `suwu hc` — run the managed herdr-core.
//
// Suwu ships (or downloads) a pinned herdr-core, so a machine that has never
// installed `hc` can still run its daemon: `suwu hc server start`, `suwu hc ls`,
// `suwu hc run --bg claude`. Resolution is pkg/herdr's (SUWU_HC_BIN → managed
// ~/.suwu/bin/herdr-core → PATH → embedded archive → pinned download); this
// command only execs it, so argv, exit codes and signals are the tool's own.

import (
	"fmt"
	"os"
	"syscall"

	"suwu/pkg/herdr"
)

func hcMain(args []string) int {
	bin, err := herdr.Resolve()
	if err != nil {
		fmt.Fprintf(os.Stderr, "suwu hc: %v\n", err)
		return 1
	}
	argv := append([]string{bin.Path}, args...)
	if err := syscall.Exec(bin.Path, argv, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "suwu hc: exec %s: %v\n", bin.Path, err)
		return 1
	}
	return 0
}
