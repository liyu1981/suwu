package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"suwu/pkg/notify"
)

// diffAction is the JSON payload sent by `suwu diff`.
type diffAction struct {
	Action  string      `json:"action"`
	Payload diffPayload `json:"payload"`
}

type diffPayload struct {
	Type  string `json:"type"`
	File1 string `json:"file1"`
	File2 string `json:"file2"`
}

func diffMain(args []string) error {
	fs := flag.NewFlagSet("diff", flag.ContinueOnError)
	sock := fs.String("sock", "", "path to the notify socket (default ~/.suwu/suwu.sock, or $SUWU_SOCK_PATH)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if fs.NArg() != 2 {
		return fmt.Errorf("usage: suwu diff [--sock <path>] <file1> <file2>")
	}

	rawFile1 := fs.Args()[0]
	rawFile2 := fs.Args()[1]

	file1, err := filepath.Abs(rawFile1)
	if err != nil {
		return fmt.Errorf("resolve file1 path: %w", err)
	}
	file2, err := filepath.Abs(rawFile2)
	if err != nil {
		return fmt.Errorf("resolve file2 path: %w", err)
	}

	if _, err := os.Stat(file1); err != nil {
		return fmt.Errorf("file1: %w", err)
	}
	if _, err := os.Stat(file2); err != nil {
		return fmt.Errorf("file2: %w", err)
	}

	action := diffAction{
		Action: "diff",
		Payload: diffPayload{
			Type:  "diff",
			File1: file1,
			File2: file2,
		},
	}

	data, err := json.Marshal(action)
	if err != nil {
		return fmt.Errorf("marshal action: %w", err)
	}

	sockPath, err := resolveSockPath(*sock)
	if err != nil {
		return err
	}

	n := notify.Notification{
		Message: fmt.Sprintf("Diff: %s ↔ %s", filepath.Base(file1), filepath.Base(file2)),
		Data:    data,
	}
	nJSON, err := json.Marshal(n)
	if err != nil {
		return fmt.Errorf("marshal notification: %w", err)
	}

	if err := notify.Send(sockPath, string(nJSON)); err != nil {
		return err
	}
	fmt.Printf("Diff: %s ↔ %s\n", file1, file2)
	return nil
}
