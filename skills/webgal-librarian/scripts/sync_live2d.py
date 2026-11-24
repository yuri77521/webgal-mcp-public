"""Build one model catalog from a registered MCP source without printing its entries."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryFile
from uuid import uuid4


def sync(args):
    root = args.library.resolve(strict=True)
    if not (root / "INDEX.md").is_file():
        raise ValueError("请先为指定的共享素材库建索引。")
    command = [args.node, str(args.server), "--config", str(args.config),
               "--catalog-live2d", args.source, args.package, args.entry, str(root)]
    scan_id = str(uuid4())
    consumer = [sys.executable, "-X", "utf8", str(Path(__file__).with_name("library.py")),
                "live2d-ingest", str(root), "--input", "-"]
    # Complete the read before making any catalog changes. Stderr contains the
    # MCP diagnostic; neither a failed export nor its partial stdout is ingested.
    with TemporaryFile() as pages:
        subprocess.run(command, stdout=pages, check=True)
        pages.seek(0)
        count = 0
        complete = False
        for line in pages:
            page = json.loads(line)
            if complete or page["entryPage"]["offset"] != count:
                raise ValueError("MCP 建档分页不连续。")
            count += len(page["entryPage"]["items"])
            complete = page["entryPage"]["nextOffset"] is None
            payload = dict(page, schema="webgal-live2d-catalog/v1", scanId=scan_id,
                           complete=complete, character=args.character, modelName=args.model_name,
                           defaultPrefix=args.prefix)
            subprocess.run(consumer, input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                           stdout=subprocess.DEVNULL, check=True)
        if not complete:
            raise ValueError("MCP 未返回完整建档结果。")
    return {"角色": args.character, "模型": args.model_name, "已处理条目": count}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library", type=Path)
    parser.add_argument("--server", type=Path, required=True, help="compiled MCP dist/cli.js")
    parser.add_argument("--config", type=Path, required=True, help="MCP source configuration")
    parser.add_argument("--source", required=True, help="registered source ID")
    parser.add_argument("--package", required=True, help="package root within the source, or .")
    parser.add_argument("--entry", required=True, help="entry relative to registered source")
    parser.add_argument("--character", required=True)
    parser.add_argument("--model-name", required=True)
    parser.add_argument("--prefix", default="", help="default character namespace, e.g. sakiko/")
    parser.add_argument("--node", default="node")
    try:
        print(json.dumps(sync(parser.parse_args()), ensure_ascii=False))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
