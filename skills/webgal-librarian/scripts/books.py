"""Discover and maintain one editable Markdown book per asset group."""
from collections import defaultdict
import hashlib
import json
from pathlib import Path, PureWindowsPath
import re

from catalog import (AUDIO, IMAGES, CATALOG, CATEGORIES, FIELDS, GENERAL, HEADER, MANIFEST, UNKNOWN,
                     category, check_key, discover, linked, parse, read_index, readable, save)


def group_name(value):
    check_key(value)
    if ("/" in value or any(c in '<>:"|?*' for c in value)
            or value.endswith((" ", ".")) or PureWindowsPath(value).is_reserved()):
        raise ValueError("分组名须是可用的单个文件名")
    return value


def clean_dir(path, create=False):
    if path.exists() or path.is_symlink():
        if linked(path) or not path.is_dir():
            raise ValueError(f"分册目录异常 {path.name}")
    elif create:
        path.mkdir()


def manifest(root, create=False, confirmed=False):
    path = root / "INDEX.md"
    raw = read_index(path)
    if raw is not None:
        if not raw.decode("utf-8-sig").replace("\r\n", "\n").startswith(MANIFEST):
            raise ValueError("已有 INDEX.md 格式与 v2 不同，原文件已保留；请选择其他库或另行处理旧索引。")
    elif create:
        if not confirmed and any(p.name != ".webgal-librarian.lock" for p in root.iterdir()):
            raise ValueError("请先问用户是否保留原目录，只建索引。确认后传 --layout-confirmed。")
        if (root / CATALOG).exists() or (root / CATALOG).is_symlink():
            raise ValueError("catalog 已被占用，请先核对目录")
        links = "".join(f"- [{kind}](catalog/{kind}/)\n" for kind in CATEGORIES)
        save(path, None, MANIFEST + "\n" + links)
    else:
        raise ValueError("请先建立 v2 素材索引")
    if read_index(root / ".webgal-regroup.json") is not None:
        raise ValueError("分组调整未完成，请执行 recover 复核并续写")
    clean_dir(root / CATALOG, create)
    for kind in CATEGORIES:
        clean_dir(root / CATALOG / kind, create)


class Book:
    def __init__(self, path):
        self.path = path
        self.raw = read_index(path)
        self.lines, self.rows = parse(self.raw)
        self.keys = set(self.rows)
        self.newline = "\r\n" if any(s.endswith("\r\n") for s in self.lines) else "\n"

    def append(self, key, kind, name=None, description=None, tags=""):
        name = name or Path(key).stem
        values = (name, kind, description or f"{name}（{Path(key).suffix[1:].upper()}）",
                  tags, UNKNOWN, UNKNOWN)
        if self.lines and not self.lines[-1].endswith("\n"):
            self.lines.append(self.newline)
        self.lines.extend(line + self.newline for line in
                          ("", f"## {key}", *(f"- {f}: {v}" for f, v in zip(FIELDS, values))))
        self.keys.add(key)

    def save(self):
        save(self.path, self.raw, "".join(self.lines))


def books(root, kind=None, group=None):
    if group is not None:
        group_name(group)
    loaded = {}
    seen = set()
    for k in ([kind] if kind else CATEGORIES):
        directory = root / CATALOG / k
        if not directory.exists():
            continue
        paths = directory.glob("*.md") if group is None else [directory / (group + ".md")]
        for path in sorted(paths):
            if not path.exists() and not path.is_symlink():
                continue
            book = Book(path)
            overlap = seen.intersection(book.keys)
            if overlap:
                raise ValueError(f"不同分册存在重复路径 {min(overlap)}")
            for key, row in book.rows.items():
                if row["类型"][1] != k:
                    raise ValueError(f"{key} 的类型与所在分册不符")
            seen.update(book.keys)
            loaded[k, path.stem] = book
    return loaded


def lookup(loaded, key):
    check_key(key)
    for book in loaded.values():
        if key in book.rows:
            return book
    raise ValueError("索引中找不到该路径")


def auto_group(key):
    kind = category(key)
    if kind not in CATEGORIES:
        return None
    if kind != "立绘":
        parts = key.split("/")[:-1]
        pack = next((part for part in reversed(parts)
                     if part.startswith("素材包") or part.casefold().startswith(("pack-", "pack_"))), None)
        return kind, group_name(pack) if pack else GENERAL
    parts = key.split("/")[:-1]
    start = max(i for i, name in enumerate(parts) if name.casefold() in CATEGORIES[kind])
    folders = parts[start + 1:]
    if not folders:
        return None
    name = folders[0]
    # A repeated character directory or filename prefix is explicit local evidence.
    if name in folders[1:] or re.match(re.escape(name) + r"(?:[_\- .]|$)", Path(key).stem, re.I):
        return kind, group_name(name)
    return None


def pending_summary(keys):
    counts = defaultdict(int)
    for key in keys:
        counts[key.rpartition("/")[0] or "."] += 1
    return {"待决定": len(keys), "目录数": len(counts), "目录示例": sorted(counts.items())[:5]}


def scan(root, loaded, excluded=None):
    existing = {key for book in loaded.values() for key in book.keys}
    found = discover(root, excluded)
    added = 0
    pending = []
    changed = set()
    for key in sorted(found - existing):
        identity = auto_group(key)
        if identity is None:
            pending.append(key)
            continue
        kind, group = identity
        if identity not in loaded:
            loaded[identity] = Book(root / CATALOG / kind / (group + ".md"))
        loaded[identity].append(key, kind)
        changed.add(identity)
        added += 1
    for identity in sorted(changed):
        loaded[identity].save()
    missing = existing - found
    return {"新增": added, "现存": len(found & existing) + added, "缺失": len(missing),
            **pending_summary(pending)}


def assign(root, loaded, key, kind, group):
    check_key(key)
    group_name(group)
    if kind == "Live2D":
        raise ValueError("Live2D 条目只能由 MCP 检查结果建档")
    if Path(key).suffix.casefold() not in (IMAGES if kind in ("立绘", "背景") else AUDIO):
        raise ValueError("文件格式与指定素材类型不符")
    if (key.split("/")[0].casefold() == CATALOG or ".git" in key.casefold().split("/")
            or not readable(root, key, {})):
        raise ValueError("素材不可读")
    for (k, g), book in loaded.items():
        if key in book.keys:
            if (k, g) == (kind, group):
                return {"路径": key, "分组": group}
            return regroup(root, key, loaded, (k, g), (kind, group))
    book = Book(root / CATALOG / kind / (group + ".md"))
    book.append(key, kind)
    book.save()
    return {"路径": key, "分组": group}


def edit(book, key, field, value, append_tag=False):
    number, old = book.rows[key][field]
    value = value.strip()
    if not value or len(value.splitlines()) != 1:
        raise ValueError("字段值须为一行非空文本")
    if append_tag:
        tags = [t.strip() for t in old.split("、") if t.strip()]
        if value not in tags:
            tags.append(value)
        value = "、".join(tags)
    line = book.lines[number]
    book.lines[number] = f"- {field}: {value}" + line[len(line.rstrip("\r\n")):]
    book.save()
    return {"路径": key, field: value}

def fingerprint(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def recover(root):
    journal = root / ".webgal-regroup.json"
    raw = read_index(journal)
    if raw is None:
        return {"恢复": 0}
    clean_dir(root / CATALOG)
    items = json.loads(raw)
    if not isinstance(items, list) or len(items) != 2:
        raise ValueError("分组调整记录格式异常")
    updates = []
    for item in items:
        kind, group = item["book"]
        if kind not in CATEGORIES:
            raise ValueError("分册类型无效")
        directory = root / CATALOG / kind
        clean_dir(directory)
        path = directory / (group_name(group) + ".md")
        current = read_index(path)
        text = item["text"]
        parse(text.encode("utf-8"))
        if current is not None and current.decode("utf-8-sig") == text:
            continue
        if fingerprint(current) != item["before"]:
            raise ValueError(f"{path.name} 有并行手改，请核对调整记录")
        updates.append((path, current, text))
    for path, current, text in updates:
        save(path, current, text)
    journal.unlink()
    return {"恢复": len(updates)}


def regroup(root, key, loaded, source, target):
    old = loaded[source]
    kind, group = target
    dest = loaded.get(target) or Book(root / CATALOG / kind / (group + ".md"))
    starts = [i for i, line in enumerate(old.lines) if line.startswith("## ")]
    first = next(i for i in starts if old.lines[i].rstrip("\r\n")[3:] == key)
    last = next((i for i in starts if i > first), len(old.lines))
    block = old.lines[first:last]
    number = old.rows[key]["类型"][0] - first
    ending = block[number][len(block[number].rstrip("\r\n")):]
    block[number] = f"- 类型: {kind}{ending}"
    prefix = "".join(dest.lines)
    if not prefix.endswith(("\n", "\r")):
        prefix += dest.newline
    dest_text = prefix + dest.newline + "".join(block)
    updates = [(dest, target, dest_text), (old, source, "".join(old.lines[:first] + old.lines[last:]))]
    journal = [{"book": identity, "before": fingerprint(book.raw), "text": text}
               for book, identity, text in updates]
    save(root / ".webgal-regroup.json", None, json.dumps(journal, ensure_ascii=False))
    recover(root)
    return {"路径": key, "类型": kind, "分组": group}
