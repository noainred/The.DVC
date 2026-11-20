"""바로가기 저장소 — JSON 파일 1개, 원자적 쓰기, 손상 파일 보존.

본 저장소(The.DVC)의 자격증명 파일 규칙을 그대로 따른다:
- 쓰기는 tmp + fsync + rename 으로 **원자적**으로. 중간에 죽어도 반쪽 파일이 남지 않는다.
- 읽다가 JSON 파싱에 실패하면 조용히 빈 목록으로 넘기지 않고 `<파일>.corrupt.<ts>` 로
  **보존**한 뒤 기본값으로 시작한다. 보존하지 않으면 다음 저장이 멀쩡했던 원본을
  덮어써 전 링크가 영구 유실된다.
"""

from __future__ import annotations

import re
import threading
import uuid
from pathlib import Path

from .catstore import DEFAULT_CATEGORY_ID, LEGACY_IDS, SEED_CATEGORIES
from .datacenters import DATACENTER_IDS
from .defaults import default_shortcuts
from .jsonfile import StoreUnavailable, load_error_text, now_iso as _now_iso, read_json_state, write_json
from .ssrf import ValidationError, normalize_url

MAX_SHORTCUTS = 500
MAX_TAGS = 8

# v2.767(점검 R2-B5-4): 라우트(server.ID_PATTERN)가 받는 id 모양. 가져오기·파일 로드·백업 복원으로 들어온 id 가
# 이 모양이 아니면(점·공백·한글·64자 초과) 그 바로가기는 수정·삭제·이동·중지 API 가 전부 404 라 지울 방법이 없었다.
# 이 모양을 벗어난 id 만 새로 발급한다(맞는 id 는 그대로 — 이력이 id 로 이어진다).
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

# 화면·저장 양쪽에서 쓰는 필드 화이트리스트. 여기 없는 키는 저장하지 않는다
# (클라이언트가 임의 필드를 밀어 넣어 파일을 부풀리지 못하게).
FIELDS = (
    "id", "name", "url", "category", "icon", "description", "tags",
    "datacenterId", "isFavorite", "enabled", "createdViaSettings", "createdAt", "updatedAt",
)


def _clean_text(value, *, limit: int, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = " ".join(value.split())  # 개행·연속 공백 제거
    return text[:limit] if text else default


_FLAG_WORDS = {"true": True, "1": True, "false": False, "0": False}


def _parse_flag(value):
    """사용/즐겨찾기 플래그 해석 — (해석함, 값). 59회차(56회차 F7 의 바로가기판 · 재현): 예전에는 `bool(value)` 라 문자열 "false" 가
    True 였다(중지한 링크가 켜짐 · 즐겨찾기가 붙음). 불리언 · 0/1 · 'true'/'false'(대소문자 · 앞뒤 공백 무시)만 그 뜻으로 읽는다."""
    if isinstance(value, bool):
        return True, value
    if isinstance(value, (int, float)) and value in (0, 1):
        return True, bool(value)
    if isinstance(value, str):
        key = value.strip().lower()
        if key in _FLAG_WORDS:
            return True, _FLAG_WORDS[key]
    return False, None


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


_SEED_CATEGORY_IDS = {cat["id"] for cat in SEED_CATEGORIES}


def _fallback_category(value) -> str:
    """카테고리 저장소를 주입받지 못했을 때(테스트 등)의 최소 정규화.

    모르는 값은 기본 카테고리로 떨어뜨린다 — 그대로 두면 대시보드 칩 어디에도 안 잡히는
    '유령 분류'가 파일에 남는다.
    """
    text = _clean_text(value, limit=64, default=DEFAULT_CATEGORY_ID)
    resolved = LEGACY_IDS.get(text, text)
    return resolved if resolved in _SEED_CATEGORY_IDS else DEFAULT_CATEGORY_ID


class ShortcutStore:
    def __init__(self, path: Path, datacenter_ids=None, resolve_category=None):
        """datacenter_ids: 현재 등록된 DC id 집합을 돌려주는 콜러블.
        resolve_category: 저장값 → 유효 카테고리 id 를 돌려주는 콜러블(없으면 None).

        설정에서 데이터센터·카테고리를 추가/삭제할 수 있으므로 고정 목록을 쓰면 새로 만든
        사이트/분류에 바로가기를 연결할 수 없다. 미지정 시 내장 기본값을 쓴다.
        """
        self._path = Path(path)
        self._dc_ids = datacenter_ids or (lambda: DATACENTER_IDS)
        self._resolve_category = resolve_category
        self._lock = threading.RLock()
        self._items: list = []
        self._loaded = False
        self._reissued = False
        self._load_error = None

    def _clean_category(self, value) -> str:
        if not self._resolve_category:
            return _fallback_category(value)
        try:
            # 삭제된 카테고리를 참조하던 바로가기는 기본 카테고리로 떨어진다(사라지지 않게).
            return self._resolve_category(value) or DEFAULT_CATEGORY_ID
        except StoreUnavailable:
            # 46회차 H2(재현): 카테고리 파일을 못 읽는 동안에는 원값 그대로 — 기본 분류로 바꾸면 다음 저장이 영구히 굳힌다
            return _clean_text(value, limit=64, default=DEFAULT_CATEGORY_ID)
        except Exception:  # noqa: BLE001 — 카테고리 저장소 문제로 바로가기 저장이 막히면 안 된다
            return _fallback_category(value)

    def _clean_datacenter_id(self, value) -> str:
        text = _clean_text(value, limit=32, default="all")
        try:
            known = self._dc_ids()
        except StoreUnavailable:
            return text   # 46회차 H2: 데이터센터 파일을 못 읽는 동안에는 원값 그대로('all' 로 바꿔 굳히지 않는다)
        except Exception:  # noqa: BLE001 — DC 저장소 문제로 바로가기 저장이 막히면 안 된다
            known = DATACENTER_IDS
        return text if text in known else "all"

    # ---------- 파일 입출력 ----------

    def _read(self) -> list:
        # 47회차 #4(재현): 손상 · 읽기 오류를 첫 기동과 구분한다(46회차 데이터센터 · 분류와 같은 규칙) — 예전에는 권한 오류도 손상으로 보고 원본을
        #   옮긴 뒤 샘플 13개로 돌았고, 다음 저장이 샘플을 굳혀 재기동하면 첫 기동처럼 보였다. 못 읽으면 빈 목록 + 표지(쓰기 거절).
        raw, state = read_json_state(self._path, expect=list, quiet=self._load_error == "unreadable")
        self._load_error = state if state in ("corrupt", "unreadable") else None
        self._reissued = False
        if state == "missing":
            return default_shortcuts()
        if self._load_error:
            return []
        items = []
        for entry in raw:
            item = self._sanitize(entry, keep_id=True)
            if not item:
                continue
            if isinstance(entry, dict) and item["id"] != str(entry.get("id") or ""):
                self._reissued = True
            items.append(item)
        return items

    def _write(self, items: list) -> None:
        if self._load_error:
            raise ValidationError(load_error_text("shortcuts.json", self._load_error))
        write_json(self._path, items)

    def _ensure_writable(self) -> None:
        """47회차 #4: 못 읽음 상태의 쓰기는 목록을 바꾸기 전에 거절한다(#1 과 같은 규칙)."""
        self._ensure_loaded()
        if self._load_error:
            raise ValidationError(load_error_text("shortcuts.json", self._load_error))

    def load_error(self):
        with self._lock:
            self._ensure_loaded()
            return self._load_error

    def _ensure_loaded(self) -> None:
        if not self._loaded:
            self._items = self._read()
            # 읽기 오류는 캐시하지 않는다(권한을 고치면 다음 호출에 읽힌다)
            self._loaded = self._load_error != "unreadable"
            if getattr(self, "_reissued", False):
                # v2.767(점검 R2-B5-4): 새로 발급한 id 를 곧바로 저장한다 — 안 그러면 재기동마다 다른 id 가 붙어
                # 그 바로가기의 점검 이력이 끊긴다. 저장이 실패해도 읽기는 계속한다(다음 저장 때 다시 기록).
                self._reissued = False
                try:
                    self._write(self._items)
                except Exception:  # noqa: BLE001 — 읽기 경로를 쓰기 실패로 막지 않는다
                    pass

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

        def flag(key, default):
            # 59회차: 불리언 · 0/1 · 'true'/'false' 는 그 뜻대로. 그 밖의 값은 — 화면 · API 저장(추가 · 수정)이면 400(조용히 켜지 않는다),
            #   가져오기 · 저장 파일 · 기본 목록(keep_id)이면 예전 규칙 bool(값) 그대로(행을 버리지 않는다 — 다른 도구가 만든 파일의 링크를 잃지 않게).
            if key not in data:
                return bool(base.get(key, default))
            ok, value = _parse_flag(data[key])
            if ok:
                return value
            if keep_id:
                return bool(data[key])
            if data[key] is None:
                return bool(base.get(key, default))
            raise ValidationError(f"{key} 는 true 또는 false 여야 합니다.")

        given_id = str(data.get("id") or base.get("id") or "") if keep_id else base.get("id", "")
        if keep_id and not ID_RE.fullmatch(given_id):
            given_id = ""   # 아래에서 새 id 를 발급한다(R2-B5-4)
        item = {
            "id": given_id,
            "name": name,
            "url": url,
            "category": self._clean_category(data.get("category", base.get("category"))),
            "icon": _clean_text(data.get("icon", base.get("icon", "🔗")), limit=8, default="🔗"),
            "description": _clean_text(
                data.get("description", base.get("description", "")), limit=240),
            "tags": _clean_tags(data.get("tags", base.get("tags", []))),
            "datacenterId": self._clean_datacenter_id(
                data.get("datacenterId", base.get("datacenterId"))),
            "isFavorite": flag("isFavorite", False),
            # 사용/중지(v2.227) — 등록만 해 두고 화면·상태점검에서 빼는 상태. 기존 데이터/가져오기
            # 파일에 필드가 없으면 '사용'(True) — 업그레이드 직후 전 링크가 사라지는 사고 방지.
            "enabled": flag("enabled", True),
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
            self._ensure_writable()
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
            self._ensure_writable()
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

    def reassign_category(self, from_id: str, to_id: str) -> int:
        """카테고리 삭제 시 그 분류를 쓰던 바로가기를 옮긴다. 옮긴 개수를 돌려준다.

        옮기지 않으면 링크가 '없는 카테고리'에 묶여 대시보드 칩 어디에도 안 잡힌다.
        """
        with self._lock:
            self._ensure_loaded()
            if self._load_error:
                return 0   # 47회차 #4: 못 읽는 동안에는 옮기지 않는다(다른 저장소 작업을 막지 않게 — 쓸 수 없는 파일)
            moved = 0
            for item in self._items:
                if item["category"] == from_id:
                    item["category"] = to_id
                    item["updatedAt"] = _now_iso()
                    moved += 1
            if moved:
                self._write(self._items)
            return moved

    def reassign_missing_datacenters(self, valid_ids) -> int:
        """v2.760(점검 B-07): 없는 데이터센터를 가리키는 바로가기를 '전체(all)'로 정리한다(삭제·기본값 복원 후처리).

        정리하지 않으면 그 링크는 데이터센터 상세의 '이 사이트' 에도 '공통' 에도 잡히지 않는다
        (카테고리 삭제의 reassign_category 와 같은 이유).
        """
        valid = set(valid_ids or ())
        with self._lock:
            self._ensure_loaded()
            if self._load_error:
                return 0   # 47회차 #4: 못 읽는 동안에는 옮기지 않는다(다른 저장소 작업을 막지 않게 — 쓸 수 없는 파일)
            moved = 0
            for item in self._items:
                dc = item.get("datacenterId") or "all"
                if dc != "all" and dc not in valid:
                    item["datacenterId"] = "all"
                    item["updatedAt"] = _now_iso()
                    moved += 1
            if moved:
                self._write(self._items)
            return moved

    def reassign_missing(self, valid_ids, to_id: str) -> int:
        """유효 목록에 없는 카테고리를 전부 기본값으로 정리한다(기본값 복원 후처리)."""
        with self._lock:
            self._ensure_loaded()
            if self._load_error:
                return 0   # 47회차 #4: 못 읽는 동안에는 옮기지 않는다(다른 저장소 작업을 막지 않게 — 쓸 수 없는 파일)
            moved = 0
            for item in self._items:
                if item["category"] not in valid_ids:
                    item["category"] = to_id
                    item["updatedAt"] = _now_iso()
                    moved += 1
            if moved:
                self._write(self._items)
            return moved

    def move(self, shortcut_id: str, delta: int):
        """표시 순서를 한 칸 위/아래로 옮긴다.

        대시보드는 저장된 배열 순서 그대로 그린다 — 정렬 기준 필드를 따로 두면
        가져오기/복원 때 그 필드만 어긋나 순서가 뒤섞인다. 배열 자체를 진실의
        원천으로 두고 여기서만 바꾼다.
        """
        with self._lock:
            self._ensure_writable()
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
            self._ensure_writable()
            remaining = [item for item in self._items if item["id"] != shortcut_id]
            if len(remaining) == len(self._items):
                return False
            self._items = remaining
            self._write(self._items)
            return True

    def reset(self) -> list:
        with self._lock:
            self._ensure_writable()
            self._items = [item for item in (self._sanitize(entry, keep_id=True)
                                             for entry in default_shortcuts()) if item]
            self._loaded = True
            self._write(self._items)
            return [dict(item) for item in self._items]

    def append_many(self, entries) -> tuple:
        """CSV 가져오기(덧붙이기) — 유효한 행만 뒤에 추가하고 (목록, 추가수, 건너뛴수).

        **같은 URL 이 이미 있으면 건너뛴다**. 같은 파일을 두 번 올렸을 때 목록이 두 배가 되면
        사용자는 수백 개를 손으로 지워야 한다.
        """
        if not isinstance(entries, list):
            raise ValidationError("가져오기 데이터가 올바르지 않습니다.")
        with self._lock:
            self._ensure_writable()
            existing_urls = {item["url"].lower() for item in self._items}
            added, skipped = 0, 0
            for entry in entries:
                if len(self._items) >= MAX_SHORTCUTS:
                    skipped += 1
                    continue
                payload = dict(entry) if isinstance(entry, dict) else {}
                payload.pop("id", None)
                payload.setdefault("createdViaSettings", True)
                item = self._sanitize(payload, keep_id=True)   # 잘못된 행은 예외 대신 폐기
                if not item:
                    skipped += 1
                    continue
                if item["url"].lower() in existing_urls:
                    skipped += 1
                    continue
                item["id"] = "sc-" + uuid.uuid4().hex[:12]
                existing_urls.add(item["url"].lower())
                self._items.append(item)
                added += 1
            if added:
                self._write(self._items)
            return [dict(item) for item in self._items], added, skipped

    def diagnose(self, entry) -> str | None:
        """가져오기 행이 폐기되는 이유(v2.221) — _sanitize(keep_id=True)는 잘못된 행을 조용히
        None 으로 버리므로, 사용자에게 보여줄 사유를 같은 규칙으로 진단한다. 정상이면 None."""
        if not isinstance(entry, dict):
            return "JSON 객체({...})가 아닙니다."
        if not _clean_text(entry.get("name", ""), limit=120):
            return "이름(name)이 비어 있습니다."
        try:
            normalize_url(entry.get("url", ""))
        except ValidationError as exc:
            return f"URL 오류: {exc}"
        return None

    def replace_all(self, entries) -> list:
        """JSON 가져오기 — 유효한 항목만 남기고 통째로 교체한다."""
        if not isinstance(entries, list):
            raise ValidationError("가져오기 파일은 바로가기 목록(JSON 배열)이어야 합니다.")
        if len(entries) > MAX_SHORTCUTS:
            raise ValidationError(f"한 번에 {MAX_SHORTCUTS}개를 넘길 수 없습니다.")
        pairs = []
        for entry in entries:
            item = self._sanitize(entry, keep_id=True)
            if item:
                pairs.append((item, isinstance(entry, dict) and bool(str(entry.get("id") or "").strip())))
        if not pairs:
            raise ValidationError("가져올 수 있는 유효한 바로가기가 없습니다(이름·URL 확인).")
        with self._lock:
            # 46회차 H3(재현): id 가 없는 항목(CSV 는 id 열이 없다)은 URL 이 같은 기존 바로가기의 id 를 이어받는다(한 URL 에 한 번) —
            #   예전에는 내보낸 CSV 를 그대로 '교체' 해도 전부 새 id 라 점검 이력 · 알림 기준점이 끊겼다(JSON 은 id 를 지켰다).
            self._ensure_writable()
            prior = {}
            for old in self._items:
                prior.setdefault(str(old.get("url") or "").lower(), old.get("id"))
            seen = set()
            unique = []
            for item, had_id in pairs:
                if not had_id:
                    inherit = prior.pop(str(item.get("url") or "").lower(), None)
                    if inherit and inherit not in seen:
                        item["id"] = inherit
                if item["id"] in seen:
                    item["id"] = "sc-" + uuid.uuid4().hex[:12]
                seen.add(item["id"])
                unique.append(item)
            self._items = unique
            self._loaded = True
            self._write(self._items)
            return [dict(item) for item in self._items]
