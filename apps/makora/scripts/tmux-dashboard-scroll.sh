#!/usr/bin/env bash
# Drives makora's agents dashboard in tmux with more agents than fit (fake model, a temp repository and home, 140x40):
# a pasted python block makes the parent spawn 40 short review children. The dashboard is captured at the top of the
# list while they run, then, once every child finished, with the selection at the bottom, in the narrow layout at
# 90x40, back at the top, in the middle, and wide again. Each capture must show the selection bar (▌) and the
# `↑ N more` / `↓ N more` markers the list's position calls for. Screens go to /tmp/makora-dashboard-scroll/ as text
# and ANSI. Exits non-zero, with the screen it saw, when a wait times out or a check fails.
#
#   apps/makora/scripts/tmux-dashboard-scroll.sh
set -euo pipefail

OUT=/tmp/makora-dashboard-scroll
APP=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/makora-dashboard-scroll-run.XXXXXX")
SESSION="makora-dashboard-scroll-$$"
REPO="$WORK/repo"

rm -rf "$OUT"
mkdir -p "$OUT" "$WORK/home" "$REPO"
printf '{"worktrees":{"review":"%s","write":"%s"}}\n' "$WORK/review" "$WORK/write" >"$WORK/home/settings.json"
cd "$REPO"
printf '# demo\n' >README.md
git init -q -b main
git add README.md
git -c user.name=demo -c user.email=demo@localhost commit -qm init

tmux new-session -d -s "$SESSION" -x 140 -y 40 -c "$REPO" \
	"MAKORA_HOME='$WORK/home' node '$APP/bin/makora.mjs' --fake; sleep 30"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true' EXIT

screen() {
	tmux capture-pane -t "$SESSION" -p
}

fail() {
	screen >"$OUT/failed.txt"
	echo "$1; screen in $OUT/failed.txt" >&2
	exit 1
}

# Wait until the screen shows `pattern` (a grep -E regex), then capture it as `name`.
wait_for() {
	local pattern=$1 name=$2 timeout=${3:-30}
	local deadline=$((SECONDS + timeout))
	until screen | grep -Eq -- "$pattern"; do
		((SECONDS <= deadline)) || fail "timed out after ${timeout}s waiting for $name (/$pattern/)"
		sleep 0.2
	done
	capture "$name"
}

capture() {
	screen >"$OUT/$1.txt"
	tmux capture-pane -t "$SESSION" -p -e >"$OUT/$1.ansi"
	echo "captured $1"
}

# Check that capture `name` shows the selection bar, and that it has (`yes`) or lacks (`no`) each marker.
markers() {
	local name=$1 up=$2 down=$3 file="$OUT/$1.txt"
	grep -q "▌" "$file" || fail "$name shows no selected row"
	[[ $up == yes ]] && { grep -Eq "↑ [0-9]+ more" "$file" || fail "$name lacks the ↑ marker"; }
	[[ $up == no ]] && grep -Eq "↑ [0-9]+ more" "$file" && fail "$name shows a ↑ marker at the top"
	[[ $down == yes ]] && { grep -Eq "↓ [0-9]+ more" "$file" || fail "$name lacks the ↓ marker"; }
	[[ $down == no ]] && grep -Eq "↓ [0-9]+ more" "$file" && fail "$name shows a ↓ marker at the bottom"
	echo "checked $name"
}

press() {
	local key=$1 count=$2
	for _ in $(seq "$count"); do
		tmux send-keys -t "$SESSION" "$key"
		sleep 0.05
	done
	sleep 0.6
}

wait_for "ctrl\+a agents" 01-startup
# The fake model runs a prompt's python block as its one cell.
tmux set-buffer -b scroll -- $'```python\nfor i in range(40):\n    await spawn(f"agent-{i:02}", "review", mode="review")\nprint("spawned", len(await agents.list()))\n```'
tmux paste-buffer -p -d -b scroll -t "$SESSION"
sleep 0.3
tmux send-keys -t "$SESSION" Enter
wait_for "spawned 40" 02-spawned 90
tmux send-keys -t "$SESSION" C-a
wait_for "Agents · " 03-top 10
markers 03-top no yes
# Rows move between sections while children finish; the moves below wait until the order is final.
wait_for "0 running · 0 waiting on you · 41 done" 04-all-done 180
markers 04-all-done no yes
press Down 45
capture 05-bottom
markers 05-bottom yes no
tmux resize-window -t "$SESSION" -x 90 -y 40
sleep 0.8
capture 06-bottom-narrow
markers 06-bottom-narrow yes no
press Up 45
capture 07-top-narrow
markers 07-top-narrow no yes
press Down 20
capture 08-middle-narrow
markers 08-middle-narrow yes yes
tmux resize-window -t "$SESSION" -x 140 -y 40
sleep 0.8
capture 09-middle
markers 09-middle yes no
tmux send-keys -t "$SESSION" Escape
tmux send-keys -t "$SESSION" C-d
echo "screens in $OUT"
