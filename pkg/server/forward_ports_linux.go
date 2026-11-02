//go:build linux

package server

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// readListeningPorts reads /proc/net/tcp and /proc/net/tcp6 to find all
// listening TCP ports. State 0A = LISTEN.
func readListeningPorts() []int {
	seen := make(map[int]bool)
	var ports []int

	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		lineNo := 0
		for scanner.Scan() {
			lineNo++
			if lineNo == 1 {
				continue // skip header
			}
			line := scanner.Text()
			fields := strings.Fields(line)
			if len(fields) < 4 {
				continue
			}
			// State is field[3], "0A" = LISTEN
			if fields[3] != "0A" {
				continue
			}
			// Local address is field[1], format is IP:PORT in hex
			parts := strings.Split(fields[1], ":")
			if len(parts) < 2 {
				continue
			}
			portHex := parts[len(parts)-1]
			port, err := strconv.ParseInt(portHex, 16, 32)
			if err != nil || port < 1 {
				continue
			}
			p := int(port)
			if !seen[p] {
				seen[p] = true
				ports = append(ports, p)
			}
		}
		f.Close()
	}

	return ports
}

