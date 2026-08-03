"""상태 전환 알림 — 링크가 정상↔장애로 '바뀌는 순간'에만 알린다.

왜 전환에만 알리나: 장애가 지속되는 동안 매 점검마다 알림을 쏘면 5분마다 같은 메시지가
쌓이고, 사람은 곧 알림을 무시하게 된다(알림 피로). 상태가 **바뀐 링크만** 보내야
알림이 의미를 유지한다.

플래핑(정상↔장애를 오가는 링크) 억제:
- 같은 링크의 알림은 최소 간격(기본 10분) 안에 다시 보내지 않는다.
- 연속 실패가 `failThreshold` 회 이상일 때만 '장애'로 인정한다(일시적 1회 실패 무시).

전송은 표준 라이브러리 `urllib` 로 웹훅 POST 만 한다(추가 의존성 없음).
대상 URL 도 사용자가 넣는 값이므로 **SSRF 가드를 통과**시킨다.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

from .ssrf import ValidationError, normalize_url, resolve_and_check

TIMEOUT = 6.0
USER_AGENT = "GlobalDCServiceHub-Notify/1.0"

UP = "healthy"
DOWN_LABEL = {"warning": "확인 필요", "unreachable": "응답 없음", "blocked": "차단됨"}


class Notifier:
    def __init__(self, settings, audit=None, sender=None):
        self._settings = settings
        self._audit = audit
        self._sender = sender or self._post_webhook
        self._lock = threading.RLock()
        self._state = {}      # shortcut_id -> {"status": str, "fails": int, "last_sent": float}

    # ---------- 상태 판정 ----------

    def notify_transitions(self, results, names=None) -> list:
        """점검 결과를 받아 '전환된' 항목만 알린다. 보낸 사건 목록을 돌려준다."""
        cfg = self._settings.section("notify")
        names = names or {}
        events = []

        with self._lock:
            for row in results:
                shortcut_id = row.get("id")
                if not shortcut_id:
                    continue
                entry = self._state.setdefault(shortcut_id,
                                               {"status": None, "fails": 0, "last_sent": 0.0})
                healthy = row.get("status") == UP

                if healthy:
                    entry["fails"] = 0
                    new_status = UP
                else:
                    entry["fails"] += 1
                    # 임계 미만이면 아직 '장애'로 확정하지 않는다(일시적 실패 흡수).
                    if entry["fails"] < max(1, int(cfg.get("failThreshold", 2))):
                        continue
                    new_status = "down"

                if entry["status"] is None:
                    # 첫 관측은 기준점만 잡고 알리지 않는다(기동 직후 폭탄 방지).
                    entry["status"] = new_status
                    continue
                if entry["status"] == new_status:
                    continue

                entry["status"] = new_status
                events.append({
                    "id": shortcut_id,
                    "name": names.get(shortcut_id, shortcut_id),
                    "url": row.get("url", ""),
                    "status": row.get("status", "unknown"),
                    "statusCode": row.get("statusCode", 0),
                    "latencyMs": row.get("latencyMs"),
                    "message": row.get("message", ""),
                    "direction": "recovered" if new_status == UP else "down",
                    "entry": entry,
                })

        if not cfg.get("enabled") or not cfg.get("webhookUrl"):
            for event in events:
                event.pop("entry", None)
            return events

        quiet = max(0, int(cfg.get("minIntervalMinutes", 10))) * 60
        sent = []
        for event in events:
            entry = event.pop("entry")
            if quiet and (time.time() - entry["last_sent"]) < quiet:
                continue         # 플래핑 억제
            entry["last_sent"] = time.time()
            if self._deliver(cfg["webhookUrl"], event):
                sent.append(event)
        return sent

    # ---------- 전송 ----------

    def _deliver(self, url, event) -> bool:
        arrow = "복구" if event["direction"] == "recovered" else "장애"
        text = (f"[서비스 허브] {event['name']} {arrow}\n"
                f"{event['url']}\n"
                f"상태: {DOWN_LABEL.get(event['status'], event['status'])}"
                f"{' · HTTP ' + str(event['statusCode']) if event['statusCode'] else ''}"
                f"{' · ' + str(event['latencyMs']) + 'ms' if event.get('latencyMs') is not None else ''}\n"
                f"{event['message']}")
        payload = {
            "text": text,               # Slack/Mattermost 호환 필드
            "event": event["direction"],
            "name": event["name"],
            "url": event["url"],
            "status": event["status"],
            "statusCode": event["statusCode"],
            "latencyMs": event.get("latencyMs"),
            "message": event["message"],
        }
        try:
            self._sender(url, payload)
            if self._audit:
                self._audit.write("notify.sent", actor="system",
                                  detail={"name": event["name"], "event": event["direction"]})
            return True
        except (ValidationError, urllib.error.URLError, OSError, ValueError) as exc:
            print(f"[notify] 전송 실패({exc})", flush=True)
            if self._audit:
                self._audit.write("notify.failed", actor="system", result="error",
                                  detail={"name": event["name"], "reason": str(exc)[:120]})
            return False

    @staticmethod
    def _post_webhook(url, payload) -> None:
        """웹훅 POST. 대상도 사용자 입력이므로 SSRF 가드를 통과시킨다."""
        target = normalize_url(url)
        _, reason, _ = resolve_and_check(target)
        if reason:
            raise ValidationError(reason)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(target, data=body, method="POST", headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": USER_AGENT,
        })
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            response.read(512)

    # ---------- 진단 ----------

    def test(self, url) -> dict:
        """설정 화면의 [테스트 전송] — 실제 웹훅으로 예시 알림을 한 번 보낸다."""
        sample = {
            "id": "-", "name": "테스트 알림", "url": "https://example.internal/test",
            "status": "unreachable", "statusCode": 0, "latencyMs": None,
            "message": "설정 화면에서 보낸 테스트입니다.", "direction": "down",
        }
        ok = self._deliver(url, sample)
        return {"ok": ok}

    def snapshot(self) -> dict:
        with self._lock:
            return {key: dict(value) for key, value in self._state.items()}
