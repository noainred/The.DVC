"""바로가기 저장소 — 정규화·원자적 쓰기·손상 보존 회귀 테스트."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.ssrf import ValidationError  # noqa: E402
from hub.store import ShortcutStore  # noqa: E402


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "shortcuts.json"
        self.store = ShortcutStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_load_seeds_defaults(self):
        items = self.store.all()
        self.assertGreater(len(items), 5)
        self.assertTrue(all(item["url"].startswith("http") for item in items))

    def test_add_requires_name_and_url(self):
        with self.assertRaises(ValidationError):
            self.store.add({"name": "", "url": "https://x.internal"})
        with self.assertRaises(ValidationError):
            self.store.add({"name": "이름만", "url": "   "})

    def test_add_normalizes_and_persists(self):
        created = self.store.add({"name": "  사내 위키 ", "url": "wiki.internal.dc/home",
                                  "tags": "Docs, Wiki, Docs", "category": "존재하지않는분류"})
        self.assertEqual(created["name"], "사내 위키")
        self.assertEqual(created["url"], "https://wiki.internal.dc/home")
        self.assertEqual(created["tags"], ["Docs", "Wiki"])       # 중복 제거
        self.assertEqual(created["category"], "custom")  # 미지의 분류는 기본값으로
        self.assertTrue(created["createdViaSettings"])

        # 새 항목이 목록 맨 앞에 오고 파일에도 반영된다.
        self.assertEqual(self.store.all()[0]["id"], created["id"])
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk[0]["url"], "https://wiki.internal.dc/home")

    def test_reject_non_http_scheme(self):
        # 이 URL 이 저장되면 대시보드의 '바로가기' 클릭이 스크립트 실행 경로가 된다.
        with self.assertRaises(ValidationError):
            self.store.add({"name": "나쁜링크", "url": "javascript:alert(1)"})

    def test_update_and_delete(self):
        created = self.store.add({"name": "임시", "url": "https://tmp.internal.dc"})
        updated = self.store.update(created["id"], {"isFavorite": True, "name": "정식"})
        self.assertTrue(updated["isFavorite"])
        self.assertEqual(updated["name"], "정식")
        self.assertEqual(updated["url"], "https://tmp.internal.dc")  # 미지정 필드는 보존

        self.assertTrue(self.store.delete(created["id"]))
        self.assertFalse(self.store.delete(created["id"]))
        self.assertIsNone(self.store.get(created["id"]))

    def test_unknown_datacenter_falls_back_to_all(self):
        created = self.store.add({"name": "x", "url": "https://x.internal.dc",
                                  "datacenterId": "없는센터-99"})
        self.assertEqual(created["datacenterId"], "all")
        linked = self.store.add({"name": "y", "url": "https://y.internal.dc",
                                 "datacenterId": "icn-01"})
        self.assertEqual(linked["datacenterId"], "icn-01")

    def test_corrupt_file_is_preserved_not_silently_dropped(self):
        self.path.write_text("{이건 JSON 이 아니다", encoding="utf-8")
        store = ShortcutStore(self.path)
        items = store.all()
        self.assertGreater(len(items), 0)  # 기본값으로 복구
        preserved = list(self.path.parent.glob("shortcuts.json.corrupt.*"))
        self.assertEqual(len(preserved), 1,
                         "손상 파일을 보존하지 않으면 다음 저장이 원본을 덮어써 전량 유실된다.")

    def test_replace_all_drops_invalid_entries(self):
        result = self.store.replace_all([
            {"name": "정상", "url": "ok.internal.dc"},
            {"name": "", "url": "https://무명.internal"},      # 이름 없음 → 폐기
            {"name": "스킴불가", "url": "javascript:alert(1)"},  # 스킴 위반 → 폐기
        ])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "정상")

    def test_replace_all_rejects_non_list(self):
        with self.assertRaises(ValidationError):
            self.store.replace_all({"not": "a list"})

    def test_reset_returns_defaults(self):
        self.store.add({"name": "사용자", "url": "https://u.internal.dc"})
        restored = self.store.reset()
        self.assertTrue(all(not item["createdViaSettings"] for item in restored))


if __name__ == "__main__":
    unittest.main()
