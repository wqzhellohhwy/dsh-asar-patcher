# -*- coding: utf-8 -*-
"""准备行为单测素材：真实策略源码（改前/改后）+ fs-local 守卫片段（逐字）。"""
import json, os, struct

HERE = os.path.dirname(os.path.abspath(__file__))
TEST = os.path.normpath(os.path.join(HERE, os.pardir, "tests"))
os.makedirs(TEST, exist_ok=True)
RES = r"C:\Users\53518\AppData\Local\Programs\DeepSeek Harness\resources"
ASAR = os.path.join(RES, "app.asar")
BAK = os.path.join(RES, "app.asar.20261011-noread-patch")

def open_archive(path):
    with open(path, "rb") as f:
        tag, hb_len = struct.unpack("<II", f.read(8))
        assert tag == 4
        j = json.loads(f.read(hb_len)[8:].decode("utf-8"))
    return j, 8 + hb_len

def entries(tree):
    out = {}
    def walk(node, prefix=""):
        for k, v in node.get("files", {}).items():
            if "files" in v: walk(v, prefix + "\\" + k)
            else: out[prefix + "\\" + k] = v
    walk(tree)
    return out

def read_entry(path, ds, e):
    with open(path, "rb") as f:
        f.seek(ds + int(e["offset"]))
        return f.read(e["size"]).decode("utf-8")

POLICY = "\\dsh\\node_modules\\@deepseek-ai\\dsh-fs-observation-policy\\lib\\index.js"
FSLOCAL = "\\dsh\\node_modules\\@deepseek-ai\\dsh-fs-local\\lib\\index.js"

ho, dso = open_archive(BAK)
hn, dsn = open_archive(ASAR)
eo, en = entries(ho), entries(hn)

orig = read_entry(BAK, dso, eo[POLICY])
patched = read_entry(ASAR, dsn, en[POLICY])
fslocal = read_entry(ASAR, dsn, en[FSLOCAL])

def to_local_module(src):
    first = 'import { FsError } from "@deepseek-ai/dsh-fs";'
    assert src.startswith(first), src[:80]
    return 'import { FsError } from "./stub-fs.mjs";\n' + src[len(first) + 1:]

open(os.path.join(TEST, "policy-orig.mjs"), "w", encoding="utf-8", newline="\n").write(to_local_module(orig))
open(os.path.join(TEST, "policy-patched.mjs"), "w", encoding="utf-8", newline="\n").write(to_local_module(patched))

def cut(text, start, end):
    i = text.index(start)
    j = text.index(end, i) + len(end)
    frag = text[i:j]
    # 去掉行首缩进，new Function 里无所谓，保留原样
    return frag

write_guard = cut(fslocal,
    'if (existing && existing.type !== "file") throw new FsError(`cannot write',
    'without reading it first`, "FS_NOT_OBSERVED");')
edit_guard = cut(fslocal,
    'if (!existing) throw new FsError(`cannot edit',
    'if (expected && existing.version !== expected.version) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");')

assert 'replaceIfVersion' in write_guard and 'createIfAbsent' in write_guard
assert 'FS_STALE_VERSION' in edit_guard
json.dump({"writeGuard": write_guard, "editGuard": edit_guard},
          open(os.path.join(TEST, "guards.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("patched policy bytes:", len(patched.encode("utf-8")), "orig:", len(orig.encode("utf-8")))
print("write guard lines:", write_guard.count("\n") + 1, "edit guard lines:", edit_guard.count("\n") + 1)
print("TEST dir:", TEST)
print("运行单测：node ../tests/test.mjs （在 tests 目录内执行）")
