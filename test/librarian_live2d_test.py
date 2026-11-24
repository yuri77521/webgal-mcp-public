"""Exercise MCP-normalized Live2D catalog ingestion and handoff."""
import hashlib
import json
import os
from pathlib import Path
import posixpath
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "skills/webgal-librarian/scripts"
MODEL = "Live2D/角色/祥子/school_winter-2023/model.json"
ROOT = "Live2D/角色/祥子"
COUNTS = {
    "dependencies": 8,
    "presentDependencies": 7,
    "missingDependencies": 1,
    "invalidDependencies": 0,
    "unverifiedDependencies": 0,
    "motionGroups": 2,
    "motionFiles": 2,
    "registeredExpressions": 1,
    "unregisteredExpressions": 1,
}


class Live2DCatalogTest(unittest.TestCase):
    def setUp(self):
        scratch = TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.home = Path(scratch.name)
        self.lib = self.home / "library"
        self.lib.mkdir()

    def cli(self, script, *args, stdin=None, ok=True):
        result = subprocess.run(
            [sys.executable, "-X", "utf8", str(SCRIPTS / script), *map(str, args)],
            input=stdin,
            capture_output=True,
            encoding="utf-8",
            env={**os.environ, "HOME": str(self.home), "USERPROFILE": str(self.home)},
        )
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result.stderr

    def catalog(self, action, *args, **kw):
        return self.cli("library.py", action, self.lib, *args, **kw)

    def put(self, relative, data=b"fixture"):
        path = self.lib / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def payload(self, *, scan="scan-1", offset=0, next_offset=None, items=None, revision="rev-1"):
        return {
            "schema": "webgal-live2d-catalog/v1",
            "scanId": scan,
            "character": "祥子",
            "modelName": "school_winter-2023",
            "defaultPrefix": "sakiko/",
            "model": {
                "status": "valid",
                "modelPath": MODEL,
                "rootPath": ROOT,
                "format": "cubism2",
                "revision": revision,
                "sourceId": "resource",
                "sourceModelPath": "Live2D/角色/恶之花sakiko/school_winter-2023/model.json",
                "sourceRootPath": "Live2D/角色/恶之花sakiko",
                "counts": dict(COUNTS),
                "issues": [],
            },
            "entryPage": {
                "modelPath": MODEL,
                "rootPath": ROOT,
                "format": "cubism2",
                "revision": revision,
                "query": {},
                "total": 7,
                "offset": offset,
                "limit": 100,
                "nextOffset": next_offset,
                "counts": dict(COUNTS),
                "items": items or [],
            },
            "complete": next_offset is None,
        }

    def ingest(self, payload, ok=True):
        return self.catalog(
            "live2d-ingest", "--input", "-",
            stdin=json.dumps(payload, ensure_ascii=False), ok=ok,
        )

    def motion(self, identifier="motion-bow-0", name="sakiko/bow", **changes):
        relative = changes.get("path", "motions/bow.mtn")
        item = {
            "kind": "motion", "id": identifier, "name": name, "status": "registered",
            "path": relative, "motionGroup": name, "motionIndex": 0,
            "sound": "sound/bow.wav",
            "fingerprint": "a" * 64,
            "rootRelativePath": posixpath.normpath(
                posixpath.join(posixpath.dirname(MODEL), relative)
            ),
        }
        item.update(changes)
        return item

    def expression(self, identifier="expression-cry", name="sakiko/cry01", **changes):
        relative = changes.get("path", "../.mtn_exp/expressions/cry01.exp.json")
        item = {
            "kind": "expression", "id": identifier, "name": name, "status": "registered",
            "path": relative,
            "fingerprint": "b" * 64,
            "rootRelativePath": posixpath.normpath(
                posixpath.join(posixpath.dirname(MODEL), relative)
            ),
        }
        item.update(changes)
        return item

    def dependency(self, identifier="texture-0", name="texture", path="texture_00.png"):
        return {"kind": "dependency", "id": identifier, "name": name, "status": "present",
                "path": path, "fingerprint": None,
                "rootRelativePath": f"{ROOT}/school_winter-2023/{path}"}

    def setUpModel(self):
        self.catalog("init")
        for relative in (
            MODEL, f"{ROOT}/school_winter-2023/motions/bow.mtn",
            f"{ROOT}/school_winter-2023/sound/bow.wav",
            f"{ROOT}/school_winter-2023/texture_00.png",
            f"{ROOT}/.mtn_exp/expressions/cry01.exp.json",
        ):
            self.put(relative)

    def complete_first_pages(self):
        first = self.payload(
            next_offset=4,
            items=[
                self.motion(),
                self.motion("motion-wink-0", "sakiko/wink01",
                            path="motions/wink.mtn", motionGroup="sakiko/wink01"),
                self.expression("expression-wink", "sakiko/wink01",
                                path="../.mtn_exp/expressions/wink01.exp.json"),
                self.dependency(),
            ],
        )
        self.assertEqual(self.ingest(first)["完成"], False)
        second = self.payload(
            offset=4,
            items=[
                self.expression(),
                self.expression("expression-smile", "Smile", status="unregistered",
                                path="../.mtn_exp/expressions/Smile.exp3.json"),
                self.dependency("sound-bow", "sound", "sound/bow.wav"),
            ],
        )
        self.assertEqual(self.ingest(second)["完成"], True)

    def test_paged_ingest_status_prefix_and_same_call_name(self):
        self.setUpModel()
        self.complete_first_pages()
        expressions = self.catalog(
            "search", "--type", "Live2D", "--group", "祥子", "--kind", "expression",
            "--model", "school_winter-2023", "--prefix", "", "--term", "眨眼", "--term", "哭泣",
        )["候选"]
        self.assertEqual(len(expressions), 2)
        self.assertTrue(all(item["种类"] == "expression" for item in expressions))
        same_name = self.catalog("search", "--term", "wink01")["候选"]
        self.assertEqual({item["种类"] for item in same_name}, {"motion", "expression"})
        wink = self.catalog(
            "search", "--kind", "motion", "--prefix", "sakiko/", "--term", "鞠躬"
        )["候选"]
        self.assertEqual([item["调用名"] for item in wink], ["sakiko/bow"])
        loose = ("--kind", "expression", "--status", "unregistered", "--term", "微笑")
        self.assertEqual(self.catalog("search", *loose)["候选"], [])
        unregistered = self.catalog("search", "--prefix", "", *loose)["候选"]
        self.assertEqual(unregistered[0]["调用名"], "Smile")
        self.assertEqual(unregistered[0]["Live2D状态"], "unregistered")
        self.assertEqual(
            self.catalog("search", "--group", "祥子", "--term", "Smile")["候选"], []
        )
        self.assertEqual(
            self.catalog("search", "--group", "祥子", "--prefix", "", "--term", "Smile")[
                "候选"
            ][0]["调用名"],
            "Smile",
        )

    def test_manual_notes_survive_rescan_and_missing_items_are_stale(self):
        self.setUpModel()
        self.complete_first_pages()
        ref = self.catalog(
            "search", "--kind", "expression", "--term", "哭泣"
        )["候选"][0]["路径"]
        self.catalog("set", ref, "描述", "道别时强忍眼泪")
        self.catalog("tag", ref, "离别")
        book = self.lib / "catalog/Live2D/祥子.md"
        with book.open("a", encoding="utf-8") as stream:
            stream.write("\n手写备注不要丢。\n")

        later = self.payload(
            scan="scan-2",
            items=[self.motion(fingerprint="c" * 64), self.dependency()],
        )
        later["entryPage"]["total"] = 2
        self.ingest(later)
        shown = self.catalog("show", "--path", ref)
        self.assertEqual(shown["描述"], "道别时强忍眼泪")
        self.assertIn("离别", shown["标签"])
        self.assertEqual(shown["默认前缀"], "sakiko/")
        self.assertEqual(shown["MCP定位"]["sourceId"], "resource")
        self.assertIn("手写备注不要丢。", book.read_text(encoding="utf-8"))
        self.assertEqual(self.catalog("search", "--term", "哭泣")["候选"], [])
        stale = self.catalog("search", "--status", "stale", "--term", "哭泣")["候选"]
        self.assertEqual(stale[0]["Live2D状态"], "stale")
        self.assertIn(ref, self.catalog("stats", "--list", "missing")["路径"])
        self.assertIn(
            "stale",
            self.catalog(
                "verify-live2d", ref, "--observation", "不应登记的失效条目", ok=False
            ),
        )
        motion_ref = self.catalog(
            "search", "--status", "registered", "--term", "sakiko/bow"
        )["候选"][0]["路径"]
        self.assertEqual(
            self.catalog("show", "--path", motion_ref)["预览状态"], "待复核"
        )

    def test_same_motion_file_keeps_distinct_group_members(self):
        self.setUpModel()
        motion_path = f"{ROOT}/school_winter-2023/motions/tap.motion3.json"
        self.put(motion_path, b"shared motion file")
        fingerprint = hashlib.sha256(b"shared motion file").hexdigest()
        first = self.motion(
            "tap-0", "sakiko/tap",
            path="motions/tap.motion3.json",
            motionGroup="sakiko/tap",
            motionIndex=0,
            sound="sound/tap-a.wav",
            fingerprint=fingerprint,
        )
        second = self.motion(
            "tap-1", "sakiko/tap",
            path="motions/tap.motion3.json",
            motionGroup="sakiko/tap",
            motionIndex=1,
            sound="sound/tap-b.wav",
            fingerprint=fingerprint,
        )
        payload = self.payload(items=[first, second])
        payload["entryPage"]["total"] = 2
        self.ingest(payload)

        members = self.catalog(
            "search", "--kind", "motion", "--prefix", "sakiko/", "--term", "点击"
        )["候选"]
        self.assertEqual(len(members), 2)
        self.assertEqual(len({item["路径"] for item in members}), 2)
        self.assertEqual({item["成员"] for item in members}, {0, 1})
        sounds = {
            self.catalog("show", "--path", item["路径"])["绑定声音"]
            for item in members
        }
        self.assertEqual(sounds, {"sound/tap-a.wav", "sound/tap-b.wav"})

    def test_same_name_unregistered_expressions_use_path_identity(self):
        self.setUpModel()
        first = self.expression(
            "loose-a", "Loose",
            path="../.mtn_exp/expressions/Loose-a.exp3.json",
            status="unregistered",
            rootRelativePath=f"{ROOT}/.mtn_exp/expressions/Loose-a.exp3.json",
        )
        second = self.expression(
            "loose-b", "Loose",
            path="../.mtn_exp/expressions/Loose-b.exp3.json",
            status="unregistered",
            rootRelativePath=f"{ROOT}/.mtn_exp/expressions/Loose-b.exp3.json",
        )
        payload = self.payload(items=[first, second])
        payload["entryPage"]["total"] = 2
        self.ingest(payload)

        loose = self.catalog(
            "search", "--kind", "expression", "--status", "unregistered",
            "--prefix", "", "--term", "Loose",
        )["候选"]
        self.assertEqual(len(loose), 2)
        self.assertEqual(len({item["路径"] for item in loose}), 2)
        self.assertEqual({item["文件"] for item in loose}, {first["path"], second["path"]})

    def test_registered_expression_path_change_preserves_identity_and_notes(self):
        self.setUpModel()
        old_path = f"{ROOT}/.mtn_exp/expressions/cry01.exp.json"
        old_fingerprint = hashlib.sha256(
            (self.lib / old_path).read_bytes()
        ).hexdigest()
        first = self.payload(
            items=[self.expression(fingerprint=old_fingerprint)],
            next_offset=None,
        )
        first["entryPage"]["total"] = 1
        self.ingest(first)
        ref = self.catalog(
            "search", "--kind", "expression", "--term", "哭泣"
        )["候选"][0]["路径"]
        self.catalog(
            "verify-live2d", ref,
            "--observation", "旧表情低头时眼角出现泪光",
        )
        self.catalog("set", ref, "描述", "registered expression hand edit")
        self.catalog("tag", ref, "保留标签")
        book = self.lib / "catalog/Live2D/祥子.md"
        with book.open("a", encoding="utf-8") as stream:
            stream.write("\nregistered expression hand note\n")

        new_relative = "../.mtn_exp/expressions/cry02.exp.json"
        new_library_path = f"{ROOT}/.mtn_exp/expressions/cry02.exp.json"
        self.put(new_library_path, b"same registered expression, new file")
        new_fingerprint = hashlib.sha256(
            (self.lib / new_library_path).read_bytes()
        ).hexdigest()
        changed = self.payload(
            scan="scan-2",
            items=[self.expression(path=new_relative, fingerprint=new_fingerprint)],
            next_offset=None,
        )
        changed["entryPage"]["total"] = 1
        self.ingest(changed)

        self.assertEqual(
            self.catalog(
                "search", "--kind", "expression", "--term", "哭泣"
            )["候选"][0]["路径"],
            ref,
        )
        shown = self.catalog("show", "--path", ref)
        self.assertEqual(shown["文件"], new_relative)
        self.assertEqual(shown["预览状态"], "待复核")
        self.assertEqual(shown["预览观察"], "旧表情低头时眼角出现泪光")
        self.assertEqual(shown["描述"], "registered expression hand edit")
        self.assertIn("保留标签", shown["标签"])
        text = book.read_text(encoding="utf-8")
        self.assertEqual(text.count(f"## {ref}"), 1)
        self.assertIn("registered expression hand note", text)

        reverified = self.catalog(
            "verify-live2d", ref,
            "--observation", "新文件仍会低头含泪",
        )
        self.assertEqual(reverified["预览状态"], "已预览")
        self.assertEqual(reverified["观察文件摘要"], new_fingerprint)

    def test_playback_verification_binds_current_file_and_reopens_after_change(self):
        self.setUpModel()
        expression_path = self.lib / f"{ROOT}/.mtn_exp/expressions/cry01.exp.json"
        first_fingerprint = hashlib.sha256(expression_path.read_bytes()).hexdigest()
        first = self.payload(
            items=[self.expression(fingerprint=first_fingerprint)],
            next_offset=None,
        )
        first["entryPage"]["total"] = 1
        self.ingest(first)
        ref = self.catalog(
            "search", "--kind", "expression", "--term", "哭泣"
        )["候选"][0]["路径"]
        shown = self.catalog("show", "--path", ref)
        self.assertEqual(shown["预览状态"], "未预览")
        self.assertNotIn("预览观察", shown)

        self.catalog("set", ref, "描述", "道别时强忍眼泪")
        self.catalog("tag", ref, "离别")
        book = self.lib / "catalog/Live2D/祥子.md"
        with book.open("a", encoding="utf-8") as stream:
            stream.write("\n这段手注要跨复核保留。\n")

        verified = self.catalog(
            "verify-live2d", ref,
            "--observation", "嘴唇发抖后低头，眼角出现泪光",
        )
        self.assertEqual(verified["预览状态"], "已预览")
        self.assertEqual(verified["入口 revision"], "rev-1")
        self.assertEqual(verified["观察文件摘要"], first_fingerprint)
        self.assertIn("SHA-256", verified["验证范围"])
        self.assertIn("moc", verified["验证范围"])
        self.assertIn("贴图", verified["验证范围"])
        shown = self.catalog("show", "--path", ref)
        self.assertEqual(shown["预览状态"], "已预览")
        self.assertEqual(shown["预览观察"], "嘴唇发抖后低头，眼角出现泪光")
        self.assertEqual(shown["入口 revision"], "rev-1")
        self.assertIn("不含 moc、贴图", shown["验证范围"])
        candidate = self.catalog(
            "search", "--kind", "expression", "--term", "哭泣"
        )["候选"][0]
        self.assertIn("SHA-256", candidate["预览范围"])

        expression_path.write_bytes(b"changed expression")
        second_fingerprint = hashlib.sha256(expression_path.read_bytes()).hexdigest()
        changed = self.payload(
            scan="scan-2",
            items=[self.expression(fingerprint=second_fingerprint)],
            next_offset=None,
        )
        changed["entryPage"]["total"] = 1
        self.ingest(changed)
        shown = self.catalog("show", "--path", ref)
        self.assertEqual(shown["预览状态"], "待复核")
        self.assertIn("动作或表情文件已变化", shown["复核原因"])
        self.assertEqual(shown["预览观察"], "嘴唇发抖后低头，眼角出现泪光")
        self.assertEqual(shown["描述"], "道别时强忍眼泪")
        self.assertIn("离别", shown["标签"])
        self.assertIn("这段手注要跨复核保留。", book.read_text(encoding="utf-8"))

        reverified = self.catalog(
            "verify-live2d", ref,
            "--observation", "新版表情先张嘴吸气，再含泪低头",
        )
        self.assertEqual(reverified["预览状态"], "已预览")
        self.assertEqual(reverified["观察文件摘要"], second_fingerprint)
        self.assertEqual(
            self.catalog("show", "--path", ref)["预览观察"],
            "新版表情先张嘴吸气，再含泪低头",
        )

        expression_path.write_bytes(b"changed without rescan")
        self.assertIn(
            "先重扫",
            self.catalog(
                "verify-live2d", ref,
                "--observation", "不能绑定未重扫的文件", ok=False,
            ),
        )
        invalidated = self.catalog("show", "--path", ref)
        self.assertEqual(invalidated["预览状态"], "待复核")
        self.assertEqual(
            invalidated["预览观察"], "新版表情先张嘴吸气，再含泪低头"
        )

    def test_dependencies_are_excluded_from_asset_scan(self):
        self.setUpModel()
        self.complete_first_pages()
        self.put("立绘/001.png")
        self.assertEqual(self.catalog("scan")["待决定"], 1)
        pending = self.catalog("stats", "--list", "pending")["路径"]
        self.assertEqual(pending, ["立绘/001.png"])
        self.assertEqual(self.catalog("search", "--term", "bow.wav")["候选"], [])
        self.assertEqual(self.catalog("search", "--term", "texture_00")["候选"], [])

    def test_invalid_pages_and_paths_are_rejected_without_catalog_rows(self):
        self.setUpModel()
        escaped = self.payload(
            items=[self.expression(path="../../../../outside.exp3.json")]
        )
        self.assertIn("rootPath", self.ingest(escaped, ok=False))
        incomplete = self.payload(next_offset=2)
        incomplete["entryPage"]["nextOffset"] = None
        self.assertIn("最后一页", self.ingest(incomplete, ok=False))
        mismatch = self.payload(items=[self.motion()])
        mismatch["entryPage"]["revision"] = "other"
        self.assertIn("revision", self.ingest(mismatch, ok=False))
        self.assertFalse((self.lib / "catalog/Live2D/祥子.md").exists())

    def test_model_and_page_metadata_conflicts_are_rejected(self):
        self.setUpModel()
        base = self.payload(items=[self.motion()], next_offset=None)
        base["entryPage"]["total"] = 1

        root_mismatch = json.loads(json.dumps(base))
        root_mismatch["entryPage"]["rootPath"] = f"{ROOT}/other"
        self.assertIn("rootPath", self.ingest(root_mismatch, ok=False))

        format_mismatch = json.loads(json.dumps(base))
        format_mismatch["entryPage"]["format"] = "cubism3"
        self.assertIn("format", self.ingest(format_mismatch, ok=False))

        counts_mismatch = json.loads(json.dumps(base))
        counts_mismatch["entryPage"]["counts"]["motionGroups"] += 1
        self.assertIn("counts", self.ingest(counts_mismatch, ok=False))

        outside_root = json.loads(json.dumps(base))
        outside_root["model"]["rootPath"] = "Live2D/其他角色"
        outside_root["entryPage"]["rootPath"] = "Live2D/其他角色"
        self.assertIn("越出 rootPath", self.ingest(outside_root, ok=False))

        invalid_count = json.loads(json.dumps(base))
        invalid_count["model"]["counts"]["motionGroups"] = -1
        invalid_count["entryPage"]["counts"] = None
        self.assertIn("非负整数", self.ingest(invalid_count, ok=False))

        first_page = self.payload(
            scan="changing-metadata",
            items=[self.motion()],
            next_offset=1,
        )
        first_page["entryPage"]["total"] = 2
        self.ingest(first_page)
        second_page = self.payload(
            scan="changing-metadata",
            offset=1,
            items=[self.dependency()],
        )
        second_page["entryPage"]["total"] = 2
        second_page["model"]["format"] = "cubism3"
        second_page["entryPage"]["format"] = "cubism3"
        self.assertIn("前后不一致", self.ingest(second_page, ok=False))

        self.assertFalse((self.lib / "catalog/Live2D/祥子.md").exists())
        self.assertEqual(self.ingest(base)["完成"], True)

    def test_old_and_single_sided_additive_metadata_remain_compatible(self):
        self.setUpModel()
        page_only = self.payload(items=[self.motion()], next_offset=None)
        page_only["entryPage"]["total"] = 1
        for field in ("rootPath", "format", "counts"):
            page_only["model"].pop(field)
        self.ingest(page_only)
        ref = self.catalog(
            "search", "--kind", "motion", "--term", "鞠躬"
        )["候选"][0]["路径"]
        shown = self.catalog("show", "--path", ref)
        self.assertEqual(shown["格式"], "cubism2")

        model_only = self.payload(
            scan="model-only",
            items=[self.motion()],
            next_offset=None,
        )
        model_only["entryPage"]["total"] = 1
        for field in ("rootPath", "format", "counts"):
            model_only["entryPage"].pop(field)
        self.ingest(model_only)
        self.assertEqual(self.catalog("show", "--path", ref)["格式"], "cubism2")

        legacy = self.payload(
            scan="legacy-input",
            items=[self.motion()],
            next_offset=None,
        )
        legacy["entryPage"]["total"] = 1
        for holder in ("model", "entryPage"):
            for field in ("rootPath", "format", "counts"):
                legacy[holder].pop(field)
        self.ingest(legacy)
        shown = self.catalog("show", "--path", ref)
        self.assertEqual(shown["格式"], "unknown")
        state = json.loads(
            (self.lib / "catalog/Live2D/.webgal-live2d.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(state["models"][MODEL]["rootPath"], "")
        self.assertEqual(state["models"][MODEL]["counts"], {})

        normalized_root = self.payload(
            scan="normalized-root",
            items=[self.motion()],
            next_offset=None,
        )
        normalized_root["entryPage"]["total"] = 1
        normalized_root["model"]["rootPath"] = f"{ROOT}/./"
        normalized_root["entryPage"]["rootPath"] = f"{ROOT}/"
        self.ingest(normalized_root)
        state = json.loads(
            (self.lib / "catalog/Live2D/.webgal-live2d.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(state["models"][MODEL]["rootPath"], ROOT)

    def test_partial_pages_stay_hidden_and_new_scan_restarts_safely(self):
        self.setUpModel()
        first = self.payload(
            scan="interrupted", offset=0, next_offset=2,
            items=[self.motion(), self.dependency()],
        )
        first["entryPage"]["total"] = 3
        self.ingest(first)
        self.assertTrue(self.ingest(first)["重复页"])
        self.assertEqual(self.catalog("search", "--term", "sakiko/bow")["候选"], [])
        self.assertEqual(self.catalog("stats")["Live2D未完成扫描"], 1)
        self.put("立绘/001.png")
        self.assertEqual(self.catalog("scan")["待决定"], 1)

        skipped = self.payload(
            scan="interrupted", offset=3,
            items=[],
        )
        skipped["entryPage"]["total"] = 3
        self.assertIn("不连续", self.ingest(skipped, ok=False))

        restarted = self.payload(
            scan="restarted", offset=0,
            items=[self.expression()],
        )
        restarted["entryPage"]["total"] = 1
        self.assertEqual(self.ingest(restarted)["完成"], True)
        self.assertEqual(
            self.catalog("search", "--term", "哭泣")["候选"][0]["调用名"], "sakiko/cry01"
        )
        self.assertEqual(self.catalog("search", "--term", "sakiko/bow")["候选"], [])

        fake_complete = self.payload(
            scan="fake", offset=0,
            items=[self.motion()],
        )
        fake_complete["entryPage"]["total"] = 10
        self.assertIn("最后一页", self.ingest(fake_complete, ok=False))

    def test_rescan_keeps_old_items_until_full_snapshot_then_marks_missing_stale(self):
        self.setUpModel()
        self.complete_first_pages()
        partial = self.payload(
            scan="rescan", offset=0, next_offset=1,
            items=[self.motion()],
        )
        partial["entryPage"]["total"] = 2
        self.ingest(partial)
        self.assertEqual(
            self.catalog("search", "--term", "哭泣")["候选"][0]["调用名"], "sakiko/cry01"
        )
        final = self.payload(
            scan="rescan", offset=1,
            items=[self.dependency()],
        )
        final["entryPage"]["total"] = 2
        self.ingest(final)
        self.assertEqual(self.catalog("search", "--term", "哭泣")["候选"], [])
        self.assertEqual(
            self.catalog("search", "--status", "stale", "--term", "哭泣")["候选"][0][
                "调用名"
            ],
            "sakiko/cry01",
        )

    def test_project_handoff_records_live2d_identity(self):
        self.setUpModel()
        self.complete_first_pages()
        ref = self.catalog(
            "search", "--kind", "motion", "--term", "鞠躬"
        )["候选"][0]["路径"]

        def project(action, *args):
            return self.cli("project.py", action, "test-game", *args)

        project("bind", self.lib)
        project(
            "remember", "--scene", "start.txt", "--cue", "sakiko",
            "--path", ref, "--target", "figure/祥子/model.json",
        )
        recalled = project("recall", "--scene", "start.txt", "--cue", "sakiko")["选材"]
        self.assertEqual(recalled["路径"], ref)
        self.assertEqual(recalled["工程目标"], "game/figure/祥子/model.json")
        self.assertEqual(recalled["Live2D"]["模型入口"], MODEL)
        self.assertEqual(recalled["Live2D"]["入口 revision"], "rev-1")
        self.assertEqual(recalled["Live2D"]["种类"], "motion")
        self.assertEqual(recalled["Live2D"]["调用名"], "sakiko/bow")
        self.assertEqual(recalled["Live2D"]["成员"], 0)
        self.assertEqual(recalled["Live2D"]["预览状态"], "未预览")
        self.assertIn("不含 moc、贴图", recalled["Live2D"]["验证范围"])
        self.assertNotIn("工程调用名", recalled["Live2D"])

    def test_project_handoff_records_game_alias_and_recalls_by_model_target(self):
        self.setUpModel()
        self.complete_first_pages()
        bow_ref = self.catalog(
            "search", "--kind", "motion", "--term", "鞠躬"
        )["候选"][0]["路径"]
        wink_ref = self.catalog(
            "search", "--kind", "motion", "--term", "sakiko/wink01"
        )["候选"][0]["路径"]

        def project(action, *args):
            return self.cli("project.py", action, "haru-game", *args)

        project("bind", self.lib)
        target = "figure/Haru/model.json"
        project(
            "remember", "--scene", "start.txt", "--cue", "tap-2",
            "--path", bow_ref, "--target", target,
            "--game-selector", "Haru/Tap#2",
        )
        project(
            "remember", "--scene", "start.txt", "--cue", "wink-1",
            "--path", wink_ref, "--target", target,
            "--game-selector", "Haru/Wink#1",
        )

        tap = project(
            "recall", "--scene", "start.txt", "--cue", "tap-2"
        )["选材"]
        self.assertEqual(tap["Live2D"]["调用名"], "sakiko/bow")
        self.assertEqual(tap["Live2D"]["工程调用名"], "Haru/Tap#2")

        association = project(
            "recall", "--scene", "start.txt", "--target", target
        )["选材"]
        self.assertEqual(association["身份"], "Live2D模型")
        self.assertEqual(association["工程目标"], "game/figure/Haru/model.json")
        self.assertEqual(association["Live2D"]["模型入口"], MODEL)
        self.assertIn("不含 moc、贴图", association["Live2D"]["验证范围"])
        self.assertEqual(
            {
                action["用途"]: action["工程调用名"]
                for action in association["Live2D"]["关联动作"]
            },
            {"tap-2": "Haru/Tap#2", "wink-1": "Haru/Wink#1"},
        )

    def test_sync_bridge_pipes_all_pages_without_raw_json_arguments(self):
        self.setUpModel()
        first = self.payload(
            next_offset=2,
            items=[self.motion(), self.dependency()],
        )
        first["entryPage"]["total"] = 3
        second = self.payload(
            offset=2,
            items=[self.expression()],
        )
        second["entryPage"]["total"] = 3
        pages = [
            {"model": first["model"], "entryPage": first["entryPage"]},
            {"model": second["model"], "entryPage": second["entryPage"]},
        ]
        bridge = self.home / "bridge.py"
        bridge.write_text(
            "import sys\n"
            "sys.stdout.reconfigure(encoding='utf-8')\n"
            "sys.stdout.write(" + repr("".join(json.dumps(page, ensure_ascii=False) + "\n"
                                                for page in pages)) + ")\n",
            encoding="utf-8",
        )
        result = self.cli(
            "sync_live2d.py", self.lib,
            "--node", sys.executable,
            "--server", bridge,
            "--config", self.home / "unused-config.json",
            "--source", "resource",
            "--package", ".",
            "--entry", MODEL,
            "--character", "祥子",
            "--model-name", "恶之花",
            "--prefix", "sakiko/",
        )
        self.assertEqual(result["已处理条目"], 3)
        self.assertEqual(
            self.catalog("search", "--group", "祥子", "--term", "哭泣")["候选"][0][
                "调用名"
            ],
            "sakiko/cry01",
        )


if __name__ == "__main__":
    unittest.main()
