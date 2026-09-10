"""로그인 화면 '비밀번호 재설정' 안내 버튼(v2.457) 회귀 고정.

요청은 "노란 자리에 재설정 버튼"이었지만, 로그인 화면은 인증 이전이라 **웹에서 직접 초기화하는
무인증 엔드포인트**는 계정 탈취/DoS 취약점이 된다. 그래서 버튼은 **콘솔 복구 절차를 안내**만 하고
서버를 호출하지 않는다. 이 테스트는 그 계약이 되돌려지지 않게 고정한다:
  · 로그인 모달에 안내 버튼/패널이 있고, 콘솔 복구 명령(`--reset-password`)을 담는다.
  · 안내 토글이 서버 API 를 호출하지 않는다(순수 표시).
  · 서버에 비밀번호를 초기화하는 라우트가 없다(복구는 app.py CLI 로만).
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"


class RecoverButtonTest(unittest.TestCase):
    def test_login_modal_has_recover_guidance(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="login-forgot"', html, "안내 버튼이 없다")
        self.assertIn('id="login-recover"', html, "안내 패널이 없다")
        self.assertIn("--reset-password", html, "콘솔 복구 명령 안내가 없다")
        # 안내 패널은 기본으로 접혀 있어야 한다.
        self.assertRegex(html, r'id="login-recover"[^>]*\shidden')

    def test_toggle_does_not_call_server(self):
        js = (STATIC / "app.js").read_text(encoding="utf-8")
        self.assertIn('"login-forgot"', js, "안내 버튼 배선이 없다")
        # login-forgot 클릭 핸들러 본문을 추출해 네트워크 호출이 없음을 확인한다.
        m = re.search(r'\$\("login-forgot"\)\.addEventListener\("click",\s*function\s*\([^)]*\)\s*\{(.*?)\}\);',
                      js, re.S)
        self.assertIsNotNone(m, "login-forgot 핸들러를 찾지 못했다")
        body = m.group(1)
        self.assertIn("hidden", body, "핸들러가 패널을 토글하지 않는다")
        self.assertNotIn("api(", body, "안내 버튼이 서버를 호출한다 — 무인증 재설정 금지")
        self.assertNotIn("fetch(", body, "안내 버튼이 서버를 호출한다 — 무인증 재설정 금지")

    def test_no_password_reset_route_on_server(self):
        server = (ROOT / "hub" / "server.py").read_text(encoding="utf-8")
        # 라우트 테이블/핸들러 어디에도 비밀번호 초기화 경로가 있으면 안 된다.
        self.assertNotIn("reset-password", server)
        self.assertNotIn("reset_password", server)
        # recover() 는 콘솔 전용(app.py) — 서버 핸들러가 이를 부르면 안 된다.
        self.assertNotIn(".recover(", server, "recover() 가 서버 라우트에서 호출된다 — 콘솔 전용이어야 한다")

    def test_console_recovery_still_exists(self):
        # 안내가 가리키는 콘솔 복구 경로가 실제로 존재해야 한다(안내만 있고 기능이 없으면 안 됨).
        app = (ROOT / "app.py").read_text(encoding="utf-8")
        self.assertIn("--reset-password", app)
        auth = (ROOT / "hub" / "auth.py").read_text(encoding="utf-8")
        self.assertIn("def recover(", auth)


if __name__ == "__main__":
    unittest.main()
