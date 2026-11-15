"""The makora kernel (`python -m makora_rlm.kernel`): one persistent namespace driven by NDJSON on stdin and stdout.

The protocol owns the process's original stdin and stdout. User code gets /dev/null as stdin, and its stdout and
stderr, at the Python and the file descriptor level, become `stream` messages of the running cell.
"""

import ast
import asyncio
import builtins
import codecs
import concurrent.futures
import faulthandler
import fcntl
import inspect
import io
import itertools
import json
import linecache
import os
import platform
import resource
import signal
import sys
import termios
import threading
import time
import traceback
import types
from typing import Any, BinaryIO

import dill

from makora_rlm import helpers, snapshot
from makora_rlm.protocol import CellError, ExecuteRequest, ExecuteResult, RestoreRequest, SnapshotRequest, PROTOCOL_VERSION

# Top-level `await` in a cell.
COMPILE_FLAGS = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT

# A value's repr past this many characters is cut; the host bounds what the model sees further.
MAX_VALUE_CHARS = 100_000

FLUSH_SECONDS = 0.05

def main() -> None:
    """Take over the process's standard streams and serve requests until stdin closes or `shutdown` arrives."""
    protocol_in = os.fdopen(os.dup(0), "rb", buffering=0)
    wire = Wire(os.dup(1))
    # A native crash still reaches makora through the original stderr.
    faulthandler.enable(file=os.fdopen(os.dup(2), "w"))
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.close(null)
    output = Output(wire)
    capture = [Capture(fd, name, output) for fd, name in ((1, "stdout"), (2, "stderr"))]
    sys.stdin = open(os.devnull)
    sys.stdout = TextStream(output, "stdout", 1)
    sys.stderr = TextStream(output, "stderr", 2)
    module = types.ModuleType("__main__")
    module.__dict__["__builtins__"] = builtins
    sys.modules["__main__"] = module
    kernel = Kernel(module.__dict__, wire, output, capture)
    # Installed before asyncio.run, so asyncio leaves SIGINT to the kernel.
    signal.signal(signal.SIGINT, kernel.on_sigint)
    threading.Thread(target=output.run_flusher, daemon=True).start()
    # makora starts the kernel with `-P`, so the project's modules could not shadow the imports above; cells import
    # them as `python -m` in the project would.
    sys.path.insert(0, os.getcwd())
    asyncio.run(kernel.serve(protocol_in))


class Wire:
    """Protocol output: one JSON object per line on the original stdout, from any thread."""

    def __init__(self, fd: int):
        self._file = os.fdopen(fd, "wb", buffering=0)
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, ensure_ascii=False, default=repr).encode("utf-8", "surrogatepass") + b"\n"
        with self._lock:
            self._file.write(line)


class Output:
    """Cell output on its way to the host: chunks batched into `stream` messages every 50 ms and before replies."""

    def __init__(self, wire: Wire):
        self._wire = wire
        self._lock = threading.Lock()
        self._chunks: list[list[str]] = []
        self.cell = ""

    def add(self, stream: str, text: str) -> None:
        with self._lock:
            if self._chunks and self._chunks[-1][0] == stream:
                self._chunks[-1][1] += text
            else:
                self._chunks.append([stream, text])

    def flush(self) -> None:
        # Held while sending: a flusher that took chunks must send them before a reply's flush returns, or the reply
        # overtakes them and makora drops output that arrives after the cell's result.
        with self._lock:
            chunks, self._chunks = self._chunks, []
            for stream, text in chunks:
                self._wire.send({"type": "stream", "id": self.cell, "stream": stream, "text": text})

    def run_flusher(self) -> None:
        while True:
            time.sleep(FLUSH_SECONDS)
            self.flush()


class Capture:
    """Redirects file descriptor `fd` into a pipe whose bytes become `name` output, for subprocesses and C code."""

    def __init__(self, fd: int, name: str, output: Output):
        read_end, write_end = os.pipe()
        os.dup2(write_end, fd)
        os.close(write_end)
        self._fd = read_end
        self._name = name
        self._output = output
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while data := os.read(self._fd, 65536):
            self._output.add(self._name, decoder.decode(data))

    def drain(self, deadline: float) -> None:
        """Wait, until `deadline`, for bytes written before now to be read."""
        pending = bytearray(4)
        while time.monotonic() < deadline:
            fcntl.ioctl(self._fd, termios.FIONREAD, pending)
            if int.from_bytes(pending, sys.byteorder) == 0:
                return
            time.sleep(0.005)


class TextStream(io.TextIOBase):
    """`sys.stdout` and `sys.stderr` of user code."""

    def __init__(self, output: Output, name: str, fd: int):
        self._output = output
        self._name = name
        self._fd = fd

    @property
    def encoding(self) -> str:
        return "utf-8"

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        self._output.add(self._name, text)
        return len(text)

    def fileno(self) -> int:
        return self._fd

    def isatty(self) -> bool:
        return False


class Cell:
    """The cell being executed."""

    def __init__(self, cell_id: str):
        self.id = cell_id
        self.task: asyncio.Task[None] | None = None
        self.timed_out = False


class Kernel:
    """One namespace, the cell running in it, and the host requests its helpers have in flight."""

    def __init__(self, namespace: dict[str, Any], wire: Wire, output: Output, capture: list[Capture]):
        self.namespace = namespace
        self.wire = wire
        self.output = output
        self.capture = capture
        self.imports = snapshot.ImportLog()
        self.helpers = helpers.build(self)
        namespace.update(self.helpers)
        self.pending: dict[str, concurrent.futures.Future[Any]] = {}
        self.request_ids = itertools.count(1)
        self.cell: Cell | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

    async def serve(self, stdin: BinaryIO) -> None:
        self.loop = asyncio.get_running_loop()
        inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        threading.Thread(target=self._read, args=(stdin, inbox), daemon=True).start()
        self.wire.send(
            {
                "type": "ready",
                "protocol": PROTOCOL_VERSION,
                "pid": os.getpid(),
                "python": platform.python_version(),
                "dill": dill.__version__,
            }
        )
        while True:
            message = await inbox.get()
            match message["type"]:
                case "execute":
                    cell = Cell(message["id"])
                    self.cell = cell
                    self.output.cell = cell.id
                    cell.task = asyncio.create_task(self._execute(message, cell))
                case "snapshot":
                    self._snapshot(message)
                case "restore":
                    self._restore(message)

    # Runs on the reader thread, so replies and interrupts reach a cell blocked in synchronous code.
    def _read(self, stdin: BinaryIO, inbox: "asyncio.Queue[dict[str, Any]]") -> None:
        assert self.loop is not None
        for line in stdin:
            message = json.loads(line)
            match message["type"]:
                case "host_reply":
                    self._reply(message)
                case "interrupt":
                    if self.cell is not None and self.cell.id == message["id"]:
                        os.kill(os.getpid(), signal.SIGINT)
                case "shutdown":
                    try:
                        self.output.flush()
                    finally:
                        _end_process_group()
                case _:
                    self.loop.call_soon_threadsafe(inbox.put_nowait, message)
        # makora went away: a kernel never outlives its host.
        _end_process_group()

    def on_sigint(self, _signum: int, _frame: Any) -> None:
        """Interrupt the cell: raise in it when its code runs right now, else cancel it where it awaits."""
        cell = self.cell
        if cell is None or cell.task is None or self.loop is None:
            return
        if asyncio.current_task(self.loop) is cell.task:
            raise KeyboardInterrupt
        self.loop.call_soon_threadsafe(cell.task.cancel)

    async def call(self, method: str, params: dict[str, Any]) -> Any:
        """Send a host request and await its reply (the helpers' `Host`)."""
        return await asyncio.wrap_future(self._request(method, params))

    def call_sync(self, method: str, params: dict[str, Any]) -> Any:
        """Send a host request and block until its reply."""
        return self._request(method, params).result()

    def _request(self, method: str, params: dict[str, Any]) -> "concurrent.futures.Future[Any]":
        request_id = f"h{next(self.request_ids)}"
        future: concurrent.futures.Future[Any] = concurrent.futures.Future()
        self.pending[request_id] = future
        self.output.flush()
        cell_id = self.cell.id if self.cell is not None else ""
        self.wire.send(
            {"type": "host_request", "requestId": request_id, "cellId": cell_id, "method": method, "params": params}
        )
        return future

    def _reply(self, message: dict[str, Any]) -> None:
        future = self.pending.pop(message["requestId"], None)
        # An interrupted cell cancelled its wait; the late reply has no reader.
        if future is None or future.cancelled():
            return
        if message["ok"]:
            future.set_result(message.get("value"))
        else:
            future.set_exception(helpers.HostError(message["error"]))

    async def _execute(self, request: ExecuteRequest, cell: Cell) -> None:
        started = time.monotonic()
        timer = threading.Timer(request["timeoutMs"] / 1000, self._time_out, (cell,))
        timer.daemon = True
        timer.start()
        result: ExecuteResult = {
            "type": "result",
            "id": cell.id,
            "status": "ok",
            "durationMs": 0,
            "maxRssBytes": 0,
        }
        try:
            value = await self._run(request["code"], cell.id)
            if value is not None:
                result["value"] = value
        except (KeyboardInterrupt, asyncio.CancelledError) as error:
            result["status"] = "interrupted"
            message = f"timed out after {request['timeoutMs'] / 1000:g}s" if cell.timed_out else "interrupted"
            result["error"] = _cell_error(error, "KeyboardInterrupt", message)
        except BaseException as error:  # SystemExit too: the cell ends, the kernel stays.
            result["status"] = "error"
            result["error"] = _cell_error(error, type(error).__name__, str(error))
        finally:
            timer.cancel()
        self.cell = None
        deadline = time.monotonic() + 0.2
        for capture in self.capture:
            capture.drain(deadline)
        self.output.flush()
        result["durationMs"] = int((time.monotonic() - started) * 1000)
        result["maxRssBytes"] = _max_rss_bytes()
        self.wire.send(result)

    def _time_out(self, cell: Cell) -> None:
        if self.cell is cell:
            cell.timed_out = True
            os.kill(os.getpid(), signal.SIGINT)

    async def _run(self, code: str, cell_id: str) -> str | None:
        filename = f"<{cell_id}>"
        linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
        tree = ast.parse(code, filename)
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        try:
            await self._eval(compile(tree, filename, "exec", flags=COMPILE_FLAGS))
            if last is None:
                return None
            value = await self._eval(compile(ast.Expression(last.value), filename, "eval", flags=COMPILE_FLAGS))
        finally:
            self.imports.record(_import_statements(tree), self.namespace)
        if value is None:
            return None
        text = repr(value)
        return text if len(text) <= MAX_VALUE_CHARS else f"{text[:MAX_VALUE_CHARS]}... [{len(text)} chars]"

    async def _eval(self, code: types.CodeType) -> Any:
        result = eval(code, self.namespace)
        if code.co_flags & inspect.CO_COROUTINE:
            result = await result
        return result

    # A failing snapshot or restore (disk full, a corrupt namespace) ends the process: makora then reports the kernel
    # dead, and the protocol has no partial snapshot to describe.
    def _snapshot(self, request: SnapshotRequest) -> None:
        manifest = snapshot.take(
            self.namespace,
            self.imports,
            self.helpers,
            request["blobDir"],
            request.get("previous"),
            request["maxVariableBytes"],
        )
        self.wire.send({"type": "snapshot_result", "id": request["id"], "manifest": manifest})

    def _restore(self, request: RestoreRequest) -> None:
        restored, failed = snapshot.restore(self.namespace, self.imports, request["blobDir"], request["manifest"])
        self.wire.send({"type": "restore_result", "id": request["id"], "restored": restored, "failed": failed})


def _import_statements(tree: ast.Module) -> list[tuple[str, str]]:
    """`(bound name, statement)` for each name a top-level import of the cell binds."""
    pairs: list[tuple[str, str]] = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                pairs.append((snapshot.bound_name(alias, True), ast.unparse(ast.Import(names=[alias]))))
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module is not None:
            for alias in node.names:
                if alias.name != "*":
                    statement = ast.unparse(ast.ImportFrom(module=node.module, names=[alias], level=0))
                    pairs.append((snapshot.bound_name(alias, False), statement))
    return pairs


def _cell_error(error: BaseException, name: str, message: str) -> CellError:
    if isinstance(error, SyntaxError):
        text = "".join(traceback.format_exception_only(error))
    else:
        # The kernel's own frames (the cell runner, the SIGINT handler) are noise around the user's.
        report = traceback.TracebackException.from_exception(error)
        report.stack = traceback.StackSummary.from_list([frame for frame in report.stack if frame.filename != __file__])
        text = "".join(report.format())
    return {"name": name, "message": message, "traceback": text}


def _max_rss_bytes() -> int:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS reports bytes, Linux kilobytes.
    return peak if sys.platform == "darwin" else peak * 1024


def _end_process_group() -> None:
    """Exit, killing every process the cells started: makora spawns the kernel as the leader of its own group."""
    # A kernel started by hand shares its terminal's group, which it must not kill.
    if os.getpgrp() == os.getpid():
        os.killpg(0, signal.SIGKILL)
    os._exit(0)


if __name__ == "__main__":
    # Run as the imported module, so the user's `__main__` is a fresh namespace and the kernel's code is not in it.
    from makora_rlm.kernel import main as run

    run()
