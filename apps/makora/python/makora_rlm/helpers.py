"""The functions a cell calls into makora: Durable's coding tools, one model call, the conversation's context, its
subagents, and the session quiz."""

# `Agents.list` shadows the builtin inside its class body; postponed annotations keep `list[...]` meaning the builtin.
from __future__ import annotations

import asyncio
from typing import Any, Protocol

from makora_rlm.protocol import HostMethod


class Host(Protocol):
    """Sends one `host_request` and returns the `host_reply` value; raises `HostError` for an error reply."""

    async def call(self, method: HostMethod, params: dict[str, Any]) -> Any: ...

    def call_sync(self, method: HostMethod, params: dict[str, Any]) -> Any: ...


class HostError(Exception):
    """A host request makora answered with an error, such as a failed tool call."""


class BashResult:
    """What `await bash(...)` returns: the combined output tail and the exit code."""

    def __init__(self, output: str, exit_code: int, truncated: bool = False, full_output_path: str | None = None):
        self.output = output
        self.exit_code = exit_code
        self.truncated = truncated
        self.full_output_path = full_output_path

    def __str__(self) -> str:
        return self.output if self.exit_code == 0 else f"{self.output.rstrip()}\n[exit code {self.exit_code}]"

    def __repr__(self) -> str:
        preview = self.output if len(self.output) <= 200 else f"{self.output[:200]}..."
        return f"BashResult(exit_code={self.exit_code}, output={preview!r})"


class Context:
    """`ctx` in a cell: the conversation the cell runs in."""

    def __init__(self, host: Host):
        self._host = host

    def input(self) -> str:
        """The latest user message's text."""
        return self._host.call_sync("ctx", {"what": "input"})

    async def transcript(self, limit: int = 20) -> list[dict[str, Any]]:
        """The newest `limit` transcript entries, oldest first, as dicts."""
        return await self._host.call("ctx", {"what": "transcript", "limit": limit})

    def __repr__(self) -> str:
        return "<makora ctx: ctx.input(), await ctx.transcript(limit=20)>"


class Agents:
    """`agents` in a cell: this conversation's subagents."""

    def __init__(self, host: Host):
        self._host = host

    async def list(self) -> list[dict[str, Any]]:
        """Every child of this conversation, as records."""
        return await _agents(self._host, "list", {})

    async def get(self, name: str) -> dict[str, Any]:
        """The child `name`'s record: mode, worktree, budget, state and result."""
        return await _agents(self._host, "get", {"name": name})

    async def recent(self, name: str, limit: int = 6) -> list[dict[str, Any]]:
        """The newest `limit` messages of the child `name`'s transcript, oldest first, each cut to 800 characters."""
        return await _agents(self._host, "recent", {"name": name, "limit": limit})

    def __repr__(self) -> str:
        return "<makora agents: await agents.list(), agents.get(name), agents.recent(name, limit=6)>"


class Quiz:
    """`quiz` in a cell: hands a session-quiz question bank to makora."""

    def __init__(self, host: Host):
        self._host = host

    async def publish(self, bank: dict[str, Any]) -> dict[str, Any]:
        """Check `bank` against the git range it names, render the quiz page into makora's home and open it in the
        browser; returns `{path, range, commits, opened}`. Raises `HostError` listing every problem with the bank."""
        return await self._host.call("quiz", {"bank": bank})

    def __repr__(self) -> str:
        return "<makora quiz: await quiz.publish(bank)>"


async def _agents(host: Host, action: str, args: dict[str, Any]) -> Any:
    return await host.call("agents", {"action": action, "args": _defined(args)})


def _defined(value: Any) -> Any:
    """`value` without the `None` entries of its dicts, at any depth: an omitted argument takes its default."""
    if isinstance(value, dict):
        return {key: _defined(item) for key, item in value.items() if item is not None}
    return value


def build(host: Host) -> dict[str, Any]:
    """The helpers injected into a kernel's namespace, by name."""

    async def tool(name: str, args: dict[str, Any]) -> Any:
        return await host.call("tool", {"name": name, "args": {k: v for k, v in args.items() if v is not None}})

    async def read(path: str, offset: int | None = None, limit: int | None = None) -> str:
        """Read a file through Durable's `read` tool: all of it, or with `offset` (first line, 1-based) or `limit`
        (line count) one page, which Durable may cut at its line and byte limits."""
        return await tool("read", {"path": path, "offset": offset, "limit": limit})

    async def write(path: str, content: str) -> str:
        """Write a file through Durable's `write` tool."""
        return await tool("write", {"path": path, "content": content})

    async def edit(path: str, edits: list[dict[str, str]] | str, new: str | None = None) -> str:
        """Edit a file: `edit(path, [{"oldText": ..., "newText": ...}])`, or `edit(path, old, new)`."""
        if isinstance(edits, str):
            if new is None:
                raise TypeError("edit(path, old, new) needs the new text")
            edits = [{"oldText": edits, "newText": new}]
        return await tool("edit", {"path": path, "edits": edits})

    async def bash(command: str, timeout: float | None = None) -> BashResult:
        """Run a shell command through Durable's `bash` tool; `timeout` in seconds."""
        result = await tool("bash", {"command": command, "timeout": timeout})
        return BashResult(
            result.get("output", ""),
            int(result.get("exitCode", 0)),
            bool(result.get("truncated", False)),
            result.get("fullOutputPath"),
        )

    async def llm(prompt: str, schema: Any = None, model: str | None = None, timeout: float = 300) -> Any:
        """One model call; with a JSON Schema (or a pydantic model class) returns the checked JSON value, else text."""
        if schema is not None and hasattr(schema, "model_json_schema"):
            schema = schema.model_json_schema()
        params: dict[str, Any] = {"prompt": prompt}
        if schema is not None:
            params["schema"] = schema
        if model is not None:
            params["model"] = model
        result = await asyncio.wait_for(host.call("llm", params), timeout)
        return result["json"] if schema is not None else result["text"]

    async def spawn(
        name: str,
        task: str,
        mode: str = "write",
        ref: str | None = None,
        base: str | None = None,
        model: str | None = None,
        budget: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Start a subagent in its own worktree and REPL and return its record at once; an existing name returns that
        child. `mode="review"` checks out `ref` detached; `mode="write"` works on a new branch from `base`. `budget`
        takes `usd`, `minutes` and `turns`."""
        args = {"name": name, "task": task, "mode": mode, "ref": ref, "base": base, "model": model, "budget": budget}
        return await _agents(host, "spawn", args)

    async def collect(names: list[str] | str, timeout: float | None = None) -> dict[str, dict[str, Any]]:
        """Wait inside the cell until every named child finished (or `timeout` seconds passed); their records by name."""
        return await _agents(host, "collect", {"names": [names] if isinstance(names, str) else names, "timeout": timeout})

    async def send(to: str, message: str) -> Any:
        """Message a child, a sibling, `"parent"`, or `"all"` of them; a receipt, or one per member for `"all"`."""
        return await _agents(host, "send", {"to": to, "message": message})

    async def merge(name: str) -> dict[str, Any]:
        """Merge a finished write child's branch into this conversation's tree: `{merged, commit}`, or `{conflicts}`
        with the tree left clean."""
        return await _agents(host, "merge", {"name": name})

    async def stop(name: str) -> dict[str, Any]:
        """Stop the child's work; it keeps its transcript and worktree until removed."""
        return await _agents(host, "stop", {"name": name})

    async def remove(name: str) -> dict[str, Any]:
        """Stop the child and its children, and delete their worktrees (an unmerged write branch is kept)."""
        return await _agents(host, "remove", {"name": name})

    return {
        "spawn": spawn,
        "collect": collect,
        "send": send,
        "merge": merge,
        "stop": stop,
        "remove": remove,
        "agents": Agents(host),
        "read": read,
        "write": write,
        "edit": edit,
        "bash": bash,
        "llm": llm,
        "ctx": Context(host),
        "quiz": Quiz(host),
    }
