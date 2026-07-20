from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any


class AnalysisRecipeStore:
    """Persist a complete A/B analysis workspace outside disposable sessions."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()

    @staticmethod
    def _name(value: Any) -> str:
        name = str(value or "").strip()
        if not name:
            raise ValueError("分析方案名称不能为空。")
        if len(name) > 80 or any(ord(char) < 32 for char in name):
            raise ValueError("分析方案名称不能超过 80 个字符，也不能包含控制字符。")
        return name

    @staticmethod
    def _strings(values: Any, label: str, limit: int = 500) -> list[str]:
        if values is None:
            return []
        if not isinstance(values, list):
            raise ValueError(f"{label} 必须是列表。")
        output: list[str] = []
        seen: set[str] = set()
        for value in values:
            item = str(value or "").strip()
            if not item or item in seen:
                continue
            if len(item) > 256:
                raise ValueError(f"{label} 包含过长内容：{item[:40]}...")
            seen.add(item)
            output.append(item)
            if len(output) > limit:
                raise ValueError(f"{label} 不能超过 {limit} 项。")
        return output

    @staticmethod
    def _path(value: Any) -> str:
        path = str(value or "").strip()
        if len(path) > 4096:
            raise ValueError("目录路径过长。")
        return path

    @classmethod
    def _workspace(cls, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError("分析方案 workspace 格式无效。")
        paths = value.get("paths") or {}
        selection = value.get("selection") or {}
        batch_refs = value.get("batch_refs") or {}
        columns = value.get("columns") or {}
        raw_source_refs = value.get("source_refs") or {}
        analysis = value.get("analysis") or {}
        filters: list[dict[str, Any]] = []
        raw_filters = analysis.get("filters") or []
        if not isinstance(raw_filters, list) or len(raw_filters) > 50:
            raise ValueError("分析筛选条件必须是不超过 50 项的列表。")
        for raw in raw_filters:
            if not isinstance(raw, dict):
                continue
            column = str(raw.get("column") or "").strip()
            op = str(raw.get("op") or "eq").strip()
            if not column:
                continue
            filters.append({"column": column, "op": op, "value": raw.get("value")})
        plot_size = analysis.get("plot_size") or {}
        width = max(480, min(3200, int(plot_size.get("width") or 1200)))
        height = max(360, min(6000, int(plot_size.get("height") or 720)))
        source_refs: dict[str, dict[str, str]] = {}
        allowed_source_keys = {
            f"{side}{trace}"
            for side in ("A", "B")
            for trace in ("396", "537", "714")
        }
        if isinstance(raw_source_refs, dict):
            for source_key, raw in raw_source_refs.items():
                key = str(source_key or "").upper()
                if key not in allowed_source_keys or not isinstance(raw, dict):
                    continue
                source_refs[key] = {
                    "path": cls._path(raw.get("path")),
                    "name": str(raw.get("name") or "")[:512],
                    "fingerprint": str(raw.get("fingerprint") or "")[:256],
                }
        return {
            "paths": {
                "A": cls._path(paths.get("A")),
                "B": cls._path(paths.get("B")),
            },
            "recursive": bool(value.get("recursive", True)),
            "selection": {
                "A": str(selection.get("A") or "") or None,
                "B": str(selection.get("B") or "") or None,
            },
            "batch_refs": {
                side: dict(batch_refs.get(side) or {}) for side in ("A", "B")
            },
            "source_refs": source_refs,
            "columns": {
                "537": cls._strings(columns.get("537"), "T537 字段"),
                "714": cls._strings(columns.get("714"), "T714 字段"),
            },
            "row_limit": max(0, int(value.get("row_limit") or 0)),
            "analysis": {
                "filters": filters,
                "global_search": str(analysis.get("global_search") or "")[:500],
                "users": cls._strings(analysis.get("users"), "分析用户", limit=5000),
                "metrics": cls._strings(analysis.get("metrics"), "图表指标", limit=20),
                "visible_columns": cls._strings(
                    analysis.get("visible_columns"), "明细显示列"
                ),
                "pinned_columns": cls._strings(
                    analysis.get("pinned_columns"), "置左显示列"
                ),
                "sort_column": str(analysis.get("sort_column") or "")[:256],
                "sort_ascending": bool(analysis.get("sort_ascending", True)),
                "active_side": "B" if str(analysis.get("active_side")) == "B" else "A",
                "plot_size": {"width": width, "height": height},
            },
        }

    def _read(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {"version": 1, "recipes": []}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"分析方案文件无法读取：{self.path}") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("recipes"), list):
            raise ValueError(f"分析方案文件格式无效：{self.path}")
        return payload

    def _write(self, payload: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temp.replace(self.path)

    @staticmethod
    def _copy(recipe: dict[str, Any]) -> dict[str, Any]:
        return json.loads(json.dumps(recipe, ensure_ascii=False))

    @staticmethod
    def _index(recipes: list[dict[str, Any]], recipe_id: str) -> int:
        for index, recipe in enumerate(recipes):
            if str(recipe.get("id") or "") == recipe_id:
                return index
        raise KeyError("分析方案不存在或已被删除。")

    @staticmethod
    def _unique(recipes: list[dict[str, Any]], name: str, exclude_id: str = "") -> None:
        key = name.casefold()
        if any(
            str(item.get("id") or "") != exclude_id
            and str(item.get("name") or "").strip().casefold() == key
            for item in recipes
        ):
            raise ValueError("分析方案名称已存在，请更换名称或使用覆盖。")

    def list_recipes(self) -> list[dict[str, Any]]:
        with self._lock:
            recipes = [
                self._copy(item)
                for item in self._read().get("recipes", [])
                if isinstance(item, dict)
            ]
        return sorted(
            recipes,
            key=lambda item: (
                -float(item.get("updated_at") or 0),
                str(item.get("name") or ""),
            ),
        )

    def create_recipe(self, name: Any, workspace: Any) -> dict[str, Any]:
        normalized_name = self._name(name)
        normalized_workspace = self._workspace(workspace)
        now = time.time()
        with self._lock:
            payload = self._read()
            recipes = payload.setdefault("recipes", [])
            self._unique(recipes, normalized_name)
            recipe = {
                "id": uuid.uuid4().hex,
                "name": normalized_name,
                "workspace": normalized_workspace,
                "created_at": now,
                "updated_at": now,
            }
            recipes.append(recipe)
            payload.update(version=1, updated_at=now)
            self._write(payload)
            return self._copy(recipe)

    def update_recipe(self, recipe_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        if not recipe_id:
            raise KeyError("分析方案 ID 为空。")
        with self._lock:
            payload = self._read()
            recipes = payload.setdefault("recipes", [])
            index = self._index(recipes, recipe_id)
            current = dict(recipes[index])
            if "name" in changes:
                name = self._name(changes.get("name"))
                self._unique(recipes, name, exclude_id=recipe_id)
                current["name"] = name
            if "workspace" in changes:
                current["workspace"] = self._workspace(changes.get("workspace"))
            current["updated_at"] = time.time()
            recipes[index] = current
            payload.update(version=1, updated_at=current["updated_at"])
            self._write(payload)
            return self._copy(current)

    def delete_recipe(self, recipe_id: str) -> bool:
        if not recipe_id:
            raise KeyError("分析方案 ID 为空。")
        with self._lock:
            payload = self._read()
            recipes = payload.setdefault("recipes", [])
            recipes.pop(self._index(recipes, recipe_id))
            payload["updated_at"] = time.time()
            self._write(payload)
        return True
