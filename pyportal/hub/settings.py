"""포탈 동작 설정(`settings.json`) — 백업 주기·보관 수량, 링크 자동 점검 주기.

값은 화면(설정 탭)에서 바꾸고 즉시 반영된다. 스케줄러는 매 루프마다 이 저장소를 다시
읽으므로 재시작이 필요 없다.
"""

from __future__ import annotations

import threading

from .jsonfile import read_json, write_json

# 백업 주기·점검 주기는 화면에서 고르는 값이라 허용 목록을 서버에서도 강제한다.
BACKUP_INTERVAL_CHOICES = (30, 60, 180, 360, 720, 1440, 10080)          # 분
HEALTH_INTERVAL_CHOICES = (1, 5, 10, 15, 30, 60, 180, 360, 720, 1440)   # 분

DEFAULTS = {
    "backup": {
        "enabled": True,
        "intervalMinutes": 1440,   # 하루 1회
        "keep": 14,                # 보관 수량
    },
    "health": {
        "autoEnabled": True,
        "intervalMinutes": 5,      # 5분 차트를 그리려면 최소 이 정도 해상도가 필요하다
    },
}


def _clamp_choice(value, choices, default):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return number if number in choices else default


class SettingsStore:
    def __init__(self, path):
        self._path = path
        self._lock = threading.RLock()
        self._data = None

    def _load(self):
        if self._data is None:
            raw = read_json(self._path, {}, expect=dict)
            self._data = self._normalize(raw)
        return self._data

    @staticmethod
    def _normalize(raw):
        backup = raw.get("backup") if isinstance(raw.get("backup"), dict) else {}
        health = raw.get("health") if isinstance(raw.get("health"), dict) else {}
        return {
            "backup": {
                "enabled": bool(backup.get("enabled", DEFAULTS["backup"]["enabled"])),
                "intervalMinutes": _clamp_choice(backup.get("intervalMinutes"),
                                                 BACKUP_INTERVAL_CHOICES,
                                                 DEFAULTS["backup"]["intervalMinutes"]),
                "keep": max(1, min(200, int(backup.get("keep", DEFAULTS["backup"]["keep"]) or 1))),
            },
            "health": {
                "autoEnabled": bool(health.get("autoEnabled", DEFAULTS["health"]["autoEnabled"])),
                "intervalMinutes": _clamp_choice(health.get("intervalMinutes"),
                                                 HEALTH_INTERVAL_CHOICES,
                                                 DEFAULTS["health"]["intervalMinutes"]),
            },
        }

    def all(self):
        with self._lock:
            data = self._load()
            return {"backup": dict(data["backup"]), "health": dict(data["health"])}

    def section(self, name):
        return self.all()[name]

    def update_section(self, name, values):
        if name not in ("backup", "health"):
            raise KeyError(name)
        with self._lock:
            data = self._load()
            merged = dict(data[name])
            if isinstance(values, dict):
                merged.update(values)
            data[name] = self._normalize({name: merged})[name]
            self._data = data
            write_json(self._path, data)
            return dict(data[name])

    def replace(self, values):
        with self._lock:
            self._data = self._normalize(values if isinstance(values, dict) else {})
            write_json(self._path, self._data)
            return self.all()
