#!/usr/bin/env bash
# Drives makora's TUI in tmux (140x40, fake model, a temp repository and home): the parent spawns two reviewers and a
# writer, parks in wait_agents, then merges the writer. Each stage is captured to /tmp/makora-agents/ as text and ANSI.
# Exits non-zero, with the screen it saw, when any wait times out.
#
#   apps/makora/scripts/tmux-agents.sh
set -euo pipefail

OUT=/tmp/makora-agents
APP=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/makora-agents-run.XXXXXX")
SESSION="makora-agents-$$"

rm -rf "$OUT"
mkdir -p "$OUT" "$WORK/home" "$WORK/repo"
printf '{"worktrees":{"review":"%s","write":"%s"}}\n' "$WORK/review" "$WORK/write" >"$WORK/home/settings.json"
cd "$WORK/repo"
printf '# demo\n' >README.md
git init -q -b main
git add README.md
git -c user.name=demo -c user.email=demo@localhost commit -qm init

tmux new-session -d -s "$SESSION" -x 140 -y 40 -c "$WORK/repo" \
	"MAKORA_HOME='$WORK/home' node '$APP/bin/makora.mjs' --fake; sleep 30"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true' EXIT

# Wait until the screen shows `pattern` (a grep -E regex), then capture it as `name`.
wait_for() {
	local pattern=$1 name=$2 timeout=$3
	local deadline=$((SECONDS + timeout))
	until tmux capture-pane -t "$SESSION" -p | grep -Eq -- "$pattern"; do
		if ((SECONDS > deadline)); then
			tmux capture-pane -t "$SESSION" -p >"$OUT/timeout-$name.txt"
			echo "timed out after ${timeout}s waiting for $name (/$pattern/); screen in $OUT/timeout-$name.txt" >&2
			exit 1
		fi
		sleep 0.2
	done
	tmux capture-pane -t "$SESSION" -p >"$OUT/$name.txt"
	tmux capture-pane -t "$SESSION" -p -e >"$OUT/$name.ansi"
	echo "captured $name"
}

wait_for "ctrl\+a agents" 01-startup 30
tmux send-keys -t "$SESSION" "agents" Enter
wait_for "wait_agents" 02-waiting 60
wait_for "'merged': True" 03-merged 120
tmux send-keys -t "$SESSION" C-o
wait_for "writer: merged|writer: done" 04-results 10
tmux send-keys -t "$SESSION" C-o
tmux send-keys -t "$SESSION" C-a
wait_for "reviewer-a" 05-agents-view 10
tmux send-keys -t "$SESSION" Escape
tmux send-keys -t "$SESSION" C-d
echo "screens in $OUT"
