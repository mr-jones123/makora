"""The functions a cell calls into makora: Durable's coding tools, one model call, and the conversation's context."""

import asyncio
from typing import Any, Protocol


class Host(Protocol):
    """Sends one `host_request` and returns the `host_reply` value; raises `HostError` for an error reply."""

    async def call(self, method: str, params: dict[str, Any]) -> Any: ...

    def call_sync(self, method: str, params: dict[str, Any]) -> Any: ...


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

    return {
        "read": read,
        "write": write,
        "edit": edit,
        "bash": bash,
        "llm": llm,
        "ctx": Context(host),
    }
