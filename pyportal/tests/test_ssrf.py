"""URL 정규화 + SSRF 가드 회귀 테스트.

'링크 점검'은 서버가 사용자 입력 URL 로 직접 요청을 보내는 기능이라, 이 가드가
느슨해지면 포탈이 내부망 스캐너/메타데이터 인출 도구로 쓰일 수 있다.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.ssrf import ValidationError, normalize_url, resolve_and_check  # noqa: E402


class NormalizeTest(unittest.TestCase):
    def test_adds_https_when_scheme_missing(self):
        self.assertEqual(normalize_url("grafana.internal.dc/d/x"),
                         "https://grafana.internal.dc/d/x")

    def test_keeps_http(self):
        self.assertEqual(normalize_url("http://idrac.internal.dc"), "http://idrac.internal.dc")

    def test_rejects_dangerous_schemes(self):
        for bad in ("javascript:alert(1)", "data:text/html,<script>1</script>",
                    "file:///etc/passwd", "vbscript:msgbox"):
            with self.assertRaises(ValidationError, msg=bad):
                normalize_url(bad)

    def test_rejects_empty_and_hostless(self):
        with self.assertRaises(ValidationError):
            normalize_url("   ")
        with self.assertRaises(ValidationError):
            normalize_url("https:///path-only")

    def test_rejects_absurdly_long_url(self):
        with self.assertRaises(ValidationError):
            normalize_url("https://x.internal/" + ("a" * 2100))

    def test_rejects_invalid_port(self):
        """확정 버그 회귀 방지(2026-08-30) — 잘못된 포트가 헬스체크 전체를 죽였다.

        urlsplit 의 `.port` 는 지연 평가라, 범위 밖(`:99999`)이나 숫자가 아닌(`:8o80`) 포트는
        접근하는 순간 ValueError 를 던진다. 저장 시점에 막지 않아 오타 URL 하나가 저장되면
        resolve_and_check 의 `parts.port` 에서 터져 check_many 의 future.result() 로 전파되고,
        **그 주기의 모든 링크 점검·이력·알림이 중단**됐다(자동 점검은 traceback 만 남기고 조용히
        멈춤 = 모니터링 정지). 사용자에게 보이는 검증 실패로 바꾼다.
        """
        for bad in ("https://grafana.internal.dc:99999/x",
                    "https://grafana.internal.dc:8o80/x",
                    "http://host.internal:-1/"):
            with self.assertRaises(ValidationError, msg=bad):
                normalize_url(bad)

    def test_accepts_valid_explicit_port(self):
        self.assertEqual(normalize_url("https://vc.internal.dc:8443/ui"),
                         "https://vc.internal.dc:8443/ui")

    def test_stored_invalid_port_does_not_raise_in_resolver(self):
        """이미 저장된(구버전에서 통과한) 잘못된 포트도 예외 대신 사유를 돌려줘야 한다.

        저장 시점 검증만 추가하면 **기존에 저장된** 오타 URL 이 업그레이드 후에도 계속 전체
        점검을 죽인다. resolve_and_check 자체가 방어해야 자기 치유가 된다.
        """
        addresses, reason, kind = resolve_and_check("https://grafana.internal.dc:99999/x")
        self.assertEqual(addresses, [])
        self.assertIsNotNone(reason)
        self.assertEqual(kind, "blocked")


class GuardTest(unittest.TestCase):
    def check(self, url, allow_private=True):
        return resolve_and_check(normalize_url(url), allow_private=allow_private)[1]

    def test_blocks_loopback(self):
        self.assertIsNotNone(self.check("http://127.0.0.1:8080/admin"))
        self.assertIsNotNone(self.check("http://[::1]:8080/"))

    def test_blocks_link_local_metadata(self):
        # 클라우드 메타데이터 주소 — 자격증명 인출 경로.
        self.assertIsNotNone(self.check("http://169.254.169.254/latest/meta-data/"))

    def test_blocks_unspecified_and_multicast(self):
        self.assertIsNotNone(self.check("http://0.0.0.0/"))
        self.assertIsNotNone(self.check("http://224.0.0.1/"))

    def test_blocks_decimal_notation_loopback(self):
        # 2130706433 == 127.0.0.1 — 우회 표기도 '해석된 주소' 검사로 걸려야 한다.
        self.assertIsNotNone(self.check("http://2130706433/"))

    def test_blocks_ipv4_mapped_loopback(self):
        self.assertIsNotNone(self.check("http://[::ffff:127.0.0.1]/"))

    def test_allows_rfc1918_intranet(self):
        # 사내 서비스 포탈이 주 대상이므로 사설 대역은 허용해야 한다.
        for host in ("10.20.30.40", "192.168.1.10", "172.16.0.5"):
            self.assertIsNone(self.check("https://" + host + "/portal"), host)

    def test_private_can_be_disabled(self):
        self.assertIsNotNone(self.check("https://10.20.30.40/", allow_private=False))

    def test_unresolvable_host_is_reported_as_unresolved_not_blocked(self):
        addresses, reason, kind = resolve_and_check(normalize_url("https://no-such-host.invalid/"))
        self.assertEqual(addresses, [])
        self.assertIsNotNone(reason)
        # '보안 차단'으로 뭉뚱그리면 운영자가 오타 링크를 정책 문제로 오해한다.
        self.assertEqual(kind, "unresolved")

    def test_policy_block_is_marked_blocked(self):
        _, reason, kind = resolve_and_check(normalize_url("http://127.0.0.1/"))
        self.assertIsNotNone(reason)
        self.assertEqual(kind, "blocked")


if __name__ == "__main__":
    unittest.main()
