package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"text/tabwriter"
	"time"

	"suwu/pkg/notify"
)

const authUsageText = `Usage: suwu auth <command>

The devices signed in to this server. Every device has its own session, so
signing one out leaves the others working — which is what makes a phone and a
desktop usable at the same time.

Commands:
  suwu auth ls [--json]     list sessions: id, label, created, last seen, current
  suwu auth rm <id>         revoke one session
  suwu auth rm --all        revoke every session except the caller's own
                            (use --all --hard to sign this one out too)

The command talks to the running server over its Unix socket — the same channel
'suwu forward' uses — so it needs no password and no login. That is deliberate:
you reach for it exactly when you are locked out.

Flags:
  --sock <path>   notify socket (default <data dir>/suwu.sock)
  --json          machine-readable output (ls)
  --all           revoke every session (rm)
  --hard          with --all: also revoke the caller's session (rm)
  --yes           do not ask for confirmation (rm)

Exit codes: 0 success, 1 failure, 64 usage error
`

func printAuthUsage() { fmt.Fprint(os.Stderr, authUsageText) }

// authMain implements `suwu auth`; it returns the process exit code.
func authMain(args []string) int {
	if len(args) == 0 {
		printAuthUsage()
		return 64
	}
	cmd, rest := args[0], args[1:]
	var err error
	switch cmd {
	case "-h", "--help", "help":
		printAuthUsage()
		return 0
	case "ls", "list":
		err = authList(rest)
	case "rm", "remove", "revoke":
		err = authRemove(rest)
	default:
		fmt.Fprintf(os.Stderr, "auth: unknown command %q\n\n", cmd)
		printAuthUsage()
		return 64
	}
	if err != nil {
		if errors.Is(err, errAuthUsage) {
			return 64
		}
		fmt.Fprintf(os.Stderr, "auth: %v\n", err)
		return 1
	}
	return 0
}

var errAuthUsage = errors.New("usage")

// authSession is the session as the socket reports it.
type authSession struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Created  string `json:"created"`
	LastSeen string `json:"lastSeen"`
	Expires  string `json:"expires"`
	Current  bool   `json:"current"`
	Legacy   bool   `json:"legacy"`
}

func authList(args []string) error {
	fs := flag.NewFlagSet("auth ls", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	sockPath := fs.String("sock", "", "notify socket path")
	jsonOut := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return errAuthUsage
	}
	path, err := resolveSockPath(*sockPath)
	if err != nil {
		return err
	}
	resp, err := authRequest(path, "sessions-list", nil)
	if err != nil {
		return err
	}
	var payload struct {
		Sessions []authSession `json:"sessions"`
	}
	if err := json.Unmarshal(resp.Data, &payload); err != nil {
		return fmt.Errorf("invalid response: %w", err)
	}
	if *jsonOut {
		_, err := os.Stdout.Write(resp.Data)
		if err == nil && len(resp.Data) > 0 && resp.Data[len(resp.Data)-1] != '\n' {
			fmt.Println()
		}
		return err
	}
	if len(payload.Sessions) == 0 {
		fmt.Println("No sessions. A device gets one the next time it signs in.")
		return nil
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tDEVICE\tLAST SEEN\tEXPIRES\t")
	for _, s := range payload.Sessions {
		marker := ""
		if s.Current {
			marker = "  (this session)"
		} else if s.Legacy {
			marker = "  (pre-sessions token)"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s%s\n", s.ID, s.Label, humanAgo(s.LastSeen), humanUntil(s.Expires), marker)
	}
	return tw.Flush()
}

func authRemove(args []string) error {
	fs := flag.NewFlagSet("auth rm", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	sockPath := fs.String("sock", "", "notify socket path")
	all := fs.Bool("all", false, "revoke every session except this one")
	hard := fs.Bool("hard", false, "with --all: also revoke this session")
	yes := fs.Bool("yes", false, "do not ask for confirmation")
	if err := fs.Parse(args); err != nil {
		return errAuthUsage
	}
	id := fs.Arg(0)
	if *all && id != "" {
		return fmt.Errorf("--all takes no id")
	}
	if !*all && id == "" {
		fmt.Fprintln(os.Stderr, "auth rm: name a session id, or --all")
		return errAuthUsage
	}
	if *hard && !*all {
		return fmt.Errorf("--hard only applies to --all")
	}
	path, err := resolveSockPath(*sockPath)
	if err != nil {
		return err
	}
	if !*yes {
		what := "session " + id
		if *all {
			what = "every session"
			if !*hard {
				what = "every other session"
			}
		}
		fmt.Printf("Revoke %s? [y/N] ", what)
		var answer string
		_, _ = fmt.Scanln(&answer)
		if answer != "y" && answer != "Y" && answer != "yes" {
			fmt.Println("Cancelled.")
			return nil
		}
	}
	payload, _ := json.Marshal(map[string]any{"id": id, "all": *all, "hard": *hard})
	resp, err := authRequest(path, "sessions-revoke", payload)
	if err != nil {
		return err
	}
	var out struct {
		Revoked int    `json:"revoked"`
		Label   string `json:"label"`
	}
	_ = json.Unmarshal(resp.Data, &out)
	if *all {
		fmt.Printf("Revoked %d session(s).\n", out.Revoked)
	} else {
		label := out.Label
		if label == "" {
			label = id
		}
		fmt.Printf("Revoked %s (%s).\n", id, label)
	}
	if resp.Message != "" {
		fmt.Println(resp.Message)
	}
	return nil
}

// authRequest sends one command over the notify socket and returns the answer.
func authRequest(sockPath, action string, payload json.RawMessage) (notify.CommandResponse, error) {
	cmd := notify.Command{Action: action, Payload: payload}
	data, err := json.Marshal(cmd)
	if err != nil {
		return notify.CommandResponse{}, err
	}
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return notify.CommandResponse{}, fmt.Errorf("connect %s: %w\nhint: is the suwu server running?", sockPath, err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return notify.CommandResponse{}, fmt.Errorf("write: %w", err)
	}
	buf, err := io.ReadAll(conn)
	if err != nil {
		return notify.CommandResponse{}, fmt.Errorf("no response from the server")
	}
	var resp notify.CommandResponse
	if err := json.Unmarshal(buf, &resp); err != nil {
		return notify.CommandResponse{}, fmt.Errorf("invalid response: %w", err)
	}
	if !resp.OK {
		return resp, errors.New(resp.Error)
	}
	return resp, nil
}

// humanAgo renders an RFC3339 timestamp as "2 hours ago".
func humanAgo(stamp string) string {
	t, err := time.Parse(time.RFC3339, stamp)
	if err != nil {
		return "—"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d hr ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%d days ago", int(d.Hours()/24))
	}
}

// humanUntil renders an RFC3339 timestamp as "in 29 days".
func humanUntil(stamp string) string {
	t, err := time.Parse(time.RFC3339, stamp)
	if err != nil || t.IsZero() {
		return "—"
	}
	d := time.Until(t)
	if d <= 0 {
		return "expired"
	}
	switch {
	case d < time.Hour:
		return fmt.Sprintf("in %d min", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("in %d hr", int(d.Hours()))
	default:
		return fmt.Sprintf("in %d days", int(d.Hours()/24))
	}
}
