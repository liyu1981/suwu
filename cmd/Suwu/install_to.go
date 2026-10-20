package main

import (
	"context"
	"errors"
	"flag"
	"fmt"

	"suwu/pkg/installto"
)

// installToCmd implements `suwu install-to <user>@<host>`: it copies this
// binary to the destination (refusing when the platform does not match) and
// runs the remote onboarding wizard with the SSH session attached to this
// terminal. See pkg/installto.
func installToCmd(args []string) error {
	fs := flag.NewFlagSet("install-to", flag.ContinueOnError)
	port := fs.Int("port", 22, "SSH port of the destination machine")
	identity := fs.String("identity", "", "SSH private key file (default: ssh-agent, then ~/.ssh/id_*)")
	fs.Usage = printInstallToUsage
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		printInstallToUsage()
		return errors.New("expected exactly one <user>@<host> target")
	}
	user, host, err := installto.ParseTarget(fs.Arg(0))
	if err != nil {
		return err
	}
	return installto.Run(context.Background(), installto.Options{
		User:     user,
		Host:     host,
		Port:     *port,
		Identity: *identity,
	})
}

func printInstallToUsage() {
	fmt.Print(`Usage: suwu install-to [flags] <user>@<host>

Copy this binary to a remote machine over SSH and start its onboarding
wizard with the SSH session attached to this terminal — like logging in.
The transfer is refused when the remote platform does not match this binary;
the file is installed to ~/.local/bin/suwu and the SSH connection closes when
the wizard finishes or on any error.

Authentication: ssh-agent, default ~/.ssh keys, or a password prompt here
(--identity selects one key file explicitly).

  --port <n>         SSH port (default 22)
  --identity <file>  SSH private key file (default: agent, ~/.ssh/id_*)

Examples:
  suwu install-to alice@192.168.0.5
  suwu install-to --port 2222 --identity ~/.ssh/suwu_ed25519 deploy@server.lan
`)
}
