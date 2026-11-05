package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"text/tabwriter"

	"suwu/pkg/notify"
)

// staticServeCmd implements `suwu static-serve`, the client for the running
// server's in-memory static preview registry.
func staticServeCmd(args []string) error {
	fs := flag.NewFlagSet("static-serve", flag.ContinueOnError)
	sock := fs.String("sock", "", "path to the notify socket")
	list := fs.Bool("list", false, "list active static serves")
	pause := fs.String("pause", "", "pause a static serve by id")
	resume := fs.String("resume", "", "resume a paused static serve by id")
	remove := fs.String("remove", "", "remove a static serve by id")
	stop := fs.String("stop", "", "alias for --remove")
	forceNew := fs.Bool("new", false, "create a new entry even if the directory is already served")
	jsonOut := fs.Bool("json", false, "print the raw JSON response")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, `Usage: suwu static-serve [flags] <dir>

Serve a folder through a running Suwu server at /staticserve/<id>/.
The folder id comes from the last path element; conflicts get myweb1,
myweb2, ... Re-running the same directory reuses its entry and asks the
browser to open the Static Browser tile.

Flags:
`)
		fs.PrintDefaults()
		fmt.Fprintf(os.Stderr, `
Examples:
  suwu static-serve ./website
  suwu static-serve /home/user/app --new
  suwu static-serve --list
  suwu static-serve --pause myweb
  suwu static-serve --resume myweb
  suwu static-serve --remove myweb
`)
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	sockPath, err := resolveStaticSock(*sock)
	if err != nil {
		return err
	}

	switch {
	case *list:
		return staticSend(sockPath, "staticserve-list", nil, *jsonOut)
	case *pause != "":
		payload, _ := json.Marshal(map[string]string{"id": *pause})
		return staticSend(sockPath, "staticserve-pause", payload, *jsonOut)
	case *resume != "":
		payload, _ := json.Marshal(map[string]string{"id": *resume})
		return staticSend(sockPath, "staticserve-resume", payload, *jsonOut)
	case *remove != "" || *stop != "":
		id := *remove
		if id == "" {
			id = *stop
		}
		payload, _ := json.Marshal(map[string]string{"id": id})
		return staticSend(sockPath, "staticserve-remove", payload, *jsonOut)
	}

	if fs.NArg() != 1 {
		fs.Usage()
		return fmt.Errorf("a directory is required")
	}
	dir, err := filepath.Abs(fs.Arg(0))
	if err != nil {
		return fmt.Errorf("resolve directory: %w", err)
	}
	payload, _ := json.Marshal(map[string]any{"dir": dir, "new": *forceNew})
	return staticSend(sockPath, "staticserve-start", payload, *jsonOut)
}

func staticSend(sockPath, action string, payload json.RawMessage, jsonOut bool) error {
	cmd := notify.Command{Action: action, Payload: payload}
	data, err := json.Marshal(cmd)
	if err != nil {
		return fmt.Errorf("static-serve: marshal: %w", err)
	}
	data = append(data, '\n')

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return fmt.Errorf("static-serve: connect %s: %w\nhint: is the suwu server running?", sockPath, err)
	}
	defer conn.Close()

	if _, err := conn.Write(data); err != nil {
		return fmt.Errorf("static-serve: write: %w", err)
	}

	buf, err := io.ReadAll(conn)
	if err != nil {
		return fmt.Errorf("static-serve: no response from server")
	}
	var resp notify.CommandResponse
	if err := json.Unmarshal(buf, &resp); err != nil {
		return fmt.Errorf("static-serve: invalid response: %w", err)
	}
	if !resp.OK {
		return fmt.Errorf("static-serve: %s", resp.Error)
	}

	if jsonOut {
		if len(resp.Data) > 0 {
			fmt.Println(string(resp.Data))
		}
		return nil
	}

	switch action {
	case "staticserve-list":
		var body struct {
			Serves []struct {
				ID        string `json:"id"`
				Dir       string `json:"dir"`
				Prefix    string `json:"prefix"`
				Status    string `json:"status"`
				CreatedAt string `json:"createdAt"`
			} `json:"serves"`
		}
		if err := json.Unmarshal(resp.Data, &body); err != nil {
			return fmt.Errorf("static-serve: invalid list response: %w", err)
		}
		printStaticServeList(body.Serves)
	case "staticserve-start":
		var body struct {
			Serve struct {
				ID     string `json:"id"`
				Dir    string `json:"dir"`
				Prefix string `json:"prefix"`
			} `json:"serve"`
			Created bool `json:"created"`
		}
		if err := json.Unmarshal(resp.Data, &body); err != nil {
			return fmt.Errorf("static-serve: invalid start response: %w", err)
		}
		if body.Created {
			fmt.Printf("Serving %s at %s\n", body.Serve.Dir, body.Serve.Prefix)
		} else {
			fmt.Printf("Already serving %s at %s\n", body.Serve.Dir, body.Serve.Prefix)
		}
	case "staticserve-pause":
		var body struct {
			ID     string `json:"id"`
			Prefix string `json:"prefix"`
		}
		_ = json.Unmarshal(resp.Data, &body)
		fmt.Printf("Paused %s at %s\n", body.ID, body.Prefix)
	case "staticserve-resume":
		var body struct {
			ID     string `json:"id"`
			Prefix string `json:"prefix"`
		}
		_ = json.Unmarshal(resp.Data, &body)
		fmt.Printf("Resumed %s at %s\n", body.ID, body.Prefix)
	case "staticserve-remove":
		fmt.Println(resp.Message)
	default:
		if resp.Message != "" {
			fmt.Println(resp.Message)
		}
	}
	return nil
}

func printStaticServeList(serves []struct {
	ID        string `json:"id"`
	Dir       string `json:"dir"`
	Prefix    string `json:"prefix"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}) {
	if len(serves) == 0 {
		fmt.Println("No active static serves")
		return
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tSTATUS\tCREATED\tENDPOINT\tPATH")
	for _, s := range serves {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", s.ID, s.Status, s.CreatedAt, s.Prefix, s.Dir)
	}
	_ = tw.Flush()
}

func resolveStaticSock(flagVal string) (string, error) {
	if flagVal != "" {
		return flagVal, nil
	}
	return notify.SocketPath()
}

// staticServeMessage is shared by the notify handler and the browser action.
func staticServeMessage(dir, prefix string, created bool) string {
	verb := "Static site ready"
	if !created {
		verb = "Static site already served"
	}
	return fmt.Sprintf("%s: %s → %s", verb, dir, prefix)
}
