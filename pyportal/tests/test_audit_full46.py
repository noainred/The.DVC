"""전체 점검 46회차(서비스 허브 심화) 회귀.

H1 settings.json 손상 · 읽기 오류 동안 기본값(보관 14개)으로 오래된 백업을 지우지 않는다 · 표지
H2 categories.json · datacenters.json 손상 · 읽기 오류면 seed 를 굳히지 않고 바로가기의 분류 · 센터 값을 바꾸지 않는다
H3 CSV '교체' 가져오기는 URL 이 같은 기존 바로가기의 id 를 이어받는다(점검 이력이 이어진다)
"""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.app import AppContext  # noqa: E402
from hub.csvio import export_csv, parse_csv  # noqa: E402
from hub.ssrf import ValidationError  # noqa: E402


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()


class SettingsLoadErrorTest(_Base):
    """H1: 손상된 settings.json 으로 재기동해도 보관 수량(50) 밖 백업을 지우지 않는다."""

    def _seed_backups(self, ctx, count):
        first = ctx.backups.create(reason="manual")["name"]
        src = self.base / "backups" / first
        for i in range(count - 1):
            shutil.copy(src, self.base / "backups" / f"backup-20200101-{i:06d}-manual.json")
        return len(ctx.backups.list())

    def test_corrupt_settings_do_not_prune_with_default_keep(self):
        ctx = AppContext(self.base, start_workers=False)
        ctx.settings.update_section("backup", {"keep": 50})
        before = self._seed_backups(ctx, 30)
        self.assertEqual(before, 30)
        ctx.close()
        (self.base / "settings.json").write_text("{\"backup\": {\"keep\": 5", encoding="utf-8")
        ctx2 = AppContext(self.base, start_workers=False)
        self.assertEqual(ctx2.settings.load_error(), "corrupt")
        ctx2.backups.create(reason="auto")
        self.assertGreaterEqual(len(ctx2.backups.list()), 30, "기본 보관 14개로 지우면 안 된다")
        self.assertEqual(ctx2.backups.status()["settingsLoadError"], "corrupt")
        ctx2.close()
        # 재기동해도(손상 보존본만 남음) '첫 기동' 으로 보지 않는다
        ctx3 = AppContext(self.base, start_workers=False)
        self.assertEqual(ctx3.settings.load_error(), "corrupt")
        # 관리자가 다시 저장하면 표지가 풀리고 정리가 다시 동작한다
        ctx3.settings.update_section("backup", {"keep": 20})
        self.assertIsNone(ctx3.settings.load_error())
        ctx3.backups.create(reason="manual")
        self.assertLessEqual(len(ctx3.backups.list()), 20)
        ctx3.close()

    def test_unreadable_settings_are_not_moved_and_not_overwritten(self):
        ctx = AppContext(self.base, start_workers=False)
        ctx.settings.update_section("backup", {"keep": 50})
        ctx.close()
        real = Path.read_text

        def deny(self_path, *a, **k):
            if self_path.name == "settings.json":
                raise PermissionError(13, "Permission denied")
            return real(self_path, *a, **k)

        with mock.patch.object(Path, "read_text", deny):
            ctx2 = AppContext(self.base, start_workers=False)
            self.assertEqual(ctx2.settings.load_error(), "unreadable")
            with self.assertRaises(ValueError):
                ctx2.settings.update_section("notify", {"enabled": True})
            ctx2.close()
        self.assertEqual(list(self.base.glob("settings.json.corrupt.*")), [], "읽기 오류는 손상이 아니다(옮기지 않는다)")
        self.assertEqual(json.loads((self.base / "settings.json").read_text())["backup"]["keep"], 50)


class ReferenceStoreLoadErrorTest(_Base):
    """H2: 분류 · 센터 파일이 손상되어도 바로가기의 연결 값을 바꾸지 않고, 샘플 센터를 굳히지 않는다."""

    def test_shortcut_links_survive_corrupt_reference_files(self):
        ctx = AppContext(self.base, start_workers=False)
        ctx.shortcuts.add({"name": "Oracle EM", "url": "https://oem.example.com", "category": "infra", "datacenterId": "nrt-01"})
        ctx.close()
        for name in ("categories.json", "datacenters.json"):
            path = self.base / name
            path.write_text(path.read_text(encoding="utf-8")[:-5], encoding="utf-8")
        ctx2 = AppContext(self.base, start_workers=False)
        self.assertEqual(ctx2.datacenters.load_error(), "corrupt")
        self.assertEqual(ctx2.datacenters.all(), [], "샘플 28곳을 실제처럼 보이지 않는다")
        self.assertFalse((self.base / "datacenters.json").exists(), "seed 를 파일에 굳히지 않는다")
        ctx2.shortcuts.add({"name": "Grafana 2", "url": "https://grafana2.example.com"})
        rows = {row["name"]: row for row in json.loads((self.base / "shortcuts.json").read_text())}
        self.assertEqual((rows["Oracle EM"]["category"], rows["Oracle EM"]["datacenterId"]), ("infra", "nrt-01"))
        with self.assertRaises(ValidationError):
            ctx2.datacenters.add({"code": "WAW", "name": "Warsaw"})
        ctx2.close()
        # 재기동해도 손상 보존본이 있으면 첫 기동으로 보지 않는다
        ctx3 = AppContext(self.base, start_workers=False)
        self.assertEqual(ctx3.datacenters.load_error(), "corrupt")
        self.assertEqual(ctx3.categories.load_error(), "corrupt")
        ctx3.close()

    def test_first_boot_still_seeds(self):
        ctx = AppContext(self.base, start_workers=False)
        self.assertIsNone(ctx.datacenters.load_error())
        self.assertGreater(len(ctx.datacenters.all()), 0)
        self.assertTrue((self.base / "datacenters.json").exists())
        ctx.close()


class CsvReplaceKeepsIdsTest(_Base):
    """H3: 내보낸 CSV 를 그대로 '교체' 로 넣으면 같은 URL 의 id 가 그대로다."""

    def test_csv_replace_round_trip_keeps_ids(self):
        ctx = AppContext(self.base, start_workers=False)
        before = {row["url"].lower(): row["id"] for row in ctx.shortcuts.all()}
        self.assertTrue(before)
        rows = parse_csv(export_csv(ctx.shortcuts.all()))
        after = ctx.shortcuts.replace_all(rows)
        kept = sum(1 for row in after if before.get(row["url"].lower()) == row["id"])
        self.assertEqual(kept, len(after))
        self.assertEqual(len({row["id"] for row in after}), len(after), "id 는 겹치지 않는다")
        ctx.close()


if __name__ == "__main__":
    unittest.main()
