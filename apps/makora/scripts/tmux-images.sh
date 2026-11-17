#!/usr/bin/env bash
# Drives makora's image support in tmux at 140x40 (fake model, a temp repository and home, macOS clipboard): put a
# 1280x800 PNG on the clipboard, paste it with Ctrl+V into a draft, see the token and the attachment line, submit, and
# see the fake model report 1 image of that size; paste text with Ctrl+V; switch to faux-2, which takes no images, and
# see the draft refused and kept; type while a cell runs to steer with an image; run a cell that calls show() and see
# its line and the image reach the model; and resume the session to see the image line again. Screens go to
# /tmp/makora-images/ as text and ANSI. Exits non-zero, with the screen it saw, when a wait times out or a check fails.
#
#   apps/makora/scripts/tmux-images.sh
set -euo pipefail

OUT=/tmp/makora-images
APP=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/makora-images-run.XXXXXX")
session="makora-images-$$"
rm -rf "$OUT"
mkdir -p "$OUT" "$work/home" "$work/repo"
printf '# demo\n' >"$work/repo/README.md"
git -C "$work/repo" init -q -b main

# A 1280x800 RGB PNG from Python's standard library.
python3 - "$OUT/paste.png" <<'PY'
import struct, sys, zlib
w, h = 1280, 800
row = b"\x00" + bytes((x * 255 // w) for x in range(w) for _ in range(3))
chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * h)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
PY
image_to_clipboard() { osascript -e "set the clipboard to (read (POSIX file \"$OUT/paste.png\") as «class PNGf»)"; }

start() {
	tmux new-session -d -s "$session" -x 140 -y 40 -c "$work/repo" \
		"MAKORA_HOME='$work/home' node '$APP/bin/makora.mjs' --fake $*; sleep 30"
}
trap 'tmux kill-session -t "$session" 2>/dev/null || true' EXIT

screen() { tmux capture-pane -t "$session" -p; }
fail() {
	screen >"$OUT/failed.txt"
	echo "$1; screen in $OUT/failed.txt" >&2
	exit 1
}
capture() {
	screen >"$OUT/$1.txt"
	tmux capture-pane -t "$session" -p -e >"$OUT/$1.ansi"
	echo "captured $1"
}
# Wait until the screen shows `pattern` (a grep -E regex), then capture it as `name`.
wait_for() {
	local pattern=$1 name=$2 timeout=${3:-20}
	local deadline=$((SECONDS + timeout))
	until screen | grep -Eq -- "$pattern"; do
		((SECONDS <= deadline)) || fail "timed out after ${timeout}s waiting for $name (/$pattern/)"
		sleep 0.2
	done
	capture "$name"
}
# The editor's last row: the line above the last box bottom on screen, which is the editor's.
editor() { screen | awk '/^╰/ { row = previous } { previous = $0 } END { print row }'; }
keys() { tmux send-keys -t "$session" "$@"; }
model() {
	keys C-l
	sleep 0.5
	keys "$1"
	sleep 0.3
	keys Enter
	wait_for "· Model: faux/$1" "$2"
}

start
wait_for "ctrl\+v paste image" 01-startup 30

image_to_clipboard
keys "how many images in "
keys C-v
wait_for "^image #1 · png · 1280×800 · [0-9]+ KB" 02-pasted
editor | grep -q "how many images in \[image #1\]" || fail "the draft holds the token"
keys Enter
wait_for "The last message had 1 image\(s\): png · 1280×800 · [0-9]+ KB\." 03-answered
screen | grep -q "› how many images in \[image #1 · png · 1280×800\]" || fail "the user line names the image"
screen | grep -Eq "^image #1 · " && fail "the attachment line went with the sent draft"

printf 'pasted text 42' | pbcopy
keys C-v
wait_for "│ pasted text 42 " 04-text-pasted
keys C-c

model faux-2 05-faux-2
image_to_clipboard
keys "and " C-v
wait_for "^image #1 · png · 1280×800" 06-pasted-on-faux-2
keys Enter
wait_for "faux-2 cannot see images; switch with /model or remove \[image #1\]" 07-refused
editor | grep -q "and \[image #1\]" || fail "the refused draft stays in the editor"
screen | grep -Eq "^image #1 · png · 1280×800" || fail "the refused draft keeps its attachment"
keys C-c
model faux-1 08-faux-1

keys "tool"
keys Enter
wait_for "python · cell 1" 09-cell-running
keys "how many images now " C-v
sleep 1
keys Enter
wait_for "› how many images now \[image #1 · png · 1280×800\]" 10-steered 30
deadline=$((SECONDS + 30))
until (($(screen | grep -c "The last message had 1 image(s): png · 1280×800") >= 2)); do
	((SECONDS <= deadline)) || fail "timed out waiting for the answer to the steer"
	sleep 0.2
done
capture 11-steer-answered

keys "show-image"
keys Enter
wait_for "It carried 1 image\(s\): png · 800×600\." 12-shown 30
keys C-o
wait_for "┆ image · png · 800×600" 13-shown-expanded
keys C-o

keys C-d
sleep 1
tmux kill-session -t "$session" 2>/dev/null || true
start --continue
wait_for "› how many images now \[image #1 · png · 1280×800\]" 14-resumed 30
keys C-d
echo "screens in $OUT"
