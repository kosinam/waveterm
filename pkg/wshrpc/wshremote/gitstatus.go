// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	gitCmdTimeout   = 5 * time.Second
	gitMaxFileSize  = 2 * 1024 * 1024 // don't load file contents larger than this into the diff viewer
	gitMaxDiffFiles = 500             // cap the number of files returned by the diff command
)

// runGit runs a git subcommand in dir and returns stdout. A non-zero exit is returned as an error.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitCmdTimeout)
	defer cancel()
	fullArgs := append([]string{"-C", dir, "-c", "core.quotepath=false"}, args...)
	cmd := exec.CommandContext(ctx, "git", fullArgs...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// repoRoot resolves the top-level directory of the repo containing path.
// Returns (root, isRepo, err): isRepo=false with nil err only when git definitively
// reports "not a git repository"; any other failure (timeout, exec error) returns a
// non-nil err so callers can preserve prior state instead of treating it as "no repo".
func repoRoot(ctx context.Context, path string) (string, bool, error) {
	out, err := runGit(ctx, path, "rev-parse", "--show-toplevel")
	if err != nil {
		if strings.Contains(err.Error(), "not a git repository") {
			return "", false, nil
		}
		return "", false, err
	}
	root := strings.TrimSpace(out)
	if root == "" {
		return "", false, nil
	}
	return root, true, nil
}

func (impl *ServerImpl) RemoteGitStatusCommand(ctx context.Context, data wshrpc.CommandRemoteGitStatusData) (*wshrpc.GitStatusResponse, error) {
	path := data.Path
	if path == "" {
		path = "."
	}
	root, isRepo, err := repoRoot(ctx, path)
	if err != nil {
		// transient git failure — surface as an error so the frontend keeps the last badge
		return nil, err
	}
	if !isRepo {
		return &wshrpc.GitStatusResponse{IsRepo: false}, nil
	}
	resp := &wshrpc.GitStatusResponse{IsRepo: true, RepoName: filepath.Base(root)}

	statusOut, err := runGit(ctx, root, "status", "--porcelain=v2", "--branch")
	if err != nil {
		return nil, err
	}
	var oid string
	for _, line := range strings.Split(statusOut, "\n") {
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "# branch.head "):
			resp.Branch = strings.TrimPrefix(line, "# branch.head ")
			if resp.Branch == "(detached)" {
				resp.Detached = true
			}
		case strings.HasPrefix(line, "# branch.oid "):
			oid = strings.TrimPrefix(line, "# branch.oid ")
		case strings.HasPrefix(line, "# branch.upstream "):
			resp.HasUpstream = true
		case strings.HasPrefix(line, "# branch.ab "):
			// format: "# branch.ab +A -B"
			abFields := strings.Fields(strings.TrimPrefix(line, "# branch.ab "))
			if len(abFields) == 2 {
				if a, err := strconv.Atoi(strings.TrimPrefix(abFields[0], "+")); err == nil {
					resp.Ahead = a
				}
				if b, err := strconv.Atoi(strings.TrimPrefix(abFields[1], "-")); err == nil {
					resp.Behind = b
				}
			}
		case strings.HasPrefix(line, "1 ") || strings.HasPrefix(line, "2 "):
			fields := strings.SplitN(line, " ", 3)
			if len(fields) >= 2 && len(fields[1]) == 2 {
				xy := fields[1]
				if xy[0] != '.' {
					resp.Staged++
				}
				if xy[1] != '.' {
					resp.Modified++
				}
			}
		case strings.HasPrefix(line, "u "):
			// unmerged (conflict) — count on both sides
			resp.Staged++
			resp.Modified++
		case strings.HasPrefix(line, "? "):
			resp.Untracked++
		}
	}
	if oid != "" && oid != "(initial)" {
		short := oid
		if len(short) > 7 {
			short = short[:7]
		}
		resp.Commit = short
		if resp.Detached {
			resp.Branch = short
		}
	}

	ins, del := gitNumstatTotals(ctx, root)
	resp.Insertions = ins
	resp.Deletions = del
	return resp, nil
}

// gitNumstatTotals returns the total insertions/deletions of all uncommitted tracked changes
// (staged + unstaged) relative to HEAD. Falls back to the staged-only diff when there is no HEAD yet.
func gitNumstatTotals(ctx context.Context, root string) (int, int) {
	out, err := runGit(ctx, root, "diff", "HEAD", "--numstat")
	if err != nil {
		// No commits yet — diff the index against the empty tree.
		out, err = runGit(ctx, root, "diff", "--cached", "--numstat")
		if err != nil {
			return 0, 0
		}
	}
	var ins, del int
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 3)
		if len(fields) < 3 {
			continue
		}
		if a, err := strconv.Atoi(fields[0]); err == nil {
			ins += a
		}
		if d, err := strconv.Atoi(fields[1]); err == nil {
			del += d
		}
	}
	return ins, del
}

func (impl *ServerImpl) RemoteGitDiffCommand(ctx context.Context, data wshrpc.CommandRemoteGitDiffData) (*wshrpc.GitDiffResponse, error) {
	path := data.Path
	if path == "" {
		path = "."
	}
	root, isRepo, err := repoRoot(ctx, path)
	if err != nil {
		return nil, err
	}
	if !isRepo {
		return &wshrpc.GitDiffResponse{}, nil
	}
	resp := &wshrpc.GitDiffResponse{RepoRoot: root}

	hasHead := false
	if _, err := runGit(ctx, root, "rev-parse", "--verify", "HEAD"); err == nil {
		hasHead = true
	}

	numstat := gitNumstatByFile(ctx, root, hasHead)

	// Tracked changes (staged + unstaged) vs HEAD.
	if hasHead {
		nameStatus, err := runGit(ctx, root, "diff", "HEAD", "--name-status", "-z")
		if err == nil {
			resp.Files = append(resp.Files, parseNameStatusZ(ctx, root, nameStatus, numstat)...)
		}
	}

	// Untracked files.
	untrackedOut, err := runGit(ctx, root, "ls-files", "--others", "--exclude-standard", "-z")
	if err == nil {
		for _, name := range splitZ(untrackedOut) {
			if name == "" {
				continue
			}
			f := wshrpc.GitDiffFile{FileName: name, Status: "untracked"}
			f.Modified64, f.Binary = readWorkingFile(root, name)
			resp.Files = append(resp.Files, f)
			if len(resp.Files) >= gitMaxDiffFiles {
				break
			}
		}
	}

	if len(resp.Files) > gitMaxDiffFiles {
		resp.Files = resp.Files[:gitMaxDiffFiles]
	}
	return resp, nil
}

type numstatEntry struct {
	ins int
	del int
}

// gitNumstatByFile builds a map from file path (new name for renames) to insertion/deletion counts.
func gitNumstatByFile(ctx context.Context, root string, hasHead bool) map[string]numstatEntry {
	result := make(map[string]numstatEntry)
	args := []string{"diff", "HEAD", "--numstat", "-z"}
	if !hasHead {
		args = []string{"diff", "--cached", "--numstat", "-z"}
	}
	out, err := runGit(ctx, root, args...)
	if err != nil {
		return result
	}
	tokens := splitZ(out)
	for i := 0; i < len(tokens); i++ {
		tok := tokens[i]
		if tok == "" {
			continue
		}
		fields := strings.SplitN(tok, "\t", 3)
		if len(fields) < 3 {
			continue
		}
		ins, _ := strconv.Atoi(fields[0]) // "-" for binary parses to 0
		del, _ := strconv.Atoi(fields[1])
		name := fields[2]
		if name == "" {
			// rename: the following two NUL tokens are old, new
			if i+2 < len(tokens) {
				name = tokens[i+2]
				i += 2
			}
		}
		if name != "" {
			result[name] = numstatEntry{ins: ins, del: del}
		}
	}
	return result
}

// parseNameStatusZ parses `git diff --name-status -z` output into GitDiffFile records, loading contents.
func parseNameStatusZ(ctx context.Context, root string, out string, numstat map[string]numstatEntry) []wshrpc.GitDiffFile {
	tokens := splitZ(out)
	var files []wshrpc.GitDiffFile
	for i := 0; i < len(tokens); i++ {
		code := tokens[i]
		if code == "" {
			continue
		}
		letter := code[0]
		var oldName, newName string
		if letter == 'R' || letter == 'C' {
			if i+2 >= len(tokens) {
				break
			}
			oldName = tokens[i+1]
			newName = tokens[i+2]
			i += 2
		} else {
			if i+1 >= len(tokens) {
				break
			}
			newName = tokens[i+1]
			oldName = newName
			i++
		}
		f := wshrpc.GitDiffFile{FileName: newName}
		switch letter {
		case 'A':
			f.Status = "added"
			f.Modified64, f.Binary = readWorkingFile(root, newName)
		case 'D':
			f.Status = "deleted"
			f.Original64, f.Binary = readGitBlob(ctx, root, "HEAD:"+oldName)
		case 'R':
			f.Status = "renamed"
			f.OldFileName = oldName
			f.Original64, f.Binary = readGitBlob(ctx, root, "HEAD:"+oldName)
			mod, binMod := readWorkingFile(root, newName)
			f.Modified64 = mod
			f.Binary = f.Binary || binMod
		default: // M, C, T, etc. treated as modified
			f.Status = "modified"
			f.Original64, f.Binary = readGitBlob(ctx, root, "HEAD:"+oldName)
			mod, binMod := readWorkingFile(root, newName)
			f.Modified64 = mod
			f.Binary = f.Binary || binMod
		}
		if ns, ok := numstat[newName]; ok {
			f.Insertions = ns.ins
			f.Deletions = ns.del
		}
		files = append(files, f)
	}
	return files
}

// readGitBlob returns the base64-encoded contents of a git object (e.g. "HEAD:path"), and whether it is binary.
func readGitBlob(ctx context.Context, root string, ref string) (string, bool) {
	out, err := runGit(ctx, root, "show", ref)
	if err != nil {
		return "", false
	}
	data := []byte(out)
	if len(data) > gitMaxFileSize || bytes.IndexByte(data, 0) >= 0 {
		return "", true
	}
	return base64.StdEncoding.EncodeToString(data), false
}

// readWorkingFile returns the base64-encoded contents of a working-tree file, and whether it is binary/too-large.
func readWorkingFile(root string, name string) (string, bool) {
	full := filepath.Join(root, name)
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		return "", false
	}
	if info.Size() > gitMaxFileSize {
		return "", true
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", false
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return "", true
	}
	return base64.StdEncoding.EncodeToString(data), false
}

// splitZ splits NUL-delimited git output into tokens (dropping a trailing empty token).
func splitZ(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\x00")
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}
