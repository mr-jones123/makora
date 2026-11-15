"""The wire protocol between makora and a kernel; mirrors apps/makora/src/kernel/protocol.ts, change both together."""

from typing import Literal, NotRequired, TypedDict

PROTOCOL_VERSION = 1


class SnapshotVar(TypedDict):
    blob: str
    bytes: int
    type: str
    group: NotRequired[list[str]]


class DroppedVar(TypedDict):
    name: str
    type: str
    reason: Literal["unpicklable", "over_cap"]
    bytes: NotRequired[int]


class SnapshotManifest(TypedDict):
    python: str
    dill: str
    imports: list[str]
    vars: dict[str, SnapshotVar]
    dropped: list[DroppedVar]


class ExecuteRequest(TypedDict):
    type: Literal["execute"]
    id: str
    code: str
    timeoutMs: int


class SnapshotRequest(TypedDict):
    type: Literal["snapshot"]
    id: str
    blobDir: str
    previous: NotRequired[SnapshotManifest | None]
    maxVariableBytes: int


class RestoreRequest(TypedDict):
    type: Literal["restore"]
    id: str
    blobDir: str
    manifest: SnapshotManifest


class CellError(TypedDict):
    name: str
    message: str
    traceback: str


class ExecuteResult(TypedDict):
    type: Literal["result"]
    id: str
    status: Literal["ok", "error", "interrupted"]
    value: NotRequired[str]
    error: NotRequired[CellError]
    durationMs: int
    maxRssBytes: int


class RestoreFailure(TypedDict):
    name: str
    reason: str
