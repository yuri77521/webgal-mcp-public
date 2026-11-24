"""Private per-project asset choices for Creator and Editor. No game writes."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import live2d
from books import books, lookup, manifest
from catalog import check_key, read_index, readable, save, writing


def model_identity(choice):
    live2d = choice.get("Live2D")
    if not isinstance(live2d, dict):
        return None
    return json.dumps(
        [live2d.get("模型入口"), live2d.get("MCP定位")],
        ensure_ascii=False,
        sort_keys=True,
    )


def model_association(target, entries):
    entries = sorted(entries, key=lambda entry: entry[0])
    first = entries[0][1]["Live2D"]
    model = {
        field: first[field]
        for field in ("模型入口", "模型", "入口 revision", "默认前缀", "MCP定位", "验证范围")
        if first.get(field) is not None
    }
    model["关联用途总数"] = len(entries)
    model["关联动作"] = [
        {
            key: value
            for key, value in (
                ("用途", cue),
                ("种类", choice["Live2D"].get("种类")),
                ("调用名", choice["Live2D"].get("调用名")),
                ("工程调用名", choice["Live2D"].get("工程调用名")),
                ("成员", choice["Live2D"].get("成员")),
                ("预览状态", choice["Live2D"].get("预览状态")),
                ("路径", choice.get("路径")),
            )
            if value is not None
        }
        for cue, choice in entries[:5]
    ]
    return {"身份": "Live2D模型", "工程目标": target, "Live2D": model}


def run():
    cli = argparse.ArgumentParser(description=__doc__)
    actions = cli.add_subparsers(dest="action", required=True)
    for action in ("root", "bind", "remember", "recall"):
        command = actions.add_parser(action)
        command.add_argument("project", help="registered project ID")
        if action == "bind":
            command.add_argument("library", type=Path)
        if action in ("remember", "recall"):
            command.add_argument("--scene", required=True, help="saved scene path")
            if action == "remember":
                command.add_argument("--cue", required=True)
            else:
                command.add_argument("--cue")
                command.add_argument("--target")
        if action == "remember":
            command.add_argument("--path", required=True)
            command.add_argument("--target", required=True, help="project-relative target path")
            command.add_argument(
                "--game-selector",
                help="readback 后 Terre 实际可调用的 Live2D 动作或表情名",
            )
    args = cli.parse_args()
    if args.action in ("recall", "remember"):
        scene = args.scene.removeprefix("game/scene/")
        check_key(scene)
        args.scene = "game/scene/" + scene
        if args.target:
            target = args.target.removeprefix("game/")
            check_key(target)
            args.target = "game/" + target
    key = hashlib.sha256(args.project.encode("utf-8")).hexdigest()
    directory = Path.home() / ".webgal-librarian" / "projects" / key
    path = directory / "choices.json"
    if args.action in ("root", "recall"):
        raw = read_index(path)
        if raw is None:
            return {"库根": None}
        data = json.loads(raw)
        result = {"库根": data["库根"]}
        if args.action == "recall":
            cues = data["场景"].get(args.scene, {})
            if args.target:
                by_cue = cues.get(args.cue)
                if by_cue and by_cue["工程目标"] == args.target:
                    result["选材"] = by_cue
                else:
                    choices = [
                        (cue, choice)
                        for cue, choice in cues.items()
                        if choice["工程目标"] == args.target
                    ]
                    models = {}
                    for cue, choice in choices:
                        identity = model_identity(choice)
                        if identity is not None:
                            models.setdefault(identity, []).append((cue, choice))
                    if len(models) == 1:
                        entries = next(iter(models.values()))
                        if len(entries) > 1:
                            result["选材"] = model_association(args.target, entries)
                        else:
                            result["选材"] = entries[0][1]
                    else:
                        unique = {
                            choice["路径"]: choice
                            for _, choice in choices
                        }
                        result["选材"] = (
                            next(iter(unique.values())) if len(unique) == 1 else None
                        )
            elif args.cue:
                result["选材"] = cues.get(args.cue)
            else:
                result["用途总数"] = len(cues)
                result["用途示例"] = sorted(cues)[:5]
        return result
    directory.mkdir(parents=True, exist_ok=True)
    with writing(directory):
        raw = read_index(path)
        data = json.loads(raw) if raw else {"场景": {}}
        if args.action == "bind":
            root = args.library.resolve()
            manifest(root)
            if data.get("库根") and data["库根"] != str(root):
                raise ValueError("该项目已有其他素材库记录，请核对项目与库根")
            data["库根"] = str(root)
        else:
            if "库根" not in data:
                raise ValueError("请先绑定用户指定的库")
            root = Path(data["库根"])
            manifest(root)
            lookup(books(root), args.path)
            choice = {"路径": args.path, "工程目标": args.target}
            if live2d.has_live2d_ref(args.path):
                if args.game_selector is not None:
                    selector = args.game_selector.strip()
                    if (not selector or len(selector) > 512
                            or any(ord(char) < 32 for char in selector)):
                        raise ValueError("--game-selector 须为一行非空调用名")
                state = live2d.load(root)
                status, model, item = live2d.item_status(state, args.path)
                if status not in {"registered", "unregistered"}:
                    raise ValueError(f"所选 Live2D 条目当前为 {status}")
                choice["Live2D"] = {
                    "模型入口": model["modelPath"],
                    "模型": model.get("modelName"),
                    "入口 revision": model["revision"],
                    "种类": item["kind"],
                    "调用名": item["name"],
                    "文件": item["path"],
                    "登记": item["status"],
                    "状态": status,
                    "预览状态": live2d.preview_state(model, item)[0],
                    "验证范围": live2d.PREVIEW_SCOPE,
                }
                if model.get("defaultPrefix"):
                    choice["Live2D"]["默认前缀"] = model["defaultPrefix"]
                if model.get("location"):
                    choice["Live2D"]["MCP定位"] = model["location"]
                if item["kind"] == "motion":
                    choice["Live2D"]["成员"] = item["motionIndex"]
                if args.game_selector is not None:
                    choice["Live2D"]["工程调用名"] = selector
            elif not readable(root, args.path, {}):
                raise ValueError("所选素材已不可读")
            elif args.game_selector is not None:
                raise ValueError("--game-selector 只适用于 Live2D 选材")
            data["场景"].setdefault(args.scene, {})[args.cue] = choice
        save(path, raw, json.dumps(data, ensure_ascii=False, indent=2))
        return {"库根": data["库根"]}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(run(), ensure_ascii=False))
    except (OSError, ValueError) as err:
        sys.exit(str(err))
