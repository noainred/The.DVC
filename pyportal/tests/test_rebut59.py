"""전체 점검 59회차 — 56회차 수정 반증(적대적 재검토) 회귀.

R1 56회차 F2 가 PBKDF2 를 계정 저장소 잠금 밖으로 옮기면서 '계정 사본을 고른 뒤 검증이 끝나기까지' 사이에 비밀번호 변경 · 중지 · 삭제가
   끼어들 수 있게 됐다(재현) — 옛 비밀번호가 '로그인 성공'(감사 login 성공 · 실패 카운터 초기화)을 받았고(발급 토큰은 tokenVersion 으로 즉시 무효),
   역할 변경이 끼면 정상 로그인이 곧바로 죽은 세션이 됐다. 검증 뒤 잠금 안에서 지금 기록을 다시 보고 같은 비밀번호 기록 · 사용 중일 때만 지금 값으로 돌려준다.
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub import auth as auth_mod  # noqa: E402
from hub.app import AppContext  # noqa: E402


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ctx = AppContext(Path(self.tmp.name), start_workers=False)

    def tearDown(self):
        self.ctx.close()
        self.tmp.cleanup()

    def _during_verify(self, action):
        """비밀번호 검증 도중(잠금 밖) action 을 끼워 넣는다 — 경합 창을 결정적으로 재현한다."""
        real = auth_mod.verify_password

        def slow(record, password):
            action()
            return real(record, password)
        return mock.patch.object(auth_mod, "verify_password", side_effect=slow)


class LoginRaceTest(_Base):
    def test_password_change_during_verify_rejects_old_password(self):
        self.ctx.users.add("bob", "viewer", "old-password-1")
        with self._during_verify(lambda: self.ctx.users.set_password("bob", "new-password-2")):
            got = self.ctx.users.authenticate("bob", "old-password-1")
        self.assertIsNone(got, "비밀번호가 바뀐 뒤 옛 비밀번호는 로그인 성공이 아니다(수정 전: 성공 · 토큰은 즉시 무효)")
        # 새 비밀번호는 그대로 된다
        self.assertIsNotNone(self.ctx.users.authenticate("bob", "new-password-2"))

    def test_disable_or_delete_during_verify_rejects(self):
        self.ctx.users.add("carl", "viewer", "carl-password-1")
        self.ctx.users.add("dora", "viewer", "dora-password-1")
        with self._during_verify(lambda: self.ctx.users.update("carl", enabled=False)):
            self.assertIsNone(self.ctx.users.authenticate("carl", "carl-password-1"))
        with self._during_verify(lambda: self.ctx.users.delete("dora")):
            self.assertIsNone(self.ctx.users.authenticate("dora", "dora-password-1"))

    def test_role_change_during_verify_returns_live_session(self):
        self.ctx.users.add("amy", "viewer", "amy-password-1")
        with self._during_verify(lambda: self.ctx.users.update("amy", role="admin")):
            got = self.ctx.users.authenticate("amy", "amy-password-1")
        self.assertIsNotNone(got)
        self.assertEqual(got["role"], "admin")
        session = self.ctx.sessions.create(got)
        self.assertEqual(self.ctx.sessions.resolve(session["token"]),
                         {"username": "amy", "role": "admin"},
                         "정상 비밀번호 로그인이 죽은 세션(옛 tokenVersion)이 되지 않는다")

    def test_wrong_password_and_unknown_user_still_none(self):
        self.ctx.users.add("eve", "viewer", "eve-password-1")
        self.assertIsNone(self.ctx.users.authenticate("eve", "nope-nope-1"))
        self.assertIsNone(self.ctx.users.authenticate("nobody", "nope-nope-1"))
        self.assertEqual(self.ctx.users.authenticate("EVE", "eve-password-1")["username"], "eve",
                         "로그인은 예전처럼 대소문자를 무시한다")


if __name__ == "__main__":
    unittest.main()
