"""바로가기 저장소 — JSON 파일 1개, 원자적 쓰기, 손상 파일 보존.

본 저장소(The.DVC)의 자격증명 파일 규칙을 그대로 따른다:
- 쓰기는 tmp + fsync + rename 으로 **원자적**으로. 중간에 죽어도 반쪽 파일이 남지 않는다.
- 읽다가 JSON 파싱에 실패하면 조용히 빈 목록으로 넘기지 않고 `<파일>.corrupt.<ts>` 로
  **보존**한 뒤 기본값으로 시작한다. 보존하지 않으면 다음 저장이 멀쩡했던 원본을
  덮어써 전 링크가 영구 유실된다.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

from .datacenters import DATACENTER_IDS
from .defaults import CATEGORY_KEYS, DEFAULT_CATEGORY, default_shortcuts
from .ssrf import ValidationError, normalize_url

MAX_SHORTCUTS = 500
MAX_TAGS = 8

# 화면·저장 양쪽에서 쓰는 필드 화이트리스트. 여기 없는 키는 저장하지 않는다
# (클라이언트가 임의 필드를 밀어 넣어 파일을 부풀리지 못하게).
FIELDS = (
    "id", "name", "url", "category", "icon", "description", "tags",
    "datacenterId", "isFavorite", "createdViaSettings", "createdAt", "updatedAt",
)


def _clean_text(value, *, limit: int, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = " ".join(value.split())  # 개행·연속 공백 제거
    return text[:limit] if text else default


def _clean_tags(value) -> list:
    if isinstance(value, str):
        raw = value.split(",")
    elif isinstance(value, list):
        raw = value
    else:
        return []
    tags = []
    for item in raw:
        tag = _clean_text(item, limit=24)
        if tag and tag not in tags:
            tags.append(tag)
        if len(tags) >= MAX_TAGS:
            break
    return tags


def _clean_datacenter_id(value) -> str:
    text = _clean_text(value, limit=32, default="all")
    return text if text in DATACENTER_IDS else "all"


def _clean_category(value) -> str:
    text = _clean_text(value, limit=64, default=DEFAULT_CATEGORY)
    return text if text in CATEGORY_KEYS else DEFAULT_CATEGORY


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


class ShortcutStore:
    def __init__(self, path: Path):
        self._path = Path(path)
        self._lock = threading.RLock()
        self._items: list = []
        self._loaded = False

    # ---------- 파일 입출력 ----------

    def _preserve_corrupt(self) -> None:
        """파싱 실패한 파일을 타임스탬프 붙여 보존한다(조용한 유실 방지)."""
        try:
            backup = self._path.with_suffix(self._path.suffix + f".corrupt.{int(time.time())}")
            os.replace(self._path, backup)
            print(f"[store] 손상된 저장 파일을 보존했습니다: {backup}", flush=True)
        except OSError as exc:
            print(f"[store] 손상 파일 보존 실패: {exc}", flush=True)

    def _read(self) -> list:
        if not self._path.exists():
            return default_shortcuts()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"[store] 저장 파일을 읽을 수 없습니다({exc}) — 보존 후 기본값으로 시작합니다.", flush=True)
            self._preserve_corrupt()
            return default_shortcuts()
        if not isinstance(raw, list):
            print("[store] 저장 파일 형식이 목록이 아닙니다 — 보존 후 기본값으로 시작합니다.", flush=True)
            self._preserve_corrupt()
            return default_shortcuts()
        return [item for item in (self._sanitize(entry, keep_id=True) for entry in raw) if item]

    def _write(self, items: list) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + f".tmp.{os.getpid()}")
        payload = json.dumps(items, ensure_ascii=False, indent=2)
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self._path)
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            pass

    def _ensure_loaded(self) -> None:
        if not self._loaded:
            self._items = self._read()
            self._loaded = True

    # ---------- 정규화 ----------

    def _sanitize(self, data, *, keep_id: bool = False, existing: dict = None):
        """입력을 저장 가능한 형태로 정규화한다. 이름/URL 이 없으면 None(폐기)."""
        if not isinstance(data, dict):
            return None
        base = dict(existing or {})

        name = _clean_text(data.get("name", base.get("name", "")), limit=120)
        if not name:
            if keep_id:
                return None
            raise ValidationError("이름을 입력하세요.")

        raw_url = data.get("url", base.get("url", ""))
        try:
            url = normalize_url(raw_url)
        except ValidationError:
            if keep_id:
                return None
            raise

        item = {
            "id": str(data.get("id") or base.get("id") or "") if keep_id else base.get("id", ""),
            "name": name,
            "url": url,
            "category": _clean_category(data.get("category", base.get("category"))),
            "icon": _clean_text(data.get("icon", base.get("icon", "🔗")), limit=8, default="🔗"),
            "description": _clean_text(
                data.get("description", base.get("description", "")), limit=240),
            "tags": _clean_tags(data.get("tags", base.get("tags", []))),
            "datacenterId": _clean_datacenter_id(data.get("datacenterId", base.get("datacenterId"))),
            "isFavorite": bool(data.get("isFavorite", base.get("isFavorite", False))),
            "createdViaSettings": bool(
                data.get("createdViaSettings", base.get("createdViaSettings", False))),
            "createdAt": base.get("createdAt") or _clean_text(data.get("createdAt", ""), limit=32)
            or _now_iso(),
        }
        if not item["id"]:
            item["id"] = "sc-" + uuid.uuid4().hex[:12]
        if not item["description"]:
            item["description"] = f"{name} 서비스 바로가기"
        if base:
            item["updatedAt"] = _now_iso()
        return {key: item[key] for key in FIELDS if key in item}

    # ---------- 공개 API ----------

    def all(self) -> list:
        with self._lock:
            self._ensure_loaded()
            return [dict(item) for item in self._items]

    def get(self, shortcut_id: str):
        with self._lock:
            self._ensure_loaded()
            for item in self._items:
                if item["id"] == shortcut_id:
                    return dict(item)
        return None

    def add(self, data: dict) -> dict:
        with self._lock:
            self._ensure_loaded()
            if len(self._items) >= MAX_SHORTCUTS:
                raise ValidationError(f"바로가기는 최대 {MAX_SHORTCUTS}개까지 등록할 수 있습니다.")
            payload = dict(data)
            payload.pop("id", None)
            payload.setdefault("createdViaSettings", True)
            item = self._sanitize(payload)
            # 최신 등록이 위로 오게 — 샘플 포탈과 같은 순서.
            self._items.insert(0, item)
            self._write(self._items)
            return dict(item)

    def update(self, shortcut_id: str, data: dict):
        with self._lock:
            self._ensure_loaded()
            for index, item in enumerate(self._items):
                if item["id"] != shortcut_id:
                    continue
                payload = dict(data)
                payload["id"] = shortcut_id
                updated = self._sanitize(payload, existing=item)
                self._items[index] = updated
                self._write(self._items)
                return dict(updated)
        return None

    def delete(self, shortcut_id: str) -> bool:
        with self._lock:
            self._ensure_loaded()
            remaining = [item for item in self._items if item["id"] != shortcut_id]
            if len(remaining) == len(self._items):
                return False
            self._items = remaining
            self._write(self._items)
            return True

    def reset(self) -> list:
        with self._lock:
            self._items = [item for item in (self._sanitize(entry, keep_id=True)
                                             for entry in default_shortcuts()) if item]
            self._loaded = True
            self._write(self._items)
            return [dict(item) for item in self._items]

    def replace_all(self, entries) -> list:
        """JSON 가져오기 — 유효한 항목만 남기고 통째로 교체한다."""
        if not isinstance(entries, list):
            raise ValidationError("가져오기 파일은 바로가기 목록(JSON 배열)이어야 합니다.")
        if len(entries) > MAX_SHORTCUTS:
            raise ValidationError(f"한 번에 {MAX_SHORTCUTS}개를 넘길 수 없습니다.")
        cleaned = [item for item in (self._sanitize(entry, keep_id=True) for entry in entries) if item]
        if not cleaned:
            raise ValidationError("가져올 수 있는 유효한 바로가기가 없습니다(이름·URL 확인).")
        seen = set()
        unique = []
        for item in cleaned:
            if item["id"] in seen:
                item["id"] = "sc-" + uuid.uuid4().hex[:12]
            seen.add(item["id"])
            unique.append(item)
        with self._lock:
            self._items = unique
            self._loaded = True
            self._write(self._items)
            return [dict(item) for item in self._items]
