"""카테고리 구성 저장소 — 설정 화면에서 편집 가능한 바로가기 분류 목록.

왜 파일로 빼는가: 카테고리는 조직마다 다르다(어떤 곳은 '가상화'·'DB'로 나누고 어떤 곳은
법인별로 나눈다). 코드에 박아 두면 쓰는 사람이 바꿀 수 없어 결국 전부 '커스텀 링크'로
몰린다. 내장 7종은 **최초 seed** 일 뿐이고 실제 값은 `categories.json` 으로 관리한다.

식별자(id)는 URL 에 실리므로 슬러그(`[a-z0-9-]`)로 제한한다. 예전 파일은 카테고리를
`"Monitoring & Metrics"` 같은 **영문 이름 그대로** 저장했으므로 `LEGACY_IDS` 로 옮겨 준다
(이 표를 지우면 업그레이드 직후 기존 바로가기가 전부 기본 카테고리로 떨어진다).
"""

from __future__ import annotations

import re
import threading

from .jsonfile import read_json, write_json
from .ssrf import ValidationError

# 화면 배지 색. CSS 는 `.cat-<color>` 클래스를 갖고 있다(styles.css).
# 임의 색상 문자열을 받지 않는 이유: 그대로 style 에 넣으면 CSP(인라인 style 금지)에
# 걸리고, 값 검증도 흐려진다. 팔레트에서 고르게 한다.
COLORS = ("emerald", "blue", "cyan", "amber", "rose", "violet", "indigo", "slate")

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
MAX_CATEGORIES = 60

# 지울 수 없는 기본 카테고리 — 다른 카테고리를 지웠을 때 그 바로가기들이 갈 곳이다.
DEFAULT_CATEGORY_ID = "custom"

SEED_CATEGORIES = [
    {"id": "monitoring", "label": "모니터링 & 메트릭", "color": "emerald"},
    {"id": "infra", "label": "인프라 & DCIM", "color": "blue"},
    {"id": "network", "label": "네트워크 & 트래픽", "color": "cyan"},
    {"id": "security", "label": "보안 & IAM", "color": "amber"},
    {"id": "incident", "label": "장애 & 운영", "color": "rose"},
    {"id": "storage", "label": "스토리지 & 백업", "color": "violet"},
    {"id": DEFAULT_CATEGORY_ID, "label": "커스텀 링크", "color": "indigo"},
]

# v2.215 이전 파일이 쓰던 값 → 새 id.
LEGACY_IDS = {
    "Monitoring & Metrics": "monitoring",
    "Infrastructure & DCIM": "infra",
    "Network & Traffic": "network",
    "Security & IAM": "security",
    "Incidents & Operations": "incident",
    "Storage & Backup": "storage",
    "Custom Shortcuts": DEFAULT_CATEGORY_ID,
}


def _text(value, limit, default=""):
    if not isinstance(value, str):
        return default
    cleaned = " ".join(value.split())
    return cleaned[:limit] if cleaned else default


def slugify(value) -> str:
    """라벨에서 id 를 만든다. 한글만 있는 라벨이면 빈 문자열(호출부가 대체 id 를 만든다)."""
    lowered = _text(value, 64).lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")[:32]
    return slug if ID_RE.match(slug or "") else ""


class CategoryStore:
    def __init__(self, path):
        self._path = path
        self._lock = threading.RLock()
        self._items = None

    # ---------- 내부 ----------

    def _load(self):
        if self._items is None:
            raw = read_json(self._path, None, expect=list)
            if raw is None:
                self._items = [dict(cat) for cat in SEED_CATEGORIES]
                write_json(self._path, self._items)
            else:
                cleaned = [cat for cat in (self._clean(entry, keep_id=True) for entry in raw) if cat]
                self._items = self._ensure_default(cleaned)
        return self._items

    @staticmethod
    def _ensure_default(items):
        """기본 카테고리는 항상 존재해야 한다 — 파일이 비었거나 지워졌을 때의 복구 경로."""
        if not items:
            return [dict(cat) for cat in SEED_CATEGORIES]
        if not any(cat["id"] == DEFAULT_CATEGORY_ID for cat in items):
            fallback = next(cat for cat in SEED_CATEGORIES if cat["id"] == DEFAULT_CATEGORY_ID)
            items.append(dict(fallback))
        return items

    def _save(self):
        write_json(self._path, self._items)

    def _clean(self, data, *, keep_id=False, existing=None):
        if not isinstance(data, dict):
            if keep_id:
                return None
            raise ValidationError("카테고리 정보가 올바르지 않습니다.")
        base = dict(existing or {})

        label = _text(data.get("label", base.get("label", "")), 60)
        if not label:
            if keep_id:
                return None
            raise ValidationError("카테고리 이름을 입력하세요.")

        cat_id = _text(data.get("id", base.get("id", "")), 32).lower()
        if not ID_RE.match(cat_id or ""):
            cat_id = slugify(label)
        color = data.get("color", base.get("color"))
        return {
            "id": cat_id,
            "label": label,
            "color": color if color in COLORS else "slate",
        }

    # ---------- 공개 ----------

    def all(self):
        with self._lock:
            return [dict(cat) for cat in self._load()]

    def ids(self):
        with self._lock:
            return {cat["id"] for cat in self._load()}

    def resolve(self, value):
        """저장된 값 → 현재 유효한 id. 없으면 None(호출부가 기본값으로 대체)."""
        text = _text(value, 64)
        if not text:
            return None
        known = self.ids()
        if text in known:
            return text
        legacy = LEGACY_IDS.get(text)
        return legacy if legacy in known else None

    def add(self, data):
        with self._lock:
            items = self._load()
            if len(items) >= MAX_CATEGORIES:
                raise ValidationError(f"카테고리는 최대 {MAX_CATEGORIES}개까지 만들 수 있습니다.")
            item = self._clean(data)
            if not item["id"]:
                # 한글 전용 라벨은 슬러그가 비므로 순번으로 만든다(중복 회피).
                index = len(items) + 1
                while any(cat["id"] == f"cat-{index}" for cat in items):
                    index += 1
                item["id"] = f"cat-{index}"
            if any(cat["id"] == item["id"] for cat in items):
                raise ValidationError(f"이미 있는 ID 입니다: {item['id']}")
            items.append(item)
            self._save()
            return dict(item)

    def update(self, cat_id, data):
        with self._lock:
            items = self._load()
            for index, cat in enumerate(items):
                if cat["id"] != cat_id:
                    continue
                payload = dict(data)
                payload["id"] = cat_id        # id 는 고정(바로가기가 참조하고 있다)
                items[index] = self._clean(payload, existing=cat)
                self._save()
                return dict(items[index])
        return None

    def delete(self, cat_id):
        """삭제하고 True. 기본 카테고리는 거부(그 바로가기들이 갈 곳이 없어진다)."""
        if cat_id == DEFAULT_CATEGORY_ID:
            raise ValidationError("기본 카테고리는 삭제할 수 없습니다.")
        with self._lock:
            items = self._load()
            remaining = [cat for cat in items if cat["id"] != cat_id]
            if len(remaining) == len(items):
                return False
            self._items = self._ensure_default(remaining)
            self._save()
            return True

    def move(self, cat_id, delta):
        """표시 순서 한 칸 이동 — 대시보드 필터 칩과 선택 목록이 이 순서로 나온다."""
        with self._lock:
            items = self._load()
            for index, cat in enumerate(items):
                if cat["id"] != cat_id:
                    continue
                target = index + (1 if delta > 0 else -1)
                if target < 0 or target >= len(items):
                    return None
                items[index], items[target] = items[target], items[index]
                self._save()
                return [dict(entry) for entry in items]
        raise FileNotFoundError(cat_id)

    def reset(self):
        with self._lock:
            self._items = [dict(cat) for cat in SEED_CATEGORIES]
            self._save()
            return self.all()
