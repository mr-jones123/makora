#!/usr/bin/env bash
# Drives makora's agents dashboard in tmux (fake model, a temp repository and home), at 140x40 with 90x40 captures of
# the narrow layout: the parent spawns two reviewers, a writer and a sleeper; the dashboard is captured while they run
# and after they finish; then `d` diffs the writer against its base, `m` merges it, `s` stops the sleeper, `x` removes
# a reviewer, and Enter opens the other reviewer, where a typed message runs it again. Screens go to
# /tmp/makora-dashboard/ as text and ANSI. Exits non-zero, with the screen it saw, when any wait times out or a check
# on the repository fails.
#
#   apps/makora/scripts/tmux-dashboard.sh
set -euo pipefail

OUT=/tmp/makora-dashboard
APP=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/makora-dashboard-run.XXXXXX")
SESSION="makora-dashboard-$$"
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

# Capture the current screen again at 90 columns as `name`, then go back to 140.
narrow() {
	tmux resize-window -t "$SESSION" -x 90 -y 40
	sleep 0.6
	capture "$1"
	tmux resize-window -t "$SESSION" -x 140 -y 40
	sleep 0.4
}

# Move the dashboard's selection bar (▌) onto the row named `name`.
select_row() {
	local name=$1
	for _ in $(seq 10); do tmux send-keys -t "$SESSION" Up; done
	for _ in $(seq 12); do
		sleep 0.3
		if screen | grep -Eq -- "▌. +$name "; then return 0; fi
		tmux send-keys -t "$SESSION" Down
	done
	fail "could not select $name"
}

wait_for "ctrl\+a agents" 01-startup
tmux send-keys -t "$SESSION" "dashboard" Enter
wait_for "sleeper: queued|sleeper: running" 02-spawned 60
tmux send-keys -t "$SESSION" C-a
wait_for "reviewer-a +review .*cell 1" 03-running 30
narrow 04-running-narrow
# The same open dashboard, polled: the reviewers finish and the writer waits on the user.
wait_for "1 running · 1 waiting on you" 05-waiting 90
narrow 06-waiting-narrow

select_row writer
capture 07-writer-selected
tmux send-keys -t "$SESSION" d
wait_for "A CHANGES\.md" 08-writer-diff 20
grep -q "usage: makora --fake" "$OUT/08-writer-diff.txt" || fail "the diff does not show the writer's line"
tmux send-keys -t "$SESSION" Escape
wait_for "waiting on you" 09-back-from-diff 10

tmux send-keys -t "$SESSION" m
wait_for "Merge writer" 10-merge-confirm 10
tmux send-keys -t "$SESSION" Enter
wait_for "Merged writer" 11-merged 30
{
	echo "\$ git log --oneline --graph -4"
	git -C "$REPO" log --oneline --graph -4
	echo "\$ cat CHANGES.md"
	cat "$REPO/CHANGES.md"
	echo "\$ git status --porcelain"
	git -C "$REPO" status --porcelain
} >"$OUT/12-main-tree.txt"
git -C "$REPO" log -1 --format=%s | grep -q "^Merge writer" || fail "no merge commit on main"
grep -q "usage: makora --fake" "$REPO/CHANGES.md" || fail "the main tree lacks the writer's change"
echo "checked 12-main-tree"

select_row sleeper
tmux send-keys -t "$SESSION" s
wait_for "Stop sleeper" 13-stop-confirm 10
tmux send-keys -t "$SESSION" Enter
wait_for "Stopped sleeper" 14-stopped 30
wait_for "✗ +sleeper" 15-sleeper-stopped 15

git -C "$REPO" worktree list --porcelain | grep '^worktree ' | sort >"$WORK/worktrees-before"
select_row reviewer-a
tmux send-keys -t "$SESSION" x
wait_for "Remove reviewer-a" 16-remove-confirm 10
tmux send-keys -t "$SESSION" Enter
wait_for "Removed reviewer-a" 17-removed 30
git -C "$REPO" worktree list --porcelain | grep '^worktree ' | sort >"$WORK/worktrees-after"
gone=$(comm -23 "$WORK/worktrees-before" "$WORK/worktrees-after" | sed 's/^worktree //')
{
	echo "worktrees before:"
	cat "$WORK/worktrees-before"
	echo "worktrees after:"
	cat "$WORK/worktrees-after"
	echo "removed: $gone"
	[[ -n "$gone" && ! -e "$gone" ]] && echo "the removed worktree's folder is gone"
} >"$OUT/18-worktree-gone.txt"
[[ $(echo "$gone" | grep -c .) -eq 1 && ! -e "$gone" ]] || fail "reviewer-a's worktree was not removed exactly"
screen | grep -Eq "[✓✗◌] +reviewer-a " && fail "reviewer-a is still listed"
echo "checked 18-worktree-gone"

select_row reviewer-b
tmux send-keys -t "$SESSION" Enter
wait_for "viewing reviewer-b · review · @[0-9a-f]{7} · esc back to main" 19-opened 10
narrow 20-opened-narrow
tmux send-keys -t "$SESSION" -l "review again, please"
tmux send-keys -t "$SESSION" Enter
wait_for "› review again, please" 21-typed 10
tmux send-keys -t "$SESSION" C-a
wait_for "reviewer-b " 22-dashboard-after-message 10
# The typed message woke the finished reviewer under its anchor: a third cell, and its record is done again.
select_row reviewer-b
wait_for "✓ cell 3 " 23-reviewer-b-ran-again 60
wait_for "✓ +reviewer-b " 24-reviewer-b-done-again 60
tmux send-keys -t "$SESSION" Escape
wait_for "esc back to main · ctrl\+o" 25-viewing-hint 10
sleep 0.5
tmux send-keys -t "$SESSION" Escape
wait_for "esc interrupt · ctrl\+o" 26-back-on-main 10
# reviewer-b's first result came before the sleeper was stopped; a result after the sleeper's is its second run's.
stopped_at=$(grep -n "↩ sleeper · stopped" "$OUT/26-back-on-main.txt" | head -1 | cut -d: -f1)
again_at=$(grep -n "↩ reviewer-b · done" "$OUT/26-back-on-main.txt" | tail -1 | cut -d: -f1)
[[ -n "$stopped_at" && -n "$again_at" && $again_at -gt $stopped_at ]] || fail "main did not get reviewer-b's second result"
echo "checked 26-back-on-main: main got reviewer-b's second result"
tmux send-keys -t "$SESSION" C-d
echo "screens in $OUT"
