"""데이터센터 구성 저장소 — 설정 화면에서 편집 가능한 사이트 목록.

`datacenters.py` 의 28개는 **최초 seed** 일 뿐이고, 실제 운영 값은 `datacenters.json`
으로 관리한다. 사이트가 늘거나 좌표/랙 수가 바뀌면 설정에서 고칠 수 있어야 한다.
"""

from __future__ import annotations

import re
import threading

from .datacenters import DATACENTERS as SEED_DATACENTERS, REGIONS
from .jsonfile import read_json, write_json
from .ssrf import ValidationError

STATUSES = ("operational", "degraded", "maintenance")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
MAX_DATACENTERS = 300


def _text(value, limit, default=""):
    if not isinstance(value, str):
        return default
    cleaned = " ".join(value.split())
    return cleaned[:limit] if cleaned else default


def _number(value, low, high, default):
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    if num != num:                       # NaN
        return default
    return max(low, min(high, num))


class DatacenterStore:
    def __init__(self, path):
        self._path = path
        self._lock = threading.RLock()
        self._items = None

    # ---------- 내부 ----------

    def _load(self):
        if self._items is None:
            raw = read_json(self._path, None, expect=list)
            if raw is None:
                # 첫 기동: 내장 28개로 시작하고 즉시 파일로 굳힌다.
                self._items = [self._clean(dc, keep_id=True) for dc in SEED_DATACENTERS]
                write_json(self._path, self._items)
            else:
                self._items = [dc for dc in (self._clean(entry, keep_id=True) for entry in raw) if dc]
        return self._items

    def _save(self):
        write_json(self._path, self._items)

    def _clean(self, data, *, keep_id=False, existing=None):
        if not isinstance(data, dict):
            if keep_id:
                return None
            raise ValidationError("데이터센터 정보가 올바르지 않습니다.")
        base = dict(existing or {})

        code = _text(data.get("code", base.get("code", "")), 12)
        name = _text(data.get("name", base.get("name", "")), 120)
        if not code or not name:
            if keep_id:
                return None
            raise ValidationError("코드와 이름은 필수입니다.")

        dc_id = _text(data.get("id", base.get("id", "")), 32).lower()
        if not ID_RE.match(dc_id or ""):
            dc_id = re.sub(r"[^a-z0-9-]", "-", code.lower()).strip("-")[:32] or "dc"

        region = data.get("region", base.get("region"))
        status = data.get("status", base.get("status"))
        return {
            "id": dc_id,
            "code": code,
            "name": name,
            "city": _text(data.get("city", base.get("city", "")), 80, default=name),
            "country": _text(data.get("country", base.get("country", "")), 60, default="-"),
            "region": region if region in REGIONS else "APAC",
            "status": status if status in STATUSES else "operational",
            "pue": round(_number(data.get("pue", base.get("pue")), 1.0, 5.0, 1.2), 3),
            "racks": int(_number(data.get("racks", base.get("racks")), 0, 100000, 0)),
            "lat": round(_number(data.get("lat", base.get("lat")), -90, 90, 0.0), 4),
            "lng": round(_number(data.get("lng", base.get("lng")), -180, 180, 0.0), 4),
            "primarySubnet": _text(data.get("primarySubnet", base.get("primarySubnet", "")), 40,
                                   default="-"),
        }

    # ---------- 공개 ----------

    def all(self):
        with self._lock:
            return [dict(dc) for dc in self._load()]

    def ids(self):
        with self._lock:
            return {dc["id"] for dc in self._load()}

    def visible(self, limit=0):
        """화면에 노출할 목록. limit 0(또는 범위 밖)이면 전체.

        편집 화면은 항상 all() 을 쓴다 — 표시 개수를 줄였다고 등록된 사이트를
        수정할 수 없게 되면 안 된다.
        """
        items = self.all()
        try:
            count = int(limit)
        except (TypeError, ValueError):
            return items
        return items[:count] if 0 < count < len(items) else items

    def summary(self, items=None):
        with self._lock:
            items = self._load() if items is None else items
            total = len(items)
            by_region = {region: 0 for region in REGIONS}
            for dc in items:
                by_region[dc["region"]] = by_region.get(dc["region"], 0) + 1
            return {
                "total": total,
                "operational": sum(1 for dc in items if dc["status"] == "operational"),
                "racks": sum(dc["racks"] for dc in items),
                "avgPue": round(sum(dc["pue"] for dc in items) / total, 3) if total else 0.0,
                "byRegion": by_region,
            }

    def add(self, data):
        with self._lock:
            items = self._load()
            if len(items) >= MAX_DATACENTERS:
                raise ValidationError(f"데이터센터는 최대 {MAX_DATACENTERS}개까지 등록할 수 있습니다.")
            item = self._clean(data)
            if any(dc["id"] == item["id"] for dc in items):
                raise ValidationError(f"이미 있는 ID 입니다: {item['id']}")
            items.append(item)
            self._save()
            return dict(item)

    def update(self, dc_id, data):
        with self._lock:
            items = self._load()
            for index, dc in enumerate(items):
                if dc["id"] != dc_id:
                    continue
                payload = dict(data)
                payload["id"] = dc_id          # ID 는 고정(바로가기가 참조하고 있다)
                items[index] = self._clean(payload, existing=dc)
                self._save()
                return dict(items[index])
        return None

    def delete(self, dc_id):
        with self._lock:
            items = self._load()
            remaining = [dc for dc in items if dc["id"] != dc_id]
            if len(remaining) == len(items):
                return False
            self._items = remaining
            self._save()
            return True

    def reset(self):
        with self._lock:
            self._items = [self._clean(dc, keep_id=True) for dc in SEED_DATACENTERS]
            self._save()
            return self.all()
