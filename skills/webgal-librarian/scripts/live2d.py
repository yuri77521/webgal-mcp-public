"""Import and query MCP-normalized Live2D entries without parsing model files."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import PurePosixPath, PureWindowsPath
import posixpath
import re
from urllib.parse import quote

from catalog import CATALOG, check_key, linked, read_index, save


SCHEMA = "webgal-live2d-catalog/v1"
STATE_SCHEMA = "webgal-live2d-catalog-state/v1"
MAX_INPUT_BYTES = 2 * 1024 * 1024
MODEL_STATUSES = {"valid", "invalid", "unverified"}
FORMATS = {"cubism2", "cubism3", "unknown"}
ITEM_KINDS = {"motion", "expression", "dependency"}
ITEM_STATUSES = {"registered", "unregistered", "present", "missing", "invalid", "unverified"}
SEARCH_STATUSES = {"available", "registered", "unregistered", "present", "missing",
                   "invalid", "unverified", "stale", "all"}
PREVIEW_UNSEEN = "未预览"
PREVIEW_VERIFIED = "已预览"
PREVIEW_REVIEW = "待复核"
PREVIEW_SCOPE = "仅验证动作/表情文件 SHA-256 与模型入口 revision，不含 moc、贴图、物理或其他依赖"
TAG_HINTS = (
    ("smile", "微笑"),
    ("happy", "开心"),
    ("cry", "哭泣"),
    ("sad", "悲伤"),
    ("angry", "生气"),
    ("surprised", "惊讶"),
    ("wink", "眨眼"),
    ("bow", "鞠躬"),
    ("idle", "待机"),
    ("tap", "点击"),
    ("default", "默认"),
)


def empty_state():
    return {"schema": STATE_SCHEMA, "models": {}}


def load(root):
    raw = read_index(root / "catalog" / "Live2D" / ".webgal-live2d.json")
    if raw is None:
        return empty_state()
    try:
        state = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Live2D 分册状态格式异常，请核对 catalog/Live2D/.webgal-live2d.json") from error
    if (not isinstance(state, dict) or state.get("schema") != STATE_SCHEMA
            or not isinstance(state.get("models"), dict)):
        raise ValueError("Live2D 分册状态版本不符")
    return state


def save_state(root, state):
    path = root / "catalog" / "Live2D" / ".webgal-live2d.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    save(path, read_index(path), json.dumps(state, ensure_ascii=False, indent=2))


def load_payload(source, stream):
    if source == "-":
        raw = stream.read(MAX_INPUT_BYTES + 1)
    else:
        with open(source, "rb") as document:
            raw = document.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Live2D 建档输入超过 2 MiB")
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Live2D 建档输入不是有效 UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise ValueError("Live2D 建档输入必须是 JSON 对象")
    return payload


def _one_line(value, field, limit=1024):
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError(f"{field} 须为 1 到 {limit} 字符的文本")
    if any(ord(char) < 32 for char in value):
        raise ValueError(f"{field} 不能包含控制字符")
    return value


def _character_name(value):
    value = _one_line(value, "character", 255)
    check_key(value)
    if ("/" in value or any(char in '<>:"|?*' for char in value)
            or value.endswith((" ", ".")) or PureWindowsPath(value).is_reserved()):
        raise ValueError("character 须可作为一个分册文件名")
    return value


def _resolve_model_relative(model_path, value, field, root_path=""):
    _one_line(value, field)
    if "\\" in value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise ValueError(f"{field} 须使用库内正斜线相对路径")
    combined = posixpath.normpath(posixpath.join(posixpath.dirname(model_path), value))
    try:
        check_key(combined)
    except ValueError as error:
        raise ValueError(f"{field} 越出素材库") from error
    if root_path:
        boundary = posixpath.normpath(root_path)
        if combined != boundary and not combined.startswith(boundary + "/"):
            raise ValueError(f"{field} 越出 Live2D rootPath")
    return combined


def _entry_ref(model_path, item):
    kind = item["kind"]
    name = quote(item["name"], safe="")
    if kind == "motion":
        return f"{model_path}#motion/{name}/{item['motionIndex']}"
    if kind == "expression" and item["status"] == "unregistered":
        path = hashlib.sha256(item["path"].encode("utf-8")).hexdigest()[:16]
        return f"{model_path}#expression/{name}/{path}"
    return f"{model_path}#{kind}/{name}"


def _item_tags(item):
    searchable = f'{item["name"]} {item["id"]}'.casefold()
    tags = ["动作"] if item["kind"] == "motion" else ["表情"]
    for token, translated in TAG_HINTS:
        if token in searchable and translated not in tags:
            tags.append(translated)
    if item["status"] == "unregistered":
        tags.append("入口未登记")
    return "、".join(tags)


def _item_description(item):
    prefix = "动作" if item["kind"] == "motion" else "表情"
    if item["kind"] == "motion":
        member = item.get("motionIndex")
        detail = f"动作组 {item['motionGroup']} 第 {int(member) + 1} 个成员"
    else:
        detail = f"{prefix} {item['name']}"
    if item["status"] == "unregistered":
        detail += "（入口未登记）"
    return detail


def _optional_format(value, field):
    if value is None:
        return None
    if value not in FORMATS:
        raise ValueError(f"{field} 须为 cubism2、cubism3 或 unknown")
    return value


def _optional_root_path(value, field):
    if value is None:
        return "", False
    if not isinstance(value, str):
        raise ValueError(f"{field} 须为相对路径文本")
    if value == "":
        return "", True
    if (value.startswith("/") or "\\" in value or re.match(r"^[A-Za-z]:", value)
            or any(ord(char) < 32 for char in value) or ".." in value.split("/")):
        raise ValueError(f"{field} 须为库内正斜线相对路径")
    normalized = posixpath.normpath(value)
    if normalized == ".":
        return "", True
    if normalized in ("", "..") or normalized.startswith("../"):
        raise ValueError(f"{field} 越出素材库")
    check_key(normalized)
    return normalized, True


def _optional_counts(value, field):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{field} 须为对象")
    normalized = {}
    for key, count in value.items():
        if (not isinstance(key, str) or not key or len(key) > 128
                or any(ord(char) < 32 for char in key)):
            raise ValueError(f"{field} 含无效计数名")
        if (not isinstance(count, int) or isinstance(count, bool) or count < 0):
            raise ValueError(f"{field}.{key} 须为非负整数")
        normalized[key] = count
    return normalized


def _validate_model(model):
    if not isinstance(model, dict):
        raise ValueError("model 必须是 live2d_model_inspect 返回对象")
    status = model.get("status")
    if status not in MODEL_STATUSES:
        raise ValueError("model.status 无效")
    model_path = _one_line(model.get("modelPath"), "model.modelPath")
    lowered = model_path.lower()
    if not (lowered.endswith("/model.json") or lowered == "model.json"
            or lowered.endswith(".model3.json")):
        raise ValueError("model.modelPath 须指向 Live2D 模型入口")
    check_key(model_path)
    revision = _one_line(model.get("revision"), "model.revision", 256)
    model_format = _optional_format(model.get("format"), "model.format")
    root_path, has_root_path = _optional_root_path(model.get("rootPath"), "model.rootPath")
    model_counts = _optional_counts(model.get("counts"), "model.counts")
    location = {}
    for field in ("sourceId", "sourceModelPath", "sourceRootPath"):
        value = model.get(field)
        if value is None:
            continue
        if field == "sourceRootPath" and value == "":
            location[field] = ""
        else:
            location[field] = _one_line(value, f"model.{field}")
    return (
        status,
        model_path,
        revision,
        model_format,
        root_path,
        has_root_path,
        model_counts,
        location,
    )


def _validate_entry_page(
    page,
    model_path,
    revision,
    model_format,
    model_root_path,
    model_has_root_path,
    model_counts,
):
    if not isinstance(page, dict):
        raise ValueError("entryPage 必须是 live2d_model_entries 返回对象")
    if page.get("modelPath") != model_path:
        raise ValueError("model 与 entryPage 的 modelPath 不一致")
    if page.get("revision") != revision:
        raise ValueError("model 与 entryPage 的 revision 不一致")
    page_root_path, page_has_root_path = _optional_root_path(
        page.get("rootPath"), "entryPage.rootPath"
    )
    if (model_has_root_path and page_has_root_path
            and model_root_path != page_root_path):
        raise ValueError("model 与 entryPage 的 rootPath 不一致")
    root_path = page_root_path if page_has_root_path else model_root_path
    if root_path and model_path != root_path and not model_path.startswith(root_path + "/"):
        raise ValueError("model.modelPath 越出 rootPath")
    page_format = _optional_format(page.get("format"), "entryPage.format")
    if model_format is not None and page_format is not None and model_format != page_format:
        raise ValueError("model 与 entryPage 的 format 不一致")
    model_format = page_format if page_format is not None else model_format
    page_counts = _optional_counts(page.get("counts"), "entryPage.counts")
    if model_counts is not None and page_counts is not None and model_counts != page_counts:
        raise ValueError("model 与 entryPage 的 counts 不一致")
    counts = page_counts if page_counts is not None else model_counts
    items = page.get("items")
    if not isinstance(items, list) or len(items) > 100:
        raise ValueError("entryPage.items 须为不超过 100 项的数组")
    offset = page.get("offset", 0)
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError("entryPage.offset 须为非负整数")
    total = page.get("total")
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        raise ValueError("entryPage.total 须为非负整数")
    if offset + len(items) > total:
        raise ValueError("entryPage 条目范围超过 total")
    normalized = []
    seen = set()
    for number, raw in enumerate(items):
        if not isinstance(raw, dict):
            raise ValueError(f"entryPage.items[{number}] 必须是对象")
        kind = raw.get("kind")
        if kind not in ITEM_KINDS:
            raise ValueError(f"entryPage.items[{number}].kind 无效")
        status = raw.get("status")
        if status not in ITEM_STATUSES:
            raise ValueError(f"entryPage.items[{number}].status 无效")
        identifier = _one_line(raw.get("id"), f"entryPage.items[{number}].id", 512)
        name = _one_line(raw.get("name"), f"entryPage.items[{number}].name", 512)
        relative_path = _one_line(raw.get("path"), f"entryPage.items[{number}].path")
        library_path = _resolve_model_relative(
            model_path, raw.get("path"), f"entryPage.items[{number}].path", root_path
        )
        item = {
            "kind": kind,
            "id": identifier,
            "name": name,
            "path": relative_path,
            "libraryPath": library_path,
            "status": status,
        }
        root_relative = raw.get("rootRelativePath")
        if root_relative is not None:
            root_relative = _one_line(
                root_relative, f"entryPage.items[{number}].rootRelativePath"
            )
            normalized_relative = posixpath.normpath(root_relative)
            if (root_relative.startswith("/") or "\\" in root_relative
                    or normalized_relative == ".." or normalized_relative.startswith("../")):
                raise ValueError(
                    f"entryPage.items[{number}].rootRelativePath 须为相对位置"
                )
            if normalized_relative != library_path:
                raise ValueError(
                    f"entryPage.items[{number}].rootRelativePath 与模型相对路径不一致"
                )
            item["rootRelativePath"] = normalized_relative
        fingerprint = raw.get("fingerprint")
        if fingerprint is not None and (not isinstance(fingerprint, str)
                                        or not re.fullmatch(r"[0-9a-fA-F]{64}", fingerprint)):
            raise ValueError(f"entryPage.items[{number}].fingerprint 须为 SHA-256 或 null")
        item["fingerprint"] = fingerprint
        if kind == "motion":
            group = _one_line(raw.get("motionGroup"), f"entryPage.items[{number}].motionGroup", 256)
            index = raw.get("motionIndex")
            if not isinstance(index, int) or isinstance(index, bool) or index < 0:
                raise ValueError(f"entryPage.items[{number}].motionIndex 无效")
            item.update({"motionGroup": group, "motionIndex": index})
            if raw.get("sound") is not None:
                item["sound"] = _one_line(raw["sound"], f"entryPage.items[{number}].sound")
                item["soundLibraryPath"] = _resolve_model_relative(
                    model_path, raw["sound"], f"entryPage.items[{number}].sound", root_path
                )
        if kind == "motion":
            identity = (kind, name, item["motionIndex"])
        elif kind == "expression":
            identity = ((kind, name, relative_path) if status == "unregistered"
                        else (kind, name))
        else:
            identity = (kind, name, relative_path)
        if identity in seen:
            raise ValueError("entryPage 内 Live2D 稳定身份重复")
        seen.add(identity)
        normalized.append(item)
    next_offset = page.get("nextOffset")
    if next_offset is not None and (not isinstance(next_offset, int)
                                    or isinstance(next_offset, bool) or next_offset < 0):
        raise ValueError("entryPage.nextOffset 须为非负整数或 null")
    if next_offset is not None and next_offset <= page.get("offset", 0):
        raise ValueError("entryPage.nextOffset 必须大于 offset")
    if next_offset is not None and next_offset != offset + len(items):
        raise ValueError("entryPage.nextOffset 必须等于 offset 加本页条目数")
    if next_offset is None and offset + len(items) != total:
        raise ValueError("最后一页未覆盖 total，不能标记完成")
    return (
        normalized,
        next_offset,
        offset,
        total,
        root_path,
        model_format or "unknown",
        counts or {},
    )


def _validate_payload(payload):
    if payload.get("schema") != SCHEMA:
        raise ValueError(f"Live2D 建档 schema 须为 {SCHEMA}")
    character = _character_name(payload.get("character"))
    model = payload.get("model")
    (
        status,
        model_path,
        revision,
        model_format,
        model_root_path,
        model_has_root_path,
        model_counts,
        location,
    ) = _validate_model(model)
    model_name = payload.get("modelName")
    if model_name is None:
        model_name = PurePosixPath(model_path).parent.name or PurePosixPath(model_path).stem
    model_name = _one_line(model_name, "modelName", 256)
    default_prefix = payload.get("defaultPrefix", "")
    if default_prefix is None:
        default_prefix = ""
    if not isinstance(default_prefix, str) or len(default_prefix) > 256:
        raise ValueError("defaultPrefix 须为不超过 256 字符的文本")
    if any(ord(char) < 32 for char in default_prefix) or any(char in default_prefix for char in "*?[]"):
        raise ValueError("defaultPrefix 不能包含控制字符或通配符")
    page = payload.get("entryPage")
    (
        items,
        next_offset,
        offset,
        total,
        root_path,
        model_format,
        counts,
    ) = _validate_entry_page(
        page,
        model_path,
        revision,
        model_format,
        model_root_path,
        model_has_root_path,
        model_counts,
    )
    complete = payload.get("complete")
    if complete is None:
        complete = next_offset is None
    if not isinstance(complete, bool):
        raise ValueError("complete 须为布尔值")
    if complete != (next_offset is None):
        raise ValueError("complete 必须与 entryPage.nextOffset 是否为 null 一致")
    scan_id = payload.get("scanId")
    if scan_id is None:
        scan_id = f"{model_path}:{revision}"
    scan_id = _one_line(scan_id, "scanId", 512)
    return {
        "character": character,
        "modelName": model_name,
        "status": status,
        "modelPath": model_path,
        "rootPath": root_path,
        "revision": revision,
        "format": model_format,
        "defaultPrefix": default_prefix,
        "location": location,
        "scanId": scan_id,
        "complete": complete,
        "offset": offset,
        "total": total,
        "items": items,
        "counts": counts,
        "issues": model.get("issues") if isinstance(model.get("issues"), list) else [],
    }


def _new_model(payload):
    return {
        "character": payload["character"],
        "modelName": payload["modelName"],
        "status": payload["status"],
        "modelPath": payload["modelPath"],
        "rootPath": payload["rootPath"],
        "revision": payload["revision"],
        "format": payload["format"],
        "defaultPrefix": payload["defaultPrefix"],
        "location": payload["location"],
        "counts": payload["counts"],
        "issues": payload["issues"],
        "items": {},
        "dependencies": {},
        "scan": _new_scan(payload),
    }


def _new_scan(payload, previous_dependencies=None):
    return {
        "scanId": payload["scanId"],
        "revision": payload["revision"],
        "catalog": {
            "rootPath": payload["rootPath"],
            "format": payload["format"],
            "counts": payload["counts"],
        },
        "complete": False,
        "expectedOffset": 0,
        "total": payload["total"],
        "pages": {},
        "items": {},
        "dependencies": {},
        "previousDependencies": sorted(previous_dependencies or []),
    }


def _page_digest(data):
    value = {
        "offset": data["offset"],
        "total": data["total"],
        "items": data["items"],
        "complete": data["complete"],
    }
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _ensure_manifest(root):
    path = root / "INDEX.md"
    raw = read_index(path)
    text = raw.decode("utf-8-sig").replace("\r\n", "\n")
    if "catalog/Live2D/" in text:
        return
    text = text.rstrip("\n") + "\n- [Live2D](catalog/Live2D/)\n"
    save(path, raw, text)


def _import_book():
    from books import Book
    return Book


def ingest(root, payload, loaded):
    data = _validate_payload(payload)
    directory = root / CATALOG / "Live2D"
    if directory.exists() or directory.is_symlink():
        if linked(directory) or not directory.is_dir():
            raise ValueError("Live2D 分册目录异常")
    else:
        directory.mkdir()
    state = load(root)
    model_path = data["modelPath"]
    previous = state["models"].get(model_path)
    changed_revision = previous is not None and previous.get("revision") != data["revision"]
    if previous is None:
        if data["offset"] != 0:
            raise ValueError("首次 Live2D 建档必须从 offset 0 开始")
        model = _new_model(data)
    else:
        model = previous
        if model.get("character") != data["character"]:
            raise ValueError("同一模型入口不能更换角色分册")
        scan = model.get("scan")
        if not isinstance(scan, dict):
            scan = {"complete": True}
            model["scan"] = scan
        same_scan = scan.get("scanId") == data["scanId"]
        if not same_scan:
            if data["offset"] != 0:
                raise ValueError("新的 Live2D scanId 必须从 offset 0 开始")
            previous_dependencies = {
                _dependency_library_path(dependency)
                for dependency in model.get("dependencies", {}).values()
            }
            previous_dependencies.update(scan.get("previousDependencies", []))
            for dependency in scan.get("dependencies", {}).values():
                previous_dependencies.add(_dependency_library_path(dependency))
            for item in scan.get("items", {}).values():
                previous_dependencies.add(_item_library_path(item))
                sound = _item_sound_library_path(item, model_path)
                if sound:
                    previous_dependencies.add(sound)
            model["scan"] = _new_scan(data, previous_dependencies)
        elif scan.get("revision") != data["revision"]:
            raise ValueError("同一 scanId 的 revision 发生变化，请从 offset 0 启动新扫描")
    scan = model["scan"]
    if not isinstance(scan.get("pages"), dict):
        scan["pages"] = {}
    if not isinstance(scan.get("items"), dict):
        scan["items"] = {}
    if not isinstance(scan.get("dependencies"), dict):
        scan["dependencies"] = {}
    catalog = {
        "rootPath": data["rootPath"],
        "format": data["format"],
        "counts": data["counts"],
    }
    if "catalog" not in scan:
        scan["catalog"] = catalog
    elif scan["catalog"] != catalog:
        raise ValueError("同一 scanId 的 rootPath、format 或 counts 前后不一致")
    if scan.get("total") != data["total"]:
        raise ValueError("同一 scanId 的 entryPage.total 前后不一致")
    digest = _page_digest(data)
    old_digest = scan["pages"].get(str(data["offset"]))
    if old_digest is not None:
        if old_digest != digest:
            raise ValueError("同一 scanId 的 offset 页面内容发生变化")
        return {
            "模型": model_name_for_result(model),
            "角色": data["character"],
            "本页": len(data["items"]),
            "已见": len(scan.get("items", {})),
            "完成": bool(scan.get("complete")),
            "重复页": True,
        }
    if scan.get("complete", False):
        raise ValueError("该 scanId 已完成；重扫请从 offset 0 使用新 scanId")
    if data["offset"] != scan.get("expectedOffset", 0):
        raise ValueError("Live2D 建档分页不连续，拒绝跳页或重叠页")
    for item in data["items"]:
        if item["kind"] == "dependency":
            scan["dependencies"][item["id"]] = item
        else:
            ref = _entry_ref(model_path, item)
            staged = {**item, "ref": ref}
            previous_item = scan["items"].get(ref)
            if previous_item is not None and previous_item != staged:
                raise ValueError("同一次扫描中的 Live2D 条目内容前后不一致")
            scan["items"][ref] = staged
    scan["pages"][str(data["offset"])] = digest
    scan["expectedOffset"] = None if data["complete"] else (
        data["offset"] + len(data["items"])
    )
    changed_books = set()
    if data["complete"]:
        identity = ("Live2D", data["character"])
        if identity not in loaded:
            loaded[identity] = _import_book()(
                root / CATALOG / "Live2D" / (data["character"] + ".md")
            )
        book = loaded[identity]
        for ref, item in scan["items"].items():
            old = model["items"].get(ref)
            if old is None:
                needs_review = False
                verification = None
            else:
                previous_fingerprint = old.get("fingerprint")
                fingerprint_changed = (
                    (previous_fingerprint is not None or item.get("fingerprint") is not None)
                    and str(previous_fingerprint).casefold()
                    != str(item.get("fingerprint")).casefold()
                )
                needs_review = (
                    changed_revision
                    or bool(old.get("needsReview"))
                    or fingerprint_changed
                    or old.get("path") != item.get("path")
                    or old.get("sound") != item.get("sound")
                    or old.get("status") != item.get("status")
                )
                verification = old.get("verification")
            carried = {
                **item,
                "needsReview": needs_review,
                "stale": False,
            }
            if verification is not None:
                carried["verification"] = verification
            model["items"][ref] = carried
            if ref not in book.rows:
                book.append(
                    ref,
                    "Live2D",
                    name=item["name"],
                    description=_item_description(item),
                    tags=_item_tags(item),
                )
                changed_books.add(identity)
        for ref, item in model["items"].items():
            if ref not in scan["items"]:
                item["stale"] = True
        model["dependencies"] = scan["dependencies"]
        model.update({
            "modelName": data["modelName"],
            "status": data["status"],
            "rootPath": data["rootPath"],
            "revision": data["revision"],
            "format": data["format"],
            "defaultPrefix": data["defaultPrefix"],
            "location": data["location"],
            "counts": data["counts"],
            "issues": data["issues"],
        })
        scan["complete"] = True
        scan["items"] = {}
        scan["dependencies"] = {}
        scan["pages"] = {}
        scan["previousDependencies"] = []
    for changed in sorted(changed_books):
        loaded[changed].save()
    state["models"][model_path] = model
    _ensure_manifest(root)
    save_state(root, state)
    return {
        "模型": model_name_for_result(model),
        "角色": data["character"],
        "本页": len(data["items"]),
        "已见": len(scan.get("items", {})),
        "完成": data["complete"],
        "下一页": None if data["complete"] else "继续同一 scanId",
    }


def model_name_for_result(model):
    return model.get("modelName") or model.get("modelPath")


def model_names(state):
    return {path: model.get("modelName") or model.get("modelPath")
            for path, model in state.get("models", {}).items()}


def item_for_ref(state, ref):
    for model in state.get("models", {}).values():
        item = model.get("items", {}).get(ref)
        if item is not None:
            return model, item
    return None, None


def excluded_paths(state):
    excluded = set()
    for model in state.get("models", {}).values():
        for dependency in model.get("dependencies", {}).values():
            excluded.add(_dependency_library_path(dependency))
        scan = model.get("scan", {})
        excluded.update(scan.get("previousDependencies", []))
        for dependency in scan.get("dependencies", {}).values():
            excluded.add(_dependency_library_path(dependency))
        for item in scan.get("items", {}).values():
            excluded.add(_item_library_path(item))
            sound = _item_sound_library_path(item, model["modelPath"])
            if sound:
                excluded.add(sound)
        for item in model.get("items", {}).values():
            excluded.add(_item_library_path(item))
            sound = _item_sound_library_path(item, model["modelPath"])
            if sound:
                excluded.add(sound)
    return excluded


def _item_library_path(item):
    return item.get("libraryPath") or item.get("rootRelativePath") or item["path"]


def _item_sound_library_path(item, model_path):
    if item.get("soundLibraryPath"):
        return item["soundLibraryPath"]
    if item.get("sound"):
        return posixpath.normpath(posixpath.join(posixpath.dirname(model_path), item["sound"]))
    return None


def _dependency_library_path(dependency):
    return dependency.get("libraryPath") or dependency.get("rootRelativePath") or dependency["path"]


def item_status(state, ref):
    model, item = item_for_ref(state, ref)
    if item is None:
        return "unverified", None, None
    if item.get("stale"):
        return "stale", model, item
    if item.get("status") in {"missing", "invalid", "unverified"}:
        return item["status"], model, item
    if model.get("status") == "invalid":
        return "invalid", model, item
    if model.get("status") == "unverified":
        return "unverified", model, item
    if item.get("status") == "unregistered":
        return "unregistered", model, item
    return "registered", model, item


def available_status(status):
    return status in {"registered", "unregistered"}


def _valid_verification(verification):
    if not isinstance(verification, dict):
        return False
    return (
        isinstance(verification.get("fingerprint"), str)
        and re.fullmatch(r"[0-9a-fA-F]{64}", verification["fingerprint"]) is not None
        and isinstance(verification.get("revision"), str)
        and isinstance(verification.get("observation"), str)
        and bool(verification["observation"].strip())
        and isinstance(verification.get("verifiedAt"), str)
        and bool(verification["verifiedAt"].strip())
    )


def preview_state(model, item):
    verification = item.get("verification")
    if verification is None:
        if item.get("needsReview"):
            return PREVIEW_REVIEW, "重扫后文件或入口已变化，需要首次预览"
        return PREVIEW_UNSEEN, None
    if not _valid_verification(verification):
        return PREVIEW_REVIEW, "预览记录格式异常"
    reasons = []
    if verification["revision"] != model.get("revision"):
        reasons.append("模型入口已变化")
    if verification["fingerprint"].casefold() != str(item.get("fingerprint") or "").casefold():
        reasons.append("动作或表情文件已变化")
    if item.get("needsReview"):
        reasons.append("重扫后需要重新预览")
    if reasons:
        return PREVIEW_REVIEW, "；".join(reasons)
    return PREVIEW_VERIFIED, None


def _current_file_digest(root, library_path):
    check_key(library_path)
    current = root
    try:
        for part in library_path.split("/"):
            current = current / part
            if linked(current):
                raise ValueError("Live2D 动作或表情文件不能是链接")
        if not current.is_file():
            raise ValueError("Live2D 动作或表情文件当前不可读")
        digest = hashlib.sha256()
        with current.open("rb") as stream:
            before = os.fstat(stream.fileno())
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
            after = os.fstat(stream.fileno())
    except (FileNotFoundError, NotADirectoryError, PermissionError) as error:
        raise ValueError("Live2D 动作或表情文件当前不可读") from error
    if (before.st_size != after.st_size
            or getattr(before, "st_mtime_ns", None) != getattr(after, "st_mtime_ns", None)):
        raise ValueError("Live2D 动作或表情文件在验证时发生变化，请重新预览")
    return digest.hexdigest()


def verify(root, state, ref, observation):
    status, model, item = item_status(state, ref)
    if model is None or item is None:
        raise ValueError("Live2D 索引元数据缺失，请重新运行 MCP 建档")
    if item["kind"] not in {"motion", "expression"}:
        raise ValueError("只能验证 Live2D 动作或表情的播放观察")
    if status not in {"registered", "unregistered"}:
        raise ValueError(f"Live2D 条目当前为 {status}，不能登记播放验证")
    expected = item.get("fingerprint")
    if not isinstance(expected, str) or re.fullmatch(r"[0-9a-fA-F]{64}", expected) is None:
        raise ValueError("Live2D 条目没有可绑定的文件 SHA-256，不能登记播放验证")
    observation = _one_line(observation.strip(), "--observation", 2000)
    try:
        current = _current_file_digest(root, _item_library_path(item))
    except ValueError:
        item["needsReview"] = True
        save_state(root, state)
        raise
    if current.casefold() != expected.casefold():
        item["needsReview"] = True
        save_state(root, state)
        raise ValueError("Live2D 文件已变化，请先重扫并重新预览，再登记观察")
    item["verification"] = {
        "observation": observation,
        "fingerprint": current.casefold(),
        "revision": model["revision"],
        "scope": PREVIEW_SCOPE,
        "verifiedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    item["needsReview"] = False
    save_state(root, state)
    preview, reason = preview_state(model, item)
    result = {
        "路径": ref,
        "模型入口": model["modelPath"],
        "种类": item["kind"],
        "调用名": item["name"],
        "预览状态": preview,
        "预览观察": observation,
        "预览时间": item["verification"]["verifiedAt"],
        "入口 revision": model["revision"],
        "观察文件摘要": current.casefold(),
        "验证范围": PREVIEW_SCOPE,
    }
    if reason:
        result["复核原因"] = reason
    return result


def decorate_item(item, ref, state):
    model, detail = item_for_ref(state, ref)
    if detail is None:
        item["Live2D状态"] = "unverified"
        item["预览状态"] = PREVIEW_UNSEEN
        return item
    status, model, detail = item_status(state, ref)
    preview, _ = preview_state(model, detail)
    item.update({
        "Live2D引用": ref,
        "模型入口": model["modelPath"],
        "模型": model.get("modelName"),
        "默认前缀": model.get("defaultPrefix", ""),
        "种类": detail["kind"],
        "调用名": detail["name"],
        "文件": detail["path"],
        "Live2D状态": status,
        "预览状态": preview,
    })
    if preview == PREVIEW_VERIFIED:
        item["预览范围"] = PREVIEW_SCOPE
    if detail.get("rootRelativePath"):
        item["库内文件"] = detail["rootRelativePath"]
    if detail["kind"] == "motion":
        item["成员"] = detail["motionIndex"]
    return item


def show_item(state, ref, fields, source=False, license_=False):
    status, model, item = item_status(state, ref)
    if model is None or item is None:
        raise ValueError("Live2D 索引元数据缺失，请重新运行 MCP 建档")
    preview, reason = preview_state(model, item)
    result = {
        "路径": ref,
        "Live2D引用": ref,
        "模型入口": model["modelPath"],
        "模型": model.get("modelName"),
        "角色": model.get("character"),
        "格式": model.get("format"),
        "入口 revision": model["revision"],
        "默认前缀": model.get("defaultPrefix", ""),
        "种类": item["kind"],
        "调用名": item["name"],
        "文件": item["path"],
        "Live2D状态": status,
        "预览状态": preview,
        "验证范围": PREVIEW_SCOPE,
        "名称": fields["名称"],
        "描述": fields["描述"],
        "标签": fields["标签"],
    }
    verification = item.get("verification")
    if isinstance(verification, dict):
        if isinstance(verification.get("observation"), str):
            result["预览观察"] = verification["observation"]
        if isinstance(verification.get("verifiedAt"), str):
            result["预览时间"] = verification["verifiedAt"]
    if reason:
        result["复核原因"] = reason
    if item["kind"] == "motion":
        result.update({"动作组": item["motionGroup"], "成员": item["motionIndex"]})
        if item.get("sound"):
            result["绑定声音"] = item["sound"]
    if item.get("rootRelativePath"):
        result["库内文件"] = item["rootRelativePath"]
    if item.get("fingerprint"):
        result["文件摘要"] = item["fingerprint"]
    if model.get("location"):
        result["MCP定位"] = model["location"]
    if source:
        result["来源"] = fields["来源"]
    if license_:
        result["授权"] = fields["授权"]
    return result


def search_metadata_matches(state, ref, args):
    model, item = item_for_ref(state, ref)
    if item is None:
        return False
    if args.live2d_kind and item["kind"] != args.live2d_kind:
        return False
    if args.model and model.get("modelName") != args.model and model["modelPath"] != args.model:
        return False
    prefix = model.get("defaultPrefix", "") if args.prefix is None else args.prefix
    if prefix and not item["name"].startswith(prefix):
        return False
    status, _, _ = item_status(state, ref)
    selected = args.status
    if selected == "available":
        return available_status(status)
    if selected == "all":
        return True
    return status == selected


def has_live2d_ref(key):
    return "#motion/" in key or "#expression/" in key or "#dependency/" in key
