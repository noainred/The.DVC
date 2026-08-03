"""바로가기 저장소 — JSON 파일 1개, 원자적 쓰기, 손상 파일 보존.

본 저장소(The.DVC)의 자격증명 파일 규칙을 그대로 따른다:
- 쓰기는 tmp + fsync + rename 으로 **원자적**으로. 중간에 죽어도 반쪽 파일이 남지 않는다.
- 읽다가 JSON 파싱에 실패하면 조용히 빈 목록으로 넘기지 않고 `<파일>.corrupt.<ts>` 로
  **보존**한 뒤 기본값으로 시작한다. 보존하지 않으면 다음 저장이 멀쩡했던 원본을
  덮어써 전 링크가 영구 유실된다.
"""

from __future__ import annotations

import threading
import uuid
from pathlib import Path

from .datacenters import DATACENTER_IDS
from .defaults import CATEGORY_KEYS, DEFAULT_CATEGORY, default_shortcuts
from .jsonfile import now_iso as _now_iso, read_json, write_json
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


def _clean_category(value) -> str:
    text = _clean_text(value, limit=64, default=DEFAULT_CATEGORY)
    return text if text in CATEGORY_KEYS else DEFAULT_CATEGORY


class ShortcutStore:
    def __init__(self, path: Path, datacenter_ids=None):
        """datacenter_ids: 현재 등록된 DC id 집합을 돌려주는 콜러블.

        설정에서 데이터센터를 추가/삭제할 수 있으므로 고정 목록을 쓰면 새로 만든 사이트에
        바로가기를 연결할 수 없다. 미지정 시 내장 28개를 쓴다.
        """
        self._path = Path(path)
        self._dc_ids = datacenter_ids or (lambda: DATACENTER_IDS)
        self._lock = threading.RLock()
        self._items: list = []
        self._loaded = False

    def _clean_datacenter_id(self, value) -> str:
        text = _clean_text(value, limit=32, default="all")
        try:
            known = self._dc_ids()
        except Exception:  # noqa: BLE001 — DC 저장소 문제로 바로가기 저장이 막히면 안 된다
            known = DATACENTER_IDS
        return text if text in known else "all"

    # ---------- 파일 입출력 ----------

    def _read(self) -> list:
        raw = read_json(self._path, None, expect=list)
        if raw is None:
            return default_shortcuts()
        return [item for item in (self._sanitize(entry, keep_id=True) for entry in raw) if item]

    def _write(self, items: list) -> None:
        write_json(self._path, items)

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
            "datacenterId": self._clean_datacenter_id(
                data.get("datacenterId", base.get("datacenterId"))),
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

    def move(self, shortcut_id: str, delta: int):
        """표시 순서를 한 칸 위/아래로 옮긴다.

        대시보드는 저장된 배열 순서 그대로 그린다 — 정렬 기준 필드를 따로 두면
        가져오기/복원 때 그 필드만 어긋나 순서가 뒤섞인다. 배열 자체를 진실의
        원천으로 두고 여기서만 바꾼다.
        """
        with self._lock:
            self._ensure_loaded()
            for index, item in enumerate(self._items):
                if item["id"] != shortcut_id:
                    continue
                target = index + (1 if delta > 0 else -1)
                if target < 0 or target >= len(self._items):
                    return None                     # 이미 끝 — 변경 없음
                self._items[index], self._items[target] = \
                    self._items[target], self._items[index]
                self._write(self._items)
                return [dict(entry) for entry in self._items]
        raise FileNotFoundError(shortcut_id)

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
