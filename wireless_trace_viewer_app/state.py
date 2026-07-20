from __future__ import annotations

import json
import shutil
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from .config import (
    CACHE_ROOT,
    SESSION_IDLE_TTL_SECONDS,
    TASK_DONE_TTL_SECONDS,
    TASK_MAX_ITEMS,
    TASK_STATE_ROOT,
)


@dataclass
class SessionState:
    session_id: str
    root: Path
    manifest: dict[str, Any]
    lock: threading.RLock = field(default_factory=threading.RLock)
    db_lock: threading.RLock = field(default_factory=threading.RLock)

    @property
    def directory(self) -> Path:
        return CACHE_ROOT / self.session_id

    @property
    def database_path(self) -> Path:
        return self.directory / "analysis.duckdb"

    @property
    def manifest_path(self) -> Path:
        return self.directory / "manifest.json"

    def source_database_path(self, source_key: str) -> Path:
        return self.directory / "sources" / f"{source_key}.duckdb"

    def touch(self) -> None:
        with self.lock:
            self.manifest["last_seen"] = time.time()
            self.save()

    def save(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        temp_path = self.manifest_path.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps(self.manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(self.manifest_path)

    def update(self, **kwargs: Any) -> None:
        with self.lock:
            self.manifest.update(kwargs)
            self.manifest["updated_at"] = time.time()
            self.save()

    def update_source(self, key: str, **kwargs: Any) -> None:
        with self.lock:
            sources = self.manifest.setdefault("sources", {})
            source = sources.setdefault(key, {})
            source.update(kwargs)
            self.manifest["updated_at"] = time.time()
            self.save()

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return json.loads(json.dumps(self.manifest, ensure_ascii=False))


class SessionManager:
    def __init__(self) -> None:
        CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, SessionState] = {}
        self._lock = threading.RLock()

    def create(
        self,
        root: Path,
        catalog: dict[str, Any],
        roots: Optional[dict[str, Path | None]] = None,
    ) -> SessionState:
        session_id = uuid.uuid4().hex
        now = time.time()
        manifest = {
            "session_id": session_id,
            "root": str(root),
            "roots": {
                side: (str(path) if path is not None else None)
                for side, path in (roots or {}).items()
            },
            "created_at": now,
            "updated_at": now,
            "last_seen": now,
            "phase": "scanned",
            "catalog": catalog,
            "selection": {"A": None, "B": None},
            "sources": {},
            "merge": {},
        }
        state = SessionState(session_id=session_id, root=root, manifest=manifest)
        (state.directory / "sources").mkdir(parents=True, exist_ok=True)
        state.save()
        with self._lock:
            self._sessions[session_id] = state
        return state

    def get(self, session_id: str, touch: bool = True) -> SessionState:
        if not session_id:
            raise KeyError("分析会话为空。")
        with self._lock:
            state = self._sessions.get(session_id)
        if state is None:
            with self._lock:
                state = self._sessions.get(session_id)
                if state is None:
                    directory = CACHE_ROOT / session_id
                    manifest_path = directory / "manifest.json"
                    if not manifest_path.is_file():
                        raise KeyError("分析会话不存在或已过期，请重新扫描。")
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    state = SessionState(
                        session_id=session_id,
                        root=Path(manifest.get("root") or "."),
                        manifest=manifest,
                    )
                    self._sessions[session_id] = state
        if touch:
            state.touch()
        return state

    def clear(self, session_id: str) -> bool:
        with self._lock:
            state = self._sessions.pop(session_id, None)
        directory = state.directory if state else CACHE_ROOT / session_id
        try:
            resolved_root = CACHE_ROOT.resolve()
            resolved = directory.resolve()
            if not resolved.is_relative_to(resolved_root) or resolved == resolved_root:
                raise RuntimeError(f"拒绝清理非会话缓存路径：{resolved}")
            if resolved.exists():
                shutil.rmtree(resolved)
                return True
        except FileNotFoundError:
            return False
        return False

    def list_snapshots(self) -> list[dict[str, Any]]:
        with self._lock:
            states = list(self._sessions.values())
        return [state.snapshot() for state in states]

    def prune(self) -> int:
        now = time.time()
        removed = 0
        candidates: list[str] = []
        with self._lock:
            for session_id, state in self._sessions.items():
                snapshot = state.snapshot()
                if now - float(snapshot.get("last_seen", now)) > SESSION_IDLE_TTL_SECONDS:
                    candidates.append(session_id)
        for session_id in candidates:
            if self.clear(session_id):
                removed += 1
        return removed


class TaskCancelled(RuntimeError):
    pass


class TaskManager:
    TERMINAL_STATUSES = {"done", "error", "cancelled", "interrupted"}

    def __init__(self, storage_root: Path = TASK_STATE_ROOT) -> None:
        self._tasks: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self.storage_root = Path(storage_root)
        self.storage_root.mkdir(parents=True, exist_ok=True)
        self._load_persisted()

    def _task_path(self, task_id: str) -> Path:
        return self.storage_root / f"{task_id}.json"

    def _persist_locked(self, task_id: str) -> None:
        task = self._tasks.get(task_id)
        if task is None:
            return
        persisted = json.loads(json.dumps(task, ensure_ascii=False, default=str))
        result = persisted.pop("result", None)
        if isinstance(result, dict):
            persisted["result_checkpoint"] = {
                key: result.get(key)
                for key in ("phase", "session_id")
                if result.get(key) is not None
            }
        path = self._task_path(task_id)
        temp = path.with_suffix(".tmp")
        temp.write_text(
            json.dumps(persisted, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
        temp.replace(path)

    def _load_persisted(self) -> None:
        for path in self.storage_root.glob("*.json"):
            try:
                task = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(task, dict) or not task.get("task_id"):
                continue
            if task.get("status") in {"queued", "running", "cancelling"}:
                task.update(
                    status="interrupted",
                    pct=float(task.get("pct") or 0),
                    title="任务因服务重启中断",
                    detail="源文件与已完成共享缓存仍保留，可点击重试继续。",
                    interrupted_at=time.time(),
                    restartable=bool(task.get("request")),
                )
                self._tasks[str(task["task_id"])] = task
                self._persist_locked(str(task["task_id"]))
            else:
                self._tasks[str(task["task_id"])] = task

    def start(
        self,
        action: str,
        session_id: str,
        worker: Callable[[str], dict[str, Any]],
        request_payload: Optional[dict[str, Any]] = None,
    ) -> str:
        self.prune()
        task_id = uuid.uuid4().hex
        now = time.time()
        with self._lock:
            self._tasks[task_id] = {
                "task_id": task_id,
                "session_id": session_id,
                "action": action,
                "status": "queued",
                "pct": 0.0,
                "title": "排队中",
                "detail": "任务已进入队列。",
                "files": {},
                "request": json.loads(
                    json.dumps(request_payload or {}, ensure_ascii=False, default=str)
                ),
                "restartable": bool(request_payload),
                "cancel_requested": False,
                "created_at": now,
                "updated_at": now,
            }
            self._persist_locked(task_id)

        def run() -> None:
            self.update(task_id, status="running", pct=1, title="任务启动")
            try:
                self.raise_if_cancelled(task_id)
                result = worker(task_id)
                self.raise_if_cancelled(task_id)
                self.update(
                    task_id,
                    status="done",
                    pct=100,
                    title="处理完成",
                    detail="处理完成。",
                    result=result,
                )
            except TaskCancelled as exc:
                self.update(
                    task_id,
                    status="cancelled",
                    title="任务已取消",
                    detail=str(exc),
                    cancelled_at=time.time(),
                )
            except Exception as exc:
                self.update(
                    task_id,
                    status="error",
                    pct=100,
                    title="处理失败",
                    detail=str(exc),
                    error=str(exc),
                    traceback=traceback.format_exc(),
                )

        threading.Thread(target=run, daemon=True, name=f"trace-{action}-{task_id[:8]}").start()
        return task_id

    def update(self, task_id: str, **kwargs: Any) -> None:
        with self._lock:
            task = self._tasks.setdefault(task_id, {})
            task.update(kwargs)
            task["updated_at"] = time.time()
            self._persist_locked(task_id)

    def update_file(self, task_id: str, source_key: str, **kwargs: Any) -> None:
        with self._lock:
            task = self._tasks.setdefault(task_id, {})
            files = task.setdefault("files", {})
            file_state = files.setdefault(source_key, {})
            file_state.update(kwargs)
            task["updated_at"] = time.time()
            self._persist_locked(task_id)

    def get(self, task_id: str) -> dict[str, Any]:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise KeyError("任务不存在或已过期。")
            return json.loads(json.dumps(task, ensure_ascii=False, default=str))

    def has_active_for_session(self, session_id: str) -> bool:
        with self._lock:
            return any(
                task.get("session_id") == session_id
                and task.get("status") in {"queued", "running", "cancelling"}
                for task in self._tasks.values()
            )

    def cancel(self, task_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise KeyError("任务不存在或已过期。")
            if task.get("status") in self.TERMINAL_STATUSES:
                return False
            task.update(
                cancel_requested=True,
                status="cancelling",
                title="正在取消任务",
                detail="等待当前分块安全结束后停止。",
                updated_at=time.time(),
            )
            self._persist_locked(task_id)
            return True

    def raise_if_cancelled(self, task_id: str) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            cancelled = bool(task and task.get("cancel_requested"))
        if cancelled:
            raise TaskCancelled("任务已按用户请求取消；已完成的共享源缓存仍可复用。")

    def list_recent(self, session_id: str = "", limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            tasks = [
                task
                for task in self._tasks.values()
                if not session_id or task.get("session_id") == session_id
            ]
            tasks.sort(key=lambda task: -float(task.get("updated_at") or 0))
            return json.loads(
                json.dumps(
                    tasks[: max(1, min(limit, 100))],
                    ensure_ascii=False,
                    default=str,
                )
            )

    def prune(self) -> None:
        now = time.time()
        with self._lock:
            expired = [
                task_id
                for task_id, task in self._tasks.items()
                if task.get("status") in self.TERMINAL_STATUSES
                and now - float(task.get("updated_at", now)) > TASK_DONE_TTL_SECONDS
            ]
            for task_id in expired:
                self._tasks.pop(task_id, None)
                self._task_path(task_id).unlink(missing_ok=True)
            overflow = len(self._tasks) - TASK_MAX_ITEMS
            if overflow > 0:
                terminal = sorted(
                    (
                        (task_id, task)
                        for task_id, task in self._tasks.items()
                        if task.get("status") in self.TERMINAL_STATUSES
                    ),
                    key=lambda item: float(item[1].get("updated_at", 0)),
                )
                for task_id, _ in terminal[:overflow]:
                    self._tasks.pop(task_id, None)
                    self._task_path(task_id).unlink(missing_ok=True)


SESSIONS = SessionManager()
TASKS = TaskManager()


def start_janitor() -> None:
    def loop() -> None:
        while True:
            time.sleep(60)
            try:
                SESSIONS.prune()
                TASKS.prune()
            except Exception:
                pass

    threading.Thread(target=loop, daemon=True, name="trace-cache-janitor").start()
