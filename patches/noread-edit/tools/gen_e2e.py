# -*- coding: utf-8 -*-
"""生成 e2e 用原版策略模块（从备份 asar 提取，import 指向 asar 内真实 dsh-fs）。"""
import json, os, struct

HERE = os.path.dirname(os.path.abspath(__file__))
TEST = os.path.normpath(os.path.join(HERE, os.pardir, "tests"))
RES = r"C:\Users\53518\AppData\Local\Programs\DeepSeek Harness\resources"
BAK = os.path.join(RES, "app.asar.20261011-noread-patch")
POLICY = "\\dsh\\node_modules\\@deepseek-ai\\dsh-fs-observation-policy\\lib\\index.js"

with open(BAK, "rb") as f:
    tag, hb_len = struct.unpack("<II", f.read(8))
    assert tag == 4
    tree = json.loads(f.read(hb_len)[8:].decode("utf-8"))
    ds = 8 + hb_len
    node = tree
    for part in POLICY.strip("\\").split("\\"):
        node = node["files"][part]
    f.seek(ds + int(node["offset"]))
    src = f.read(node["size"]).decode("utf-8")

first = 'import { FsError } from "@deepseek-ai/dsh-fs";'
assert src.startswith(first)
real = ('import { FsError } from "file:///C:/Users/53518/AppData/Local/Programs/'
        'DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-fs/lib/index.js";')
out = os.path.join(TEST, "policy-orig-real.mjs")
open(out, "w", encoding="utf-8", newline="\n").write(real + "\n" + src[len(first) + 1:])
print("wrote", out, os.path.getsize(out), "bytes")
print("orig still has gate:", 'edit requires reading' in src)
