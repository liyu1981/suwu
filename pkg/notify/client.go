package notify

import (
	"fmt"
	"net"
)

// Ping sends a single message to the notification listener via the Unix
// domain socket. It is a one-shot fire-and-forget: connect, write, close.
func Ping(socketPath, message string) error {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return fmt.Errorf("notify: connect %s: %w\nhint: is the suwu server running?", socketPath, err)
	}
	defer conn.Close()

	if _, err := fmt.Fprintf(conn, "%s\n", message); err != nil {
		return fmt.Errorf("notify: write: %w", err)
	}
	return nil
}
