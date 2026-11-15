"""Snapshots of a kernel's namespace: changed variables pickled with dill into content-addressed blobs, and restore."""

import ast
import builtins
import gc
import hashlib
import io
import os
import pickle
import platform
import sys
import types
from typing import Any

import dill

from makora_rlm.protocol import DroppedVar, RestoreFailure, SnapshotManifest, SnapshotVar


class ImportLog:
    """The import statements that bound names in the namespace, so a snapshot replays them instead of pickling modules."""

    def __init__(self) -> None:
        # name -> (statement, the object the statement bound)
        self.bound: dict[str, tuple[str, Any]] = {}

    def record(self, statements: list[tuple[str, str]], namespace: dict[str, Any]) -> None:
        """Note `(name, statement)` pairs of a cell whose names are now bound."""
        for name, statement in statements:
            if name in namespace:
                self.bound.pop(name, None)
                self.bound[name] = (statement, namespace[name])

    def statement_for(self, name: str, value: Any) -> str | None:
        """The statement that bound `name` to `value`, or None when the name now holds something else."""
        entry = self.bound.get(name)
        return entry[0] if entry is not None and entry[1] is value else None


def take(
    namespace: dict[str, Any],
    imports: ImportLog,
    skip: dict[str, Any],
    blob_dir: str,
    previous: SnapshotManifest | None,
    max_variable_bytes: int,
) -> SnapshotManifest:
    """Pickle every public variable of `namespace` except `skip` (by identity) into `blob_dir`; return the manifest."""
    statements: list[str] = []
    values: dict[str, Any] = {}
    for name, value in namespace.items():
        if name.startswith("_") or skip.get(name, _MISSING) is value:
            continue
        statement = imports.statement_for(name, value)
        if statement is None and isinstance(value, types.ModuleType):
            statement = f"import {value.__name__}" if value.__name__ == name else f"import {value.__name__} as {name}"
        if statement is not None:
            statements.append(statement)
            continue
        values[name] = value
    known = {var["blob"] for var in (previous or {}).get("vars", {}).values()}
    saved: dict[str, SnapshotVar] = {}
    dropped: list[DroppedVar] = []
    for group in _groups(values, namespace):
        _save_group(group, values, blob_dir, known, max_variable_bytes, saved, dropped)
    return {
        "python": platform.python_version(),
        "dill": dill.__version__,
        "imports": statements,
        "vars": saved,
        "dropped": dropped,
    }


_MISSING = object()

# Walking a huge object graph to find shared objects costs more than it is worth; past this many visited objects a
# variable is treated as sharing nothing further.
_WALK_LIMIT = 2_000_000


def _groups(values: dict[str, Any], namespace: dict[str, Any]) -> list[list[str]]:
    """Partition variable names so names reaching a common mutable object share a group (`a = b = []` is one group)."""
    parent = {name: name for name in values}

    def find(name: str) -> str:
        while parent[name] != name:
            parent[name] = parent[parent[name]]
            name = parent[name]
        return name

    # Objects every function reaches; sharing them means nothing.
    barrier = {id(namespace), id(builtins.__dict__), id(sys.modules)}
    owner: dict[int, str] = {}
    visited = 0
    for name, value in values.items():
        stack = [value]
        seen: set[int] = set()
        while stack and visited < _WALK_LIMIT:
            obj = stack.pop()
            key = id(obj)
            if key in seen or key in barrier or isinstance(obj, (type, types.ModuleType)):
                continue
            seen.add(key)
            visited += 1
            first = owner.setdefault(key, name)
            if first != name:
                parent[find(name)] = find(first)
                continue
            stack.extend(filter(gc.is_tracked, gc.get_referents(obj)))
    groups: dict[str, list[str]] = {}
    for name in values:
        groups.setdefault(find(name), []).append(name)
    return [sorted(group) for group in groups.values()]


def _save_group(
    group: list[str],
    values: dict[str, Any],
    blob_dir: str,
    known: set[str],
    max_variable_bytes: int,
    saved: dict[str, SnapshotVar],
    dropped: list[DroppedVar],
) -> None:
    data = _pickle({name: values[name] for name in group})
    if data is None:
        # Find the members that cannot be pickled; the rest still form one blob.
        picklable = [name for name in group if _pickle({name: values[name]}) is not None]
        for name in group:
            if name not in picklable:
                dropped.append({"name": name, "type": type_name(values[name]), "reason": "unpicklable"})
        if not picklable:
            return
        group = picklable
        data = _pickle({name: values[name] for name in group})
        if data is None:
            for name in group:
                dropped.append({"name": name, "type": type_name(values[name]), "reason": "unpicklable"})
            return
    if len(data) > max_variable_bytes:
        for name in group:
            dropped.append({"name": name, "type": type_name(values[name]), "reason": "over_cap", "bytes": len(data)})
        return
    blob = f"sha256:{hashlib.sha256(data).hexdigest()}"
    if blob not in known:
        _write_blob(blob_dir, blob, data)
    entry: SnapshotVar = {"blob": blob, "bytes": len(data), "type": type_name(values[group[0]])}
    if len(group) > 1:
        entry["group"] = group[1:]
    saved[group[0]] = entry


def _pickle(payload: dict[str, Any]) -> bytes | None:
    # dill's pickler is pure Python, about 60x slower than the C one on plain data (0.35 s against 5 ms for a list of
    # 1e6 ints). Both write the same bytes for plain data, so a value keeps its blob whichever pickler wrote it.
    buffer = io.BytesIO()
    try:
        _CPickler(buffer, protocol=5).dump(payload)
        return buffer.getvalue()
    except Exception:
        pass
    try:
        return dill.dumps(payload, protocol=5)
    except Exception:
        return None


class _NeedsDill(Exception):
    pass


class _CPickler(pickle.Pickler):
    """The C pickler, refusing what the namespace itself defines: pickle would save it by name, dill saves it by value."""

    def reducer_override(self, obj: Any) -> Any:
        if isinstance(obj, (type, types.FunctionType)) and obj.__module__ == "__main__":
            raise _NeedsDill
        return NotImplemented


def blob_path(blob_dir: str, blob: str) -> str:
    """Where blob `sha256:<hex>` lives: `<blob_dir>/sha256/<first two hex>/<rest>`."""
    digest = blob.removeprefix("sha256:")
    return os.path.join(blob_dir, "sha256", digest[:2], digest[2:])


def _write_blob(blob_dir: str, blob: str, data: bytes) -> None:
    path = blob_path(blob_dir, blob)
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "wb") as file:
        file.write(data)
    os.replace(temporary, path)


def type_name(value: Any) -> str:
    """A short type label: `int`, `list[str]`, `sqlite3.Connection`."""
    kind = type(value)
    name = kind.__qualname__ if kind.__module__ in ("builtins", "__main__") else f"{kind.__module__}.{kind.__qualname__}"
    if isinstance(value, (list, set, frozenset, tuple)) and value:
        first = next(iter(value))
        return f"{name}[{type(first).__qualname__}]"
    return name


def restore(
    namespace: dict[str, Any], imports: ImportLog, blob_dir: str, manifest: SnapshotManifest
) -> tuple[list[str], list[RestoreFailure]]:
    """Replay the manifest's imports, then load each blob into `namespace`; failures are reported per variable."""
    restored: list[str] = []
    failed: list[RestoreFailure] = []
    for statement in manifest["imports"]:
        bound = _bound_names(statement)
        try:
            exec(statement, namespace)
        except Exception as error:
            failed.extend({"name": name, "reason": f"{type(error).__name__}: {error}"} for name in bound)
            continue
        imports.record([(name, statement) for name in bound], namespace)
    same_python = manifest["python"].rsplit(".", 1)[0] == platform.python_version().rsplit(".", 1)[0]
    for name, var in manifest["vars"].items():
        names = [name, *var.get("group", [])]
        reason = None if same_python or var["type"] not in _BYTECODE_TYPES else f"bytecode of Python {manifest['python']}"
        values: dict[str, Any] = {}
        if reason is None:
            values, reason = _load(blob_dir, var["blob"])
        if reason is not None:
            failed.extend({"name": each, "reason": reason} for each in names)
            continue
        namespace.update(values)
        restored.extend(names)
    return restored, failed


_BYTECODE_TYPES = {"function", "type", "builtin_function_or_method", "method"}


def _load(blob_dir: str, blob: str) -> tuple[dict[str, Any], str | None]:
    try:
        with open(blob_path(blob_dir, blob), "rb") as file:
            data = file.read()
    except FileNotFoundError:
        return {}, "blob missing (pruned or never written)"
    if f"sha256:{hashlib.sha256(data).hexdigest()}" != blob:
        return {}, "blob corrupt (hash mismatch)"
    try:
        return dill.loads(data), None
    except Exception as error:
        return {}, f"{type(error).__name__}: {error}"


def _bound_names(statement: str) -> list[str]:
    node = ast.parse(statement).body[0]
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return [bound_name(alias, isinstance(node, ast.Import)) for alias in node.names]
    return []


def bound_name(alias: ast.alias, plain_import: bool) -> str:
    """The name an import alias binds: `import a.b` binds `a`, `import a.b as c` binds `c`."""
    if alias.asname is not None:
        return alias.asname
    return alias.name.split(".")[0] if plain_import else alias.name
