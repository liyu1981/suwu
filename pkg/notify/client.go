package notify

import (
	"fmt"
	"net"
)

// Send sends one or more newline-terminated messages to the notification
// listener via the Unix domain socket. Each line is broadcast as a separate
// notification. For a single message use msg; for streaming (pipe input) use
// msgs where each element is one line.
func Send(socketPath string, msgs ...string) error {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return fmt.Errorf("notify: connect %s: %w\nhint: is the suwu server running?", socketPath, err)
	}
	defer conn.Close()

	for _, msg := range msgs {
		if _, err := fmt.Fprintf(conn, "%s\n", msg); err != nil {
			return fmt.Errorf("notify: write: %w", err)
		}
	}
	return nil
}
