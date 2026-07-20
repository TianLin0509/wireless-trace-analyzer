from __future__ import annotations

import hashlib
import json
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


CACHE_FORMAT_VERSION = 2
FINGERPRINT_SAMPLE_BYTES = 1024 * 1024


class SharedSourceCache:
    """Cross-session immutable source cache keyed by a fast file fingerprint."""

    def __init__(self, root: Path, max_bytes: int, ttl_seconds: int = 14 * 86400) -> None:
        self.root = Path(root)
        self.max_bytes = max(1, int(max_bytes))
        self.ttl_seconds = max(60, int(ttl_seconds))
        self._guard = threading.RLock()
        self._locks: dict[str, threading.RLock] = {}
        self.root.mkdir(parents=True, exist_ok=True)

    def fingerprint(self, path: Path, trace_id: str) -> str:
        stat = path.stat()
        digest = hashlib.blake2b(digest_size=20)
        digest.update(f"v{CACHE_FORMAT_VERSION}|T{trace_id}|{stat.st_size}|{stat.st_mtime_ns}".encode())
        with path.open("rb") as handle:
            digest.update(handle.read(FINGERPRINT_SAMPLE_BYTES))
            if stat.st_size > FINGERPRINT_SAMPLE_BYTES:
                handle.seek(max(0, stat.st_size - FINGERPRINT_SAMPLE_BYTES))
                digest.update(handle.read(FINGERPRINT_SAMPLE_BYTES))
        return digest.hexdigest()

    def _directory(self, fingerprint: str) -> Path:
        return self.root / fingerprint

    def _metadata_path(self, fingerprint: str) -> Path:
        return self._directory(fingerprint) / "metadata.json"

    def _database_path(self, fingerprint: str) -> Path:
        return self._directory(fingerprint) / "data.duckdb"

    @contextmanager
    def locked(self, fingerprint: str) -> Iterator[None]:
        with self._guard:
            lock = self._locks.setdefault(fingerprint, threading.RLock())
        with lock:
            yield

    def lookup(self, fingerprint: str, trace_id: str) -> dict[str, Any] | None:
        metadata_path = self._metadata_path(fingerprint)
        if not metadata_path.is_file():
            return None
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if (
            int(payload.get("cache_format_version") or 0) != CACHE_FORMAT_VERSION
            or str(payload.get("trace_id") or "") != str(trace_id)
        ):
            return None
        if str(trace_id) != "396" and not self._database_path(fingerprint).is_file():
            return None
        payload["last_used"] = time.time()
        if str(trace_id) != "396":
            payload["database_path"] = str(self._database_path(fingerprint))
        self._write_metadata(fingerprint, payload)
        return payload

    def miss_reason(self, path: Path, fingerprint: str, trace_id: str) -> str:
        metadata_path = self._metadata_path(fingerprint)
        if metadata_path.is_file():
            try:
                payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return "共享缓存元数据损坏，已安全重建"
            if int(payload.get("cache_format_version") or 0) != CACHE_FORMAT_VERSION:
                return "共享缓存格式已升级，已重建"
            if str(payload.get("trace_id") or "") != str(trace_id):
                return "共享缓存跟踪类型不一致，已重建"
            if str(trace_id) != "396" and not self._database_path(fingerprint).is_file():
                return "共享缓存数据库缺失，已重建"
        target = str(path.resolve()).casefold()
        for item in self.snapshot()["items"]:
            cached_path = str(item.get("path") or "")
            try:
                cached_path = str(Path(cached_path).resolve())
            except OSError:
                pass
            if cached_path.casefold() == target and str(item.get("fingerprint")) != fingerprint:
                return "源文件大小、修改时间或首尾摘要已变化，已重建"
        return "首次读取该物理源文件，已建立共享缓存"

    def staging_database_path(self, fingerprint: str) -> Path:
        staging = self.root / "_staging"
        staging.mkdir(parents=True, exist_ok=True)
        return staging / f"{fingerprint}-{uuid.uuid4().hex}.duckdb"

    def publish_table(
        self,
        fingerprint: str,
        trace_id: str,
        staging_database: Path,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        directory = self._directory(fingerprint)
        directory.mkdir(parents=True, exist_ok=True)
        database_path = self._database_path(fingerprint)
        for candidate in directory.glob("data.duckdb*"):
            if candidate.is_file():
                candidate.unlink()
        staging_database.replace(database_path)
        now = time.time()
        payload = {
            **metadata,
            "fingerprint": fingerprint,
            "trace_id": str(trace_id),
            "database_path": str(database_path),
            "cache_format_version": CACHE_FORMAT_VERSION,
            "created_at": float(metadata.get("created_at") or now),
            "last_used": now,
        }
        self._write_metadata(fingerprint, payload)
        self.prune(protected={fingerprint})
        return payload

    def publish_aggregate(
        self,
        fingerprint: str,
        trace_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        directory = self._directory(fingerprint)
        directory.mkdir(parents=True, exist_ok=True)
        now = time.time()
        payload = {
            **metadata,
            "fingerprint": fingerprint,
            "trace_id": str(trace_id),
            "cache_format_version": CACHE_FORMAT_VERSION,
            "created_at": float(metadata.get("created_at") or now),
            "last_used": now,
        }
        self._write_metadata(fingerprint, payload)
        self.prune(protected={fingerprint})
        return payload

    def _write_metadata(self, fingerprint: str, payload: dict[str, Any]) -> None:
        path = self._metadata_path(fingerprint)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)

    @staticmethod
    def _directory_bytes(path: Path) -> int:
        total = 0
        for item in path.glob("*"):
            try:
                if item.is_file():
                    total += item.stat().st_size
            except OSError:
                continue
        return total

    def snapshot(self) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        if not self.root.exists():
            return {"item_count": 0, "total_bytes": 0, "max_bytes": self.max_bytes, "items": []}
        for directory in self.root.iterdir():
            if not directory.is_dir() or directory.name.startswith("_"):
                continue
            metadata_path = directory / "metadata.json"
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            items.append(
                {
                    "fingerprint": directory.name,
                    "name": metadata.get("name"),
                    "path": metadata.get("path"),
                    "trace_id": metadata.get("trace_id"),
                    "rows": int(metadata.get("rows") or 0),
                    "bytes": self._directory_bytes(directory),
                    "last_used": float(metadata.get("last_used") or 0),
                }
            )
        items.sort(key=lambda item: -item["last_used"])
        return {
            "item_count": len(items),
            "total_bytes": sum(item["bytes"] for item in items),
            "max_bytes": self.max_bytes,
            "items": items,
        }

    def prune(self, protected: set[str] | None = None) -> int:
        protected = protected or set()
        snapshot = self.snapshot()
        now = time.time()
        removed = 0
        remaining_bytes = int(snapshot["total_bytes"])
        for item in reversed(snapshot["items"]):
            fingerprint = str(item["fingerprint"])
            expired = now - float(item["last_used"]) > self.ttl_seconds
            over_budget = remaining_bytes > self.max_bytes
            if fingerprint in protected or (not expired and not over_budget):
                continue
            directory = self._directory(fingerprint)
            shutil.rmtree(directory, ignore_errors=True)
            remaining_bytes -= int(item["bytes"])
            removed += 1
        return removed

    def clear(self) -> int:
        snapshot = self.snapshot()
        for item in snapshot["items"]:
            shutil.rmtree(self._directory(str(item["fingerprint"])), ignore_errors=True)
        return int(snapshot["item_count"])
