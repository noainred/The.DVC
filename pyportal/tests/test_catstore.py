"""카테고리 구성 저장소 — seed · 편집 · 순서 · 삭제 규칙 · 레거시 값 이관."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.catstore import (CategoryStore, DEFAULT_CATEGORY_ID, SEED_CATEGORIES,  # noqa: E402
                          slugify)
from hub.ssrf import ValidationError  # noqa: E402


class CategoryStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "categories.json"
        self.store = CategoryStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_seeds_on_first_load_and_persists(self):
        self.assertEqual(len(self.store.all()), len(SEED_CATEGORIES))
        self.assertTrue(self.path.exists(), "첫 기동에 파일로 굳혀야 재시작해도 같은 목록이다.")

    def test_add_generates_slug_from_label(self):
        created = self.store.add({"label": "Virtualization & Cloud", "color": "cyan"})
        self.assertEqual(created["id"], "virtualization-cloud")
        self.assertEqual(created["color"], "cyan")

    def test_add_korean_only_label_gets_fallback_id(self):
        # 한글 라벨은 슬러그가 비므로 순번 id 를 만들어 준다(빈 id 로 저장되면 안 된다).
        created = self.store.add({"label": "가상화 & 클라우드"})
        self.assertTrue(created["id"])
        self.assertTrue(created["id"].startswith("cat-"))

    def test_unknown_color_falls_back(self):
        # 임의 색상 문자열을 그대로 쓰면 CSS 클래스가 없어 배지가 무색으로 뜬다.
        self.assertEqual(self.store.add({"label": "X", "color": "#ff0000"})["color"], "slate")

    def test_duplicate_id_rejected(self):
        self.store.add({"label": "Backup Tools", "id": "backup-tools"})
        with self.assertRaises(ValidationError):
            self.store.add({"label": "다른 이름", "id": "backup-tools"})

    def test_label_is_required(self):
        with self.assertRaises(ValidationError):
            self.store.add({"label": "   "})

    def test_update_keeps_id_fixed(self):
        updated = self.store.update("monitoring", {"label": "관측", "id": "somethingelse",
                                                   "color": "rose"})
        self.assertEqual(updated["id"], "monitoring", "id 가 바뀌면 바로가기 참조가 끊긴다.")
        self.assertEqual(updated["label"], "관측")

    def test_update_unknown_returns_none(self):
        self.assertIsNone(self.store.update("nope", {"label": "x"}))

    def test_default_category_cannot_be_deleted(self):
        with self.assertRaises(ValidationError):
            self.store.delete(DEFAULT_CATEGORY_ID)

    def test_delete_removes_and_persists(self):
        self.assertTrue(self.store.delete("storage"))
        self.assertNotIn("storage", self.store.ids())
        self.assertFalse(self.store.delete("storage"))

    def test_default_is_restored_when_missing_from_file(self):
        # 기본 카테고리가 사라진 파일을 열면 다시 채운다 — 삭제된 분류의 바로가기가
        # 갈 곳이 없어지는 상황을 막는 복구 경로다.
        self.path.write_text(json.dumps([{"id": "only", "label": "하나", "color": "blue"}]),
                             encoding="utf-8")
        store = CategoryStore(self.path)
        self.assertIn(DEFAULT_CATEGORY_ID, store.ids())

    def test_move_swaps_neighbours(self):
        before = [cat["id"] for cat in self.store.all()]
        moved = self.store.move(before[1], -1)
        self.assertEqual([cat["id"] for cat in moved][:2], [before[1], before[0]])

    def test_move_at_edge_returns_none(self):
        top = self.store.all()[0]["id"]
        self.assertIsNone(self.store.move(top, -1))

    def test_move_unknown_raises(self):
        with self.assertRaises(FileNotFoundError):
            self.store.move("nope", 1)

    def test_resolve_maps_legacy_values(self):
        # v2.215 이전 파일은 "Monitoring & Metrics" 같은 영문 이름을 저장했다.
        self.assertEqual(self.store.resolve("Monitoring & Metrics"), "monitoring")
        self.assertEqual(self.store.resolve("Custom Shortcuts"), DEFAULT_CATEGORY_ID)
        self.assertEqual(self.store.resolve("monitoring"), "monitoring")
        self.assertIsNone(self.store.resolve("없는분류"))
        self.assertIsNone(self.store.resolve(""))

    def test_resolve_after_delete_returns_none(self):
        self.store.delete("storage")
        self.assertIsNone(self.store.resolve("storage"),
                          "삭제된 분류는 유효하지 않다고 답해야 호출부가 기본값으로 옮긴다.")

    def test_reset_restores_seed(self):
        self.store.add({"label": "임시", "id": "temp"})
        self.store.delete("storage")
        self.assertEqual([cat["id"] for cat in self.store.reset()],
                         [cat["id"] for cat in SEED_CATEGORIES])

    def test_slugify_rejects_unusable_values(self):
        self.assertEqual(slugify("Web & Ops"), "web-ops")
        self.assertEqual(slugify("한글만"), "")
        self.assertEqual(slugify("   "), "")


if __name__ == "__main__":
    unittest.main()
