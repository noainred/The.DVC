"""상태 전환 알림 — 전환에만 보내기 · 첫 관측 무시 · 임계/플래핑 억제."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.notify import Notifier  # noqa: E402
from hub.settings import DEFAULTS  # noqa: E402


class FakeSettings:
    """SettingsStore 대신 쓰는 최소 구현 — 알림 섹션만 돌려준다."""

    def __init__(self, **overrides):
        self.values = dict(DEFAULTS["notify"])
        self.values.update(overrides)

    def section(self, name):
        assert name == "notify"
        return dict(self.values)


def row(shortcut_id, status="healthy"):
    return {"id": shortcut_id, "url": "https://x.internal/" + shortcut_id, "status": status,
            "statusCode": 200 if status == "healthy" else 0, "latencyMs": 12, "message": ""}


class NotifyTest(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.settings = FakeSettings(enabled=True, webhookUrl="https://hooks.internal/x",
                                     failThreshold=1, minIntervalMinutes=0)
        self.notifier = Notifier(self.settings,
                                 sender=lambda url, payload: self.sent.append((url, payload)))

    def test_first_observation_is_baseline_only(self):
        # 기동 직후 전 링크를 '변경'으로 보고 알림을 쏟아 내면 안 된다.
        self.assertEqual(self.notifier.notify_transitions([row("a", "unreachable")]), [])
        self.assertEqual(self.sent, [])

    def test_transition_down_then_recovered(self):
        self.notifier.notify_transitions([row("a")])                 # 기준점
        events = self.notifier.notify_transitions([row("a", "unreachable")])
        self.assertEqual([event["direction"] for event in events], ["down"])
        events = self.notifier.notify_transitions([row("a")])
        self.assertEqual([event["direction"] for event in events], ["recovered"])
        self.assertEqual(len(self.sent), 2)

    def test_no_alert_while_state_is_unchanged(self):
        self.notifier.notify_transitions([row("a")])
        self.notifier.notify_transitions([row("a", "unreachable")])
        for _ in range(5):
            self.assertEqual(self.notifier.notify_transitions([row("a", "unreachable")]), [])
        self.assertEqual(len(self.sent), 1, "장애가 이어지는 동안 반복 알림은 알림 피로를 만든다.")

    def test_fail_threshold_absorbs_single_failure(self):
        self.settings.values["failThreshold"] = 2
        self.notifier.notify_transitions([row("a")])
        self.assertEqual(self.notifier.notify_transitions([row("a", "warning")]), [])
        events = self.notifier.notify_transitions([row("a", "warning")])
        self.assertEqual([event["direction"] for event in events], ["down"])

    def test_min_interval_suppresses_flapping(self):
        self.settings.values["minIntervalMinutes"] = 60
        self.notifier.notify_transitions([row("a")])
        self.notifier.notify_transitions([row("a", "unreachable")])   # 1회 전송
        self.notifier.notify_transitions([row("a")])                  # 억제됨
        self.assertEqual(len(self.sent), 1)

    def test_disabled_returns_events_without_sending(self):
        self.settings.values["enabled"] = False
        self.notifier.notify_transitions([row("a")])
        events = self.notifier.notify_transitions([row("a", "unreachable")])
        self.assertEqual(len(events), 1)
        self.assertEqual(self.sent, [], "꺼져 있으면 외부로 요청이 나가면 안 된다.")

    def test_payload_is_slack_compatible(self):
        self.notifier.notify_transitions([row("a")])
        self.notifier.notify_transitions([row("a", "unreachable")])
        _, payload = self.sent[0]
        self.assertIn("text", payload)
        self.assertEqual(payload["event"], "down")

    def test_send_failure_does_not_raise(self):
        def boom(url, payload):
            raise OSError("연결 실패")

        notifier = Notifier(self.settings, sender=boom)
        notifier.notify_transitions([row("a")])
        self.assertEqual(notifier.notify_transitions([row("a", "unreachable")]), [],
                         "전송 실패는 점검 주기를 깨지 않고 조용히 삼켜야 한다.")

    def test_rows_without_id_are_ignored(self):
        self.assertEqual(self.notifier.notify_transitions([{"status": "unreachable"}]), [])

    def test_webhook_target_passes_ssrf_guard(self):
        # 실제 전송 경로(_post_webhook)는 루프백을 거부한다 — 사내망 탐침 방지.
        notifier = Notifier(self.settings)
        self.assertFalse(notifier.test("http://127.0.0.1:9/hook")["ok"])


if __name__ == "__main__":
    unittest.main()
