from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any


class MergeColumnTemplateStore:
    """Persist Step 2 column selections outside disposable analysis sessions."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()

    @staticmethod
    def _normalize_name(value: Any) -> str:
        name = str(value or "").strip()
        if not name:
            raise ValueError("模板名称不能为空。")
        if len(name) > 80:
            raise ValueError("模板名称不能超过 80 个字符。")
        if any(ord(char) < 32 for char in name):
            raise ValueError("模板名称不能包含换行或控制字符。")
        return name

    @staticmethod
    def _normalize_columns(values: Any, label: str) -> list[str]:
        if not isinstance(values, list):
            raise ValueError(f"{label} 字段必须是列表。")
        output: list[str] = []
        seen: set[str] = set()
        for value in values:
            column = str(value or "").strip()
            if not column or column in seen:
                continue
            if len(column) > 256:
                raise ValueError(f"{label} 字段名过长：{column[:40]}...")
            seen.add(column)
            output.append(column)
            if len(output) > 500:
                raise ValueError(f"{label} 字段数量不能超过 500 个。")
        return output

    def _read_locked(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {"version": 1, "templates": []}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"字段模板文件无法读取：{self.path}。请检查文件是否损坏。") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("templates"), list):
            raise ValueError(f"字段模板文件格式无效：{self.path}")
        return payload

    def _write_locked(self, payload: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        temp_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(self.path)

    @staticmethod
    def _copy_template(template: dict[str, Any]) -> dict[str, Any]:
        return json.loads(json.dumps(template, ensure_ascii=False))

    def list_templates(self) -> list[dict[str, Any]]:
        with self._lock:
            payload = self._read_locked()
            templates = [
                self._copy_template(item)
                for item in payload.get("templates", [])
                if isinstance(item, dict)
            ]
        return sorted(
            templates,
            key=lambda item: (-float(item.get("updated_at") or 0), str(item.get("name") or "")),
        )

    @staticmethod
    def _find_index(templates: list[dict[str, Any]], template_id: str) -> int:
        for index, template in enumerate(templates):
            if str(template.get("id") or "") == template_id:
                return index
        raise KeyError("字段模板不存在或已被删除。")

    @staticmethod
    def _ensure_unique_name(
        templates: list[dict[str, Any]],
        name: str,
        exclude_id: str = "",
    ) -> None:
        key = name.casefold()
        if any(
            str(item.get("id") or "") != exclude_id
            and str(item.get("name") or "").strip().casefold() == key
            for item in templates
        ):
            raise ValueError("模板名称已存在，请更换名称或使用覆盖。")

    def create_template(
        self,
        name: Any,
        columns_537: Any,
        columns_714: Any,
    ) -> dict[str, Any]:
        normalized_name = self._normalize_name(name)
        normalized_537 = self._normalize_columns(columns_537, "T537")
        normalized_714 = self._normalize_columns(columns_714, "T714")
        if not normalized_537:
            raise ValueError("模板至少需要包含一个 T537 字段。")
        now = time.time()
        with self._lock:
            payload = self._read_locked()
            templates = payload.setdefault("templates", [])
            self._ensure_unique_name(templates, normalized_name)
            template = {
                "id": uuid.uuid4().hex,
                "name": normalized_name,
                "columns_537": normalized_537,
                "columns_714": normalized_714,
                "created_at": now,
                "updated_at": now,
            }
            templates.append(template)
            payload["version"] = 1
            payload["updated_at"] = now
            self._write_locked(payload)
            return self._copy_template(template)

    def update_template(self, template_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        if not template_id:
            raise KeyError("字段模板 ID 为空。")
        with self._lock:
            payload = self._read_locked()
            templates = payload.setdefault("templates", [])
            index = self._find_index(templates, template_id)
            current = dict(templates[index])
            if "name" in changes:
                name = self._normalize_name(changes.get("name"))
                self._ensure_unique_name(templates, name, exclude_id=template_id)
                current["name"] = name
            if "columns_537" in changes:
                current["columns_537"] = self._normalize_columns(
                    changes.get("columns_537"), "T537"
                )
            if "columns_714" in changes:
                current["columns_714"] = self._normalize_columns(
                    changes.get("columns_714"), "T714"
                )
            if not current.get("columns_537"):
                raise ValueError("模板至少需要包含一个 T537 字段。")
            current["updated_at"] = time.time()
            templates[index] = current
            payload["version"] = 1
            payload["updated_at"] = current["updated_at"]
            self._write_locked(payload)
            return self._copy_template(current)

    def delete_template(self, template_id: str) -> bool:
        if not template_id:
            raise KeyError("字段模板 ID 为空。")
        with self._lock:
            payload = self._read_locked()
            templates = payload.setdefault("templates", [])
            index = self._find_index(templates, template_id)
            templates.pop(index)
            payload["updated_at"] = time.time()
            self._write_locked(payload)
        return True
