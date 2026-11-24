"""Storage primitives for the editable WebGAL catalog."""
from contextlib import contextmanager
import os
from pathlib import Path, PureWindowsPath
import stat
import tempfile

HEADER = "# WebGAL 素材分册\n\n<!-- webgal-librarian book v2 -->\n"
MANIFEST = "# WebGAL 素材库\n\n<!-- webgal-librarian v2 -->\n"
CATALOG = "catalog"
GENERAL = "_通用"

FIELDS = ("名称", "类型", "描述", "标签", "来源", "授权")
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".bmp"}
AUDIO = {".ogg", ".mp3", ".wav", ".m4a", ".flac", ".aac", ".opus", ".weba"}
CATEGORIES = {
    "背景": {"bg", "background", "backgrounds", "背景"},
    "立绘": {"figure", "figures", "portrait", "portraits", "立绘", "立繪"},
    "BGM": {"bgm", "music", "音乐", "音樂", "配乐", "配樂"},
    "音效": {"se", "sfx", "soundeffect", "soundeffects", "音效", "効果音"},
    "Live2D": {"live2d", "live2D"},
}
UNKNOWN = "未知"


def linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def check_key(key):
    if (not key or any(part in {"", ".", ".."} for part in key.split("/"))
            or "\\" in key or any(ord(ch) < 32 for ch in key)
            or PureWindowsPath(key).drive or (os.name == "nt" and ":" in key)):
        raise ValueError(f"无效的库内相对路径 {key!r}")


def category(key):
    path = Path(key)
    image = path.suffix.lower() in IMAGES
    choices = ("背景", "立绘") if image else ("BGM", "音效")
    for part in reversed(path.parent.parts):
        for choice in choices:
            if part.casefold() in CATEGORIES[choice]:
                return choice
    return "图片待分类" if image else "音频待分类"


def discover(root, excluded=None):
    excluded = excluded or set()

    def visit(directory):
        for path in sorted(directory.iterdir(), key=lambda p: p.name):
            if linked(path):
                continue
            if path.is_dir():
                if path.name != ".git" and path != root / CATALOG:
                    yield from visit(path)
            elif path.is_file() and path.suffix.lower() in IMAGES | AUDIO:
                key = path.relative_to(root).as_posix()
                check_key(key)
                if key not in excluded:
                    yield key

    return set(visit(root))


def readable(root, key, names):
    path = root
    try:
        for part in key.split("/"):
            # Case-only renames can leave the old spelling openable on Windows.
            if path not in names:
                names[path] = {entry.name for entry in path.iterdir()}
            if part not in names[path]:
                return False
            path = path / part
            if linked(path):
                return False
        if path.is_file():
            with path.open("rb") as media:
                media.read(1)
            return True
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        pass
    return False


def read_index(path):
    try:
        if linked(path) or not path.is_file():
            raise ValueError(f"{path.name} 必须是普通文件")
        return path.read_bytes()
    except FileNotFoundError:
        return None


def parse(raw):
    text = HEADER if raw is None else raw.decode("utf-8-sig")
    if not text.replace("\r\n", "\n").startswith(HEADER):
        raise ValueError("素材分册格式不符，请核对文件")
    lines = text.splitlines(keepends=True)
    rows = {}
    row = None
    for number, line in enumerate(lines):
        value = line.rstrip("\r\n")
        if value.startswith("## "):
            key = value[3:]
            check_key(key)
            if key in rows:
                raise ValueError(f"重复路径 {key}，请核对两条记录的手动注记")
            row = rows[key] = {}
        elif row is not None and value.startswith("- "):
            field, sep, content = value[2:].partition(":")
            if sep and field in FIELDS:
                if field in row:
                    raise ValueError(f"{key} 的 {field} 栏重复")
                row[field] = (number, content.removeprefix(" "))
    for key, row in rows.items():
        if row.keys() != set(FIELDS):
            raise ValueError(f"{key} 缺少字段 {', '.join(set(FIELDS) - row.keys())}")
    return lines, rows


@contextmanager
def writing(root):
    lock = root / ".webgal-librarian.lock"
    try:
        lock.mkdir()
    except FileExistsError:
        raise ValueError("素材库有写入锁。请等待当前操作结束；若上次中断，先检查锁的归属。") from None
    try:
        yield
    finally:
        lock.rmdir()


def save(path, original, text):
    data = text.encode("utf-8")
    if original and original.startswith(b"\xef\xbb\xbf"):
        data = b"\xef\xbb\xbf" + data
    if data == original:
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as staged:
        temp = Path(staged.name)
    try:
        temp.write_bytes(data)
        if read_index(path) != original:
            raise ValueError(f"{path.name} 同时被编辑，请重新读取后重试")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)
