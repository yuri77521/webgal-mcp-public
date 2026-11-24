"""Exercise the public catalog and project CLI using isolated, editable libraries."""
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "skills/webgal-librarian/scripts"


class CatalogTest(unittest.TestCase):
    def setUp(self):
        scratch = TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.home = Path(scratch.name)
        self.lib = self.home / "library"
        self.lib.mkdir()

    def cli(self, script, *args, ok=True):
        result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPTS / script), *map(str, args)],
                                capture_output=True, encoding="utf-8",
                                env={**os.environ, "HOME": str(self.home), "USERPROFILE": str(self.home)})
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result.stderr

    def catalog(self, action, *args, **kw):
        return self.cli("library.py", action, self.lib, *args, **kw)

    def media(self, key):
        path = self.lib / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"media")
        return path

    def test_fields_ranking_and_scope(self):
        key = "立绘/朝日/朝日_01.png"
        self.media(key)
        self.media("立绘/其他/其他_01.png")
        self.catalog("scan", "--layout-confirmed")
        self.catalog("set", key, "描述", "想开口又忍住")
        self.catalog("set", key, "标签", "欲言、服装08、姿态01")
        self.catalog("set", key, "来源", "source-only")
        self.catalog("set", key, "授权", "禁止商用 lic-only")
        book = self.lib / "catalog/立绘/朝日.md"
        with book.open("a", encoding="utf-8") as stream:
            stream.write("\nnotes-only\n")
        query = ("--type", "立绘", "--group", "朝日", "--require", "服装08", "--term", "欲言")
        hits = self.catalog("search", *query)["候选"]
        self.assertEqual([r["路径"] for r in hits], [key])
        for probe in ("source-only", "lic-only", "notes-only"):
            self.assertNotIn(probe, str(hits) + str(self.catalog("show", "--path", key)))
            self.assertFalse(self.catalog("search", "--term", probe)["候选"])
        self.assertEqual(self.catalog("search", *query, "--license", "商用")["候选"], [])
        self.assertEqual(self.catalog("search", *query, "--require", "服装99")["候选"], [])
        for option, value, other in (("--source", "source-only", "lic-only"),
                                     ("--license", "禁止商用 lic-only", "source-only")):
            for data in (self.catalog("show", "--path", key, option),
                         self.catalog("search", *query, option, value)):
                self.assertIn(value, str(data))
                self.assertNotIn(other, str(data))
        fallback = self.catalog("search", "--group", "朝日", "--term", "绝无此词", "--fallback", "欲言")
        self.assertEqual([r["路径"] for r in fallback["候选"]], [key])
        self.assertFalse(self.catalog("search", "--group", "其他", "--term", "绝无此词",
                                      "--fallback", "欲言")["候选"])
        before = book.read_bytes()
        self.catalog("scan")
        self.assertEqual(book.read_bytes(), before)

    def test_grouping_pending_missing_and_same_names(self):
        a = "BGM/pack1/song.mp3"
        b = "BGM/pack2/song.mp3"
        self.media(a)
        self.media(b)
        self.media("立绘/001.png")
        self.assertEqual(self.catalog("scan", "--layout-confirmed")["待决定"], 1)
        self.assertEqual(self.catalog("stats", "--list", "pending")["路径"], ["立绘/001.png"])
        self.assertEqual(self.catalog("search", "--type", "立绘")["候选"], [])
        self.catalog("assign", "立绘/001.png", "--type", "立绘", "--group", "新角色")
        self.assertEqual(self.catalog("stats", "--group", "新角色")["已收录"], 1)
        self.catalog("tag", a, "晚归")
        self.assertEqual(self.catalog("search", "--dir", "BGM/pack2", "--term", "晚归")["候选"], [])
        self.assertEqual(self.catalog("search", "--dir", "BGM/pack1", "--term", "晚归")["候选"][0]["路径"], a)
        (self.lib / a).unlink()
        self.assertEqual(self.catalog("scan")["缺失"], 1)
        self.assertFalse(self.catalog("search", "--term", "晚归")["候选"])
        self.media(a)
        self.assertEqual(self.catalog("show", "--path", a)["标签"], "晚归")
        self.assertEqual(self.catalog("stats")["缺失"], 0)

    def test_output_budget_and_growth(self):
        folder = "背景/" + "/".join(["很长的目录名" * 11] * 4)
        keys = [f"{folder}/雨景{i}.png" for i in range(12)]
        for key in keys:
            self.media(key)
        self.catalog("scan", "--layout-confirmed")
        selection = self.catalog("search", "--term", "雨景")
        self.assertLessEqual(len(selection["候选"]), 5)
        self.assertTrue(selection["还有"])
        seen = [item["路径"] for item in selection["候选"]]
        page = selection
        while page["还有"]:
            page = self.catalog("search", "--term", "雨景", "--offset", str(page["下一页"]))
            seen.extend(item["路径"] for item in page["候选"])
        self.assertEqual(sorted(seen), sorted(keys))
        for n in range(300):
            self.media(f"背景/其他/灯{n}.png")
        self.catalog("scan")
        self.assertEqual(selection, self.catalog("search", "--term", "雨景"))
        result = subprocess.check_output([sys.executable, str(SCRIPTS / "library.py"), "search",
                                          str(self.lib), "--term", "雨景"]).decode("utf-8")
        self.assertLessEqual(len(result), 2000)
        self.assertTrue(all((self.lib / hit["路径"]).is_file() for hit in selection["候选"]))

    def test_regroup_keeps_notes_and_rejects_conflicting_format(self):
        key = "BGM/旧曲.mp3"
        self.media(key)
        self.catalog("scan", "--layout-confirmed")
        self.catalog("tag", key, "手写")
        old = self.lib / "catalog/BGM/_通用.md"
        with old.open("a", encoding="utf-8") as stream:
            stream.write("\n保留这段手记。\n")
        self.catalog("assign", key, "--type", "音效", "--group", "片头包")
        self.assertNotIn("手记", old.read_text(encoding="utf-8"))
        self.assertIn("保留这段手记。", (self.lib / "catalog/音效/片头包.md").read_text(encoding="utf-8"))
        self.assertEqual(self.catalog("show", "--path", key)["类型"], "音效")
        self.assertEqual(self.catalog("search", "--type", "BGM")["候选"], [])
        self.assertEqual(self.catalog("scan")["新增"], 0)
        self.assertIn("不符", self.catalog("assign", key, "--type", "立绘", "--group", "人", ok=False))
        self.assertEqual(self.catalog("recover")["恢复"], 0)

    def test_interrupted_regroup_resumes_without_overwriting_hand_edits(self):
        # Interrupt the real two-book change after the destination is durable.
        sys.path.insert(0, str(SCRIPTS))
        try:
            import books
        finally:
            sys.path.remove(str(SCRIPTS))
        key = "BGM/signal.wav"
        self.media(key)
        self.catalog("scan", "--layout-confirmed")
        old = self.lib / "catalog/BGM/_通用.md"
        old_bytes = old.read_bytes()
        real_save = books.save

        def interrupt(path, original, text):
            if path == old:
                raise OSError("simulated interruption")
            real_save(path, original, text)

        with patch.object(books, "save", interrupt), self.assertRaises(OSError):
            books.assign(self.lib, books.books(self.lib), key, "音效", "拟音")
        self.assertIn("未完成", self.catalog("search", ok=False))
        old.write_bytes(old_bytes + b"\nmanual edit\n")
        self.assertIn("手改", self.catalog("recover", ok=False))
        self.assertIn(b"manual edit", old.read_bytes())
        old.write_bytes(old_bytes)
        self.assertEqual(self.catalog("recover")["恢复"], 1)
        self.assertEqual(self.catalog("stats")["已收录"], 1)
        self.assertEqual(self.catalog("show", "--path", key)["类型"], "音效")

    def test_legacy_and_conflicting_books_preserved(self):
        index = self.lib / "INDEX.md"
        index.write_bytes(b"# v1 manual records")
        self.assertIn("格式", self.catalog("scan", "--layout-confirmed", ok=False))
        self.assertEqual(index.read_bytes(), b"# v1 manual records")
        index.unlink()
        self.media("背景/教室.png")
        self.catalog("scan", "--layout-confirmed")
        p = next(self.lib.glob("catalog/背景/*.md"))
        duplicate = p.with_name("重复.md")
        duplicate.write_bytes(p.read_bytes())
        self.assertIn("重复", self.catalog("scan", ok=False))
        self.assertEqual(duplicate.read_bytes(), p.read_bytes())

    def test_project_handoff_across_processes(self):
        key = "背景/教室.png"
        self.media(key)
        self.catalog("scan", "--layout-confirmed")
        def project(action, *args):
            return self.cli("project.py", action, "test-game", *args)
        self.assertIsNone(project("root")["库根"])
        project("bind", self.lib)
        self.media("立绘/001.png")
        self.assertIn("找不到", self.cli("project.py", "remember", "test-game", "--scene", "start.txt",
                                     "--cue", "人", "--path", "立绘/001.png",
                                     "--target", "figure/001.png", ok=False))
        scene = "game/scene/start.txt"
        target = "game/background/class.png"
        project("remember", "--scene", scene, "--cue", "bg", "--path", key, "--target", target)
        self.assertEqual(project("recall", "--scene", "start.txt", "--target", "background/class.png"),
                         {"库根": str(self.lib.resolve()), "选材": {"路径": key, "工程目标": target}})
        self.assertEqual(project("recall", "--scene", scene, "--cue", "bg")["选材"]["路径"], key)
        self.assertEqual(project("recall", "--scene", scene)["用途示例"], ["bg"])
        self.assertIsNone(project("recall", "--scene", scene, "--cue", "BGM")["选材"])
        self.assertIsNone(self.cli("project.py", "root", "unrelated")["库根"])


if __name__ == "__main__":
    unittest.main()
