# -*- coding: utf-8 -*-
"""独立复核 app.asar 补丁：头未动、差异只在目标条目内、条目内容 == 期望。"""
import json, os, struct, hashlib

RES = r"C:\Users\53518\AppData\Local\Programs\DeepSeek Harness\resources"
ASAR = os.path.join(RES, "app.asar")
BAK = os.path.join(RES, "app.asar.20261011-noread-patch")
PATCH = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "patch"))

def open_archive(path):
    with open(path, "rb") as f:
        pre = f.read(8)
        tag, hb_len = struct.unpack("<II", pre)
        assert tag == 4, tag
        hb = f.read(hb_len)
        j = json.loads(hb[8:].decode("utf-8"))
        return j, 8 + hb_len

def entries(tree):
    out = {}
    def walk(node, prefix=""):
        for k, v in node.get("files", {}).items():
            if "files" in v: walk(v, prefix + "\\" + k)
            else: out[prefix + "\\" + k] = v
    walk(tree)
    return out

def read_entry(f, dataStart, e):
    f.seek(dataStart + int(e["offset"]))
    return f.read(e["size"])

h_new, ds_new = open_archive(ASAR)
h_old, ds_old = open_archive(BAK)
print("dataOffset old/new:", ds_old, ds_new, "equal:", ds_old == ds_new)

size_new, size_old = os.path.getsize(ASAR), os.path.getsize(BAK)
print("archive size old/new:", size_old, size_new, "equal:", size_old == size_new)

# 1) 头部（含整个 JSON 索引）逐字节相同
with open(ASAR, "rb") as a, open(BAK, "rb") as b:
    ha, hb = a.read(ds_new), b.read(ds_old)
print("header bytes identical:", ha == hb)

# 2) 全文件差异区间
diffs = []
with open(ASAR, "rb") as a, open(BAK, "rb") as b:
    off = 0
    CH = 1 << 22
    while True:
        ca, cb = a.read(CH), b.read(CH)
        if not ca and not cb: break
        if ca != cb:
            n = min(len(ca), len(cb))
            i = 0
            while i < n:
                if ca[i] != cb[i]:
                    j = i
                    while j < n and ca[j] != cb[j]: j += 1
                    diffs.append((off + i, off + j))
                    i = j
                else:
                    i += 1
        off += len(ca)
print("diff regions:", diffs)

# 3) 目标条目
eold = entries(h_old)
enew = entries(h_new)
targets = [
    ("\\dsh\\node_modules\\@deepseek-ai\\dsh-fs-observation-policy\\lib\\index.js",
     ["policy.writeIntent", "policy.editIntent"],
     ["edit requires reading", "createIfAbsent"]),
    ("\\dsh\\node_modules\\@deepseek-ai\\dsh-tool-fs\\lib\\index.js",
     ["toolfs.writeGuidance", "toolfs.editGuidance"],
     ["before overwriting it with write", "before editing it"]),
]
ok = True
ranges = []
with open(ASAR, "rb") as f_new, open(BAK, "rb") as f_old:
    for path, patchnames, absent in targets:
        eo, en = eold[path], enew[path]
        bo = read_entry(f_old, ds_old, eo)
        bn = read_entry(f_new, ds_new, en)
        print("\n==", path, "size", len(bo), "->", len(bn), "equal:", len(bo) == len(bn))
        expected = bo.decode("utf-8")
        for name in patchnames:
            old = open(os.path.join(PATCH, name + ".old"), "rb").read().decode("utf-8")
            new = open(os.path.join(PATCH, name + ".new"), "rb").read().decode("utf-8")
            assert expected.count(old) == 1, (name, "old not unique")
            expected = expected.replace(old, new, 1)
        got = bn.decode("utf-8")
        same = got == expected
        ok = ok and same
        print("   readback == backup+patches:", same)
        for name in patchnames:
            open(os.path.join(PATCH, "result." + name + ".mjs"), "w", encoding="utf-8", newline="\n").write(got)
        ranges.append((ds_new + int(en["offset"]), ds_new + int(en["offset"]) + int(en["size"])))
        body_ok = all(s not in got for s in absent)
        print("   forbidden text gone (%s):" % ", ".join(absent), body_ok)
        ok = ok and body_ok

# 差异区间必须全部落在两个目标条目的并集内
def covered(pos):
    return any(lo <= pos and pos < hi for lo, hi in ranges)
outside = [(s, e) for s, e in diffs if not (covered(s) and covered(e - 1))]
print("\ndiff regions outside target entries:", outside)
ok = ok and not outside

print("ALL CHECKS:", "PASS" if ok else "FAIL")
print("archive sha256:", hashlib.sha256(open(ASAR, "rb").read()).hexdigest())
