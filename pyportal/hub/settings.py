"""포탈 동작 설정(`settings.json`) — 백업 주기·보관 수량, 링크 자동 점검 주기.

값은 화면(설정 탭)에서 바꾸고 즉시 반영된다. 스케줄러는 매 루프마다 이 저장소를 다시
읽으므로 재시작이 필요 없다.
"""

from __future__ import annotations

import threading

from .jsonfile import load_error_text, read_json_state, write_json

# 백업 주기·점검 주기는 화면에서 고르는 값이라 허용 목록을 서버에서도 강제한다.
BACKUP_INTERVAL_CHOICES = (30, 60, 180, 360, 720, 1440, 10080)          # 분
HEALTH_INTERVAL_CHOICES = (1, 5, 10, 15, 30, 60, 180, 360, 720, 1440)   # 분
HEALTH_METHODS = ("port", "http")                                       # 가동 판정 기준

DEFAULTS = {
    "backup": {
        "enabled": True,
        "intervalMinutes": 1440,   # 하루 1회
        "keep": 14,                # 보관 수량
    },
    "health": {
        "autoEnabled": True,
        "intervalMinutes": 5,      # 5분 차트를 그리려면 최소 이 정도 해상도가 필요하다
        # 가동 판정 기준. port = TCP 연결 성공 여부(기본), http = HTTP 상태코드.
        # 사내 서비스는 로그인 리다이렉트·401/403 을 정상적으로 돌려주므로, HTTP 상태로
        # 보면 살아 있는 서비스가 계속 '확인 필요'로 뜬다.
        "method": "port",
    },
    "display": {
        # 화면(상단 칩·센터 현황·지도)에 표시할 데이터센터 수. 0 = 전체.
        # 등록 순서대로 앞에서 N개만 보이며, 설정 화면의 편집 목록에는 항상 전부 나온다.
        "datacenterLimit": 0,
    },
    "notify": {
        # 상태 '전환' 웹훅 알림. 기본은 꺼짐 — 외부로 나가는 요청이므로 관리자가 켜야 한다.
        "enabled": False,
        "webhookUrl": "",
        # 연속 실패가 이 횟수 이상일 때만 '장애'로 인정한다(일시적 1회 실패 흡수).
        "failThreshold": 2,
        # 같은 링크의 알림 최소 간격(분) — 플래핑 억제.
        "minIntervalMinutes": 10,
    },
}


MAX_DC_LIMIT = 300

SECTIONS = ("backup", "health", "display", "notify")


def _safe_webhook(value) -> str:
    """웹훅 URL 은 http/https 만 허용한다.

    저장 URL 을 그대로 서버가 요청하므로 `file:`·`javascript:` 같은 스킴을 받아 두면
    저장 시점이 아니라 전송 시점에 엉뚱한 동작을 하게 된다(허브 SSRF 규칙과 동일).
    """
    text = str(value or "").strip()
    if not text:
        return ""
    if not text.lower().startswith(("http://", "https://")):
        return ""
    return text[:2048]


def _clamp_int(value, low, high, default):
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        # v2.762(H5): json 은 1e999·Infinity 를 float inf 로 읽는다 — int(inf) 는 OverflowError 라
        # 한 칸 때문에 설정 전체를 못 읽던 B-08 과 같은 증상이 남아 있었다.
        return default
    return max(low, min(high, number))


def _clamp_choice(value, choices, default):
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        # v2.762(H5): json 은 1e999·Infinity 를 float inf 로 읽는다 — int(inf) 는 OverflowError 라
        # 한 칸 때문에 설정 전체를 못 읽던 B-08 과 같은 증상이 남아 있었다.
        return default
    return number if number in choices else default


class SettingsStore:
    def __init__(self, path):
        self._path = path
        self._lock = threading.RLock()
        self._data = None
        self._load_error = None

    def _load(self):
        if self._data is None:
            # 46회차 H1(재현): 손상 · 읽기 오류를 표지로 든다 — 예전에는 조용히 기본값(보관 14개 · 알림 꺼짐)으로 돌아, 다음 백업이
            #   관리자가 정한 보관 수량(예: 50)을 무시하고 오래된 백업을 되돌릴 수 없게 지웠다. 읽기 오류는 캐시하지 않는다(권한을 고치면 다음 호출에 읽힌다).
            raw, state = read_json_state(self._path, expect=dict, quiet=self._load_error == "unreadable")
            self._load_error = state if state in ("corrupt", "unreadable") else None
            if state == "unreadable":
                return self._normalize({})
            self._data = self._normalize(raw or {})
        return self._data

    def load_error(self):
        """None · 'corrupt' · 'unreadable' — 이 동안 백업 정리를 멈추고(backup._prune_locked) 화면에 표지를 싣는다."""
        with self._lock:
            self._load()
            return self._load_error

    @staticmethod
    def _normalize(raw):
        backup = raw.get("backup") if isinstance(raw.get("backup"), dict) else {}
        health = raw.get("health") if isinstance(raw.get("health"), dict) else {}
        display = raw.get("display") if isinstance(raw.get("display"), dict) else {}
        notify = raw.get("notify") if isinstance(raw.get("notify"), dict) else {}
        return {
            "backup": {
                "enabled": bool(backup.get("enabled", DEFAULTS["backup"]["enabled"])),
                "intervalMinutes": _clamp_choice(backup.get("intervalMinutes"),
                                                 BACKUP_INTERVAL_CHOICES,
                                                 DEFAULTS["backup"]["intervalMinutes"]),
                # v2.760(점검 B-08): 다른 칸과 같은 _clamp_int — int() 를 그대로 쓰면 'abc'·'7.5' 한 칸 때문에
                #   설정 전체를 읽지 못해 자동 백업·자동 점검이 매 주기 실패했다.
                "keep": _clamp_int(backup.get("keep"), 1, 200, DEFAULTS["backup"]["keep"]),
            },
            "health": {
                "autoEnabled": bool(health.get("autoEnabled", DEFAULTS["health"]["autoEnabled"])),
                "intervalMinutes": _clamp_choice(health.get("intervalMinutes"),
                                                 HEALTH_INTERVAL_CHOICES,
                                                 DEFAULTS["health"]["intervalMinutes"]),
                "method": (health.get("method") if health.get("method") in HEALTH_METHODS
                           else DEFAULTS["health"]["method"]),
            },
            "display": {
                "datacenterLimit": _clamp_int(display.get("datacenterLimit"), 0, MAX_DC_LIMIT,
                                              DEFAULTS["display"]["datacenterLimit"]),
            },
            "notify": {
                "enabled": bool(notify.get("enabled", DEFAULTS["notify"]["enabled"])),
                "webhookUrl": _safe_webhook(notify.get("webhookUrl")),
                "failThreshold": _clamp_int(notify.get("failThreshold"), 1, 10,
                                            DEFAULTS["notify"]["failThreshold"]),
                "minIntervalMinutes": _clamp_int(notify.get("minIntervalMinutes"), 0, 1440,
                                                 DEFAULTS["notify"]["minIntervalMinutes"]),
            },
        }

    def all(self):
        with self._lock:
            data = self._load()
            return {name: dict(data[name]) for name in SECTIONS}

    def section(self, name):
        return self.all()[name]

    def update_section(self, name, values):
        if name not in SECTIONS:
            raise KeyError(name)
        with self._lock:
            data = self._load()
            if self._load_error == "unreadable":
                # 읽지 못한 파일을 기본값 + 이 칸으로 덮어쓰지 않는다(손상은 보존본이 있어 관리자의 새 저장이 복구 경로다)
                raise ValueError(load_error_text("settings.json", "unreadable"))
            merged = dict(data[name])
            if isinstance(values, dict):
                merged.update(values)
            data[name] = self._normalize({name: merged})[name]
            self._data = data
            write_json(self._path, data)
            self._load_error = None
            return dict(data[name])

    def replace(self, values):
        with self._lock:
            self._data = self._normalize(values if isinstance(values, dict) else {})
            write_json(self._path, self._data)
            self._load_error = None
            return self.all()
