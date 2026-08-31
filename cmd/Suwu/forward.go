package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"

	"suwu/pkg/notify"
)

func forwardCmd(args []string) error {
	fs := flag.NewFlagSet("forward", flag.ContinueOnError)
	proto := fs.String("proto", "tcp", "protocol (tcp or udp)")
	sock := fs.String("sock", "", "path to the notify socket")
	stopPort := fs.Int("stop", 0, "stop forward by local port")
	list := fs.Bool("list", false, "list all active forwards")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, `Usage: suwu forward [flags] <localport> [targethost] <targetport>

Create TCP/UDP port forwarding through a running suwu server.

Examples:
  suwu forward 23000 localhost 3000
  suwu forward 23000 192.168.1.10 3000
  suwu forward --proto udp 23000 localhost 3000
  suwu forward --stop 23000
  suwu forward --list

Flags:
`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}

	sockPath, err := resolveForwardSock(*sock)
	if err != nil {
		return err
	}

	// --list: list all forwards
	if *list {
		return forwardSend(sockPath, "forward-list", nil)
	}

	// --stop: stop a forward
	if *stopPort > 0 {
		payload, _ := json.Marshal(map[string]int{"localPort": *stopPort})
		return forwardSend(sockPath, "forward-stop", payload)
	}

	// Start a forward: suwu forward <localport> [targethost] <targetport>
	if fs.NArg() < 2 {
		return fmt.Errorf("usage: suwu forward [flags] <localport> [targethost] <targetport>")
	}

	localPort, err := strconv.Atoi(fs.Arg(0))
	if err != nil || localPort < 1 || localPort > 65535 {
		return fmt.Errorf("invalid local port: %s", fs.Arg(0))
	}

	var targetHost string
	var targetPort int

	if fs.NArg() == 2 {
		// suwu forward <localport> <targetport>
		targetHost = "localhost"
		targetPort, err = strconv.Atoi(fs.Arg(1))
		if err != nil || targetPort < 1 || targetPort > 65535 {
			return fmt.Errorf("invalid target port: %s", fs.Arg(1))
		}
	} else {
		// suwu forward <localport> <targethost> <targetport>
		targetHost = fs.Arg(1)
		targetPort, err = strconv.Atoi(fs.Arg(2))
		if err != nil || targetPort < 1 || targetPort > 65535 {
			return fmt.Errorf("invalid target port: %s", fs.Arg(2))
		}
	}

	payload, _ := json.Marshal(map[string]any{
		"localPort":  localPort,
		"targetHost": targetHost,
		"targetPort": targetPort,
		"protocol":   *proto,
	})
	return forwardSend(sockPath, "forward-start", payload)
}

func forwardSend(sockPath, action string, payload json.RawMessage) error {
	cmd := notify.Command{
		Action:  action,
		Payload: payload,
	}
	data, err := json.Marshal(cmd)
	if err != nil {
		return fmt.Errorf("forward: marshal: %w", err)
	}
	data = append(data, '\n')

	// Connect to notify socket and send command
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return fmt.Errorf("forward: connect %s: %w\nhint: is the suwu server running?", sockPath, err)
	}
	defer conn.Close()

	if _, err := conn.Write(data); err != nil {
		return fmt.Errorf("forward: write: %w", err)
	}

	// Read response
	buf := make([]byte, 64*1024)
	n, err := conn.Read(buf)
	if err != nil {
		return fmt.Errorf("forward: no response from server")
	}

	var resp notify.CommandResponse
	if err := json.Unmarshal(buf[:n], &resp); err != nil {
		return fmt.Errorf("forward: invalid response: %w", err)
	}

	if !resp.OK {
		return fmt.Errorf("forward: %s", resp.Error)
	}

	if resp.Message != "" {
		fmt.Println(resp.Message)
	}

	if len(resp.Data) > 0 {
		var forwards []struct {
			ID           string `json:"id"`
			ExternalPort int    `json:"externalPort"`
			InternalHost string `json:"internalHost"`
			InternalPort int    `json:"internalPort"`
			Protocol     string `json:"protocol"`
			Status       string `json:"status"`
		}
		if err := json.Unmarshal(resp.Data, &forwards); err == nil {
			printForwardList(forwards)
		}
	}

	return nil
}

func printForwardList(forwards []struct {
	ID           string `json:"id"`
	ExternalPort int    `json:"externalPort"`
	InternalHost string `json:"internalHost"`
	InternalPort int    `json:"internalPort"`
	Protocol     string `json:"protocol"`
	Status       string `json:"status"`
}) {
	if len(forwards) == 0 {
		fmt.Println("No active forwards")
		return
	}

	fmt.Printf("%-8s %-6s %-20s %-8s %-10s\n", "ID", "PORT", "TARGET", "PROTO", "STATUS")
	fmt.Println(strings.Repeat("-", 60))
	for _, f := range forwards {
		target := fmt.Sprintf("%s:%d", f.InternalHost, f.InternalPort)
		fmt.Printf("%-8s %-6d %-20s %-8s %-10s\n",
			f.ID, f.ExternalPort, target, f.Protocol, f.Status)
	}
}

func resolveForwardSock(flagVal string) (string, error) {
	if flagVal != "" {
		return flagVal, nil
	}
	return notify.SocketPath()
}
