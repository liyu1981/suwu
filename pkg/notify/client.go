package notify

import (
	"fmt"
	"net"
)

// MaxMessageBytes is the maximum encoded notification size, excluding its
// terminating newline. Keep CLI validation and receiver framing in sync.
const MaxMessageBytes = 1 << 20 // 1 MiB

// MessageTooLargeError reports the shared limit before any data is sent.
func MessageTooLargeError() error {
	return fmt.Errorf("notification too large: limit is 1 MiB (1048576 bytes) of encoded JSON, including escaping and metadata; nothing was sent")
}

// Send sends one or more newline-terminated messages to the notification
// listener via the Unix domain socket. Each line is broadcast as a separate
// notification. For a single message use msg; for streaming (pipe input) use
// msgs where each element is one line.
func Send(socketPath string, msgs ...string) error {
	// Validate the whole batch before connecting, never send a partial batch
	// because a later notification is too large.
	for _, msg := range msgs {
		if len(msg) > MaxMessageBytes {
			return MessageTooLargeError()
		}
	}
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
