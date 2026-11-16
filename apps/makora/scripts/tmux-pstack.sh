#!/usr/bin/env bash
# Drives makora's /pstack picker in tmux (fake model, a temp repository and home), once at 140x40 and once at 90x40:
# open /pstack, change the judge tier to faux/faux-2, cycle bug-fix to judge, add a seat to arena runners, change the
# budget to unlimited, save with Esc, reopen and see the saved values, and check that settings.json holds them. The
# 90-column run then shrinks the window to 20 rows to show the list scrolling, and opens the picker through
# /skill:setup-pstack. Screens go to /tmp/makora-pstack/<width>x40/ as text and ANSI. Exits non-zero, with the screen
# it saw, when a wait times out or a check fails.
#
#   apps/makora/scripts/tmux-pstack.sh
set -euo pipefail

OUT=/tmp/makora-pstack
APP=$(cd "$(dirname "$0")/.." && pwd)

rm -rf "$OUT"/140x40 "$OUT"/90x40
mkdir -p "$OUT"

run() {
	local width=$1
	local out="$OUT/${width}x40"
	local work
	work=$(mktemp -d "${TMPDIR:-/tmp}/makora-pstack-run.XXXXXX")
	local session="makora-pstack-$width-$$"
	mkdir -p "$out" "$work/home" "$work/repo"
	printf '# demo\n' >"$work/repo/README.md"
	git -C "$work/repo" init -q -b main
	git -C "$work/repo" add README.md
	git -C "$work/repo" -c user.name=demo -c user.email=demo@localhost commit -qm init

	tmux new-session -d -s "$session" -x "$width" -y 40 -c "$work/repo" \
		"MAKORA_HOME='$work/home' node '$APP/bin/makora.mjs' --fake; sleep 30"
	trap 'tmux kill-session -t "'"$session"'" 2>/dev/null || true' EXIT

	screen() { tmux capture-pane -t "$session" -p; }
	fail() {
		screen >"$out/failed.txt"
		echo "${width}x40: $1; screen in $out/failed.txt" >&2
		exit 1
	}
	capture() {
		screen >"$out/$1.txt"
		tmux capture-pane -t "$session" -p -e >"$out/$1.ansi"
		echo "${width}x40: captured $1"
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
	keys() { tmux send-keys -t "$session" "$@"; }
	# A key right after Esc would arrive as Alt+key, so Esc gets a pause of its own.
	escape() {
		keys Escape
		sleep 0.4
	}
	# Type a slash command; the first Enter may only accept the autocomplete entry.
	slash() {
		keys "$1"
		sleep 0.3
		keys Enter
		sleep 0.5
		screen | grep -q "pstack models" || keys Enter
	}

	wait_for "ctrl\+a agents" 01-startup 30
	slash "/pstack"
	wait_for "pstack models.*budget: large \(xhigh\)" 02-picker
	keys Down Enter
	wait_for "judge model" 03-judge-models
	keys "faux-2"
	sleep 0.3
	keys Enter
	wait_for "judge thinking level" 04-judge-thinking
	keys "medium"
	sleep 0.3
	keys Enter
	wait_for "judge +faux/faux-2 +thinking medium" 05-judge-set
	keys Down Down Enter
	wait_for "bug-fix +judge" 06-role-cycled
	for _ in $(seq 11); do keys Down; done
	keys Enter a Enter
	wait_for "arena runners +judge \+ code \+ \[judge\]" 07-panel-seat-added
	escape
	keys b
	wait_for "Budget: the thinking level" 08-budget-dialog
	keys "unlimited"
	sleep 0.3
	keys Enter
	wait_for "budget: unlimited \(max\)" 09-budget-unlimited
	screen | grep -Eq "thinking high · clamped from max" || fail "the judge tier shows its clamp"
	escape
	wait_for "pstack saved: code session model, judge faux/faux-2 \(high\), budget unlimited" 10-saved
	slash "/pstack"
	wait_for "pstack models.*budget: unlimited \(max\)" 11-reopened
	for pattern in "judge +faux/faux-2 +thinking high · clamped from max" "bug-fix +judge" \
		"arena runners +judge \+ code \+ judge"; do
		screen | grep -Eq -- "$pattern" || fail "the reopened picker shows /$pattern/"
	done
	escape
	wait_for "pstack: nothing changed" 12-closed-unchanged

	local settings="$work/home/settings.json"
	cp "$settings" "$out/settings.json"
	node -e '
		const { pstack } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
		const want = {
			budget: "unlimited",
			models: { judge: { model: "faux/faux-2", thinking: "high" } },
			roles: { "bug-fix": "judge", "arena runners": ["judge", "code", "judge"] },
		};
		if (JSON.stringify(pstack) !== JSON.stringify(want)) {
			console.error(`settings.json pstack is ${JSON.stringify(pstack)}`);
			process.exit(1);
		}
	' "$settings" || fail "settings.json holds the saved choices"
	echo "${width}x40: settings.json holds the saved choices"

	if [[ $width == 90 ]]; then
		tmux resize-window -t "$session" -y 20
		slash "/skill:setup-pstack"
		wait_for "pstack models" 13-short-setup-pstack
		for _ in $(seq 18); do keys Down; done
		wait_for "↑ [0-9]+ more" 14-short-scrolled-down
		screen | grep -Eq "▌ +interrogate reviewers" || fail "the last role is selected and on screen"
		escape
		wait_for "pstack: nothing changed" 15-short-closed
	fi
	keys C-d
	tmux kill-session -t "$session" 2>/dev/null || true
	trap - EXIT
}

run 140
run 90
echo "screens in $OUT"
