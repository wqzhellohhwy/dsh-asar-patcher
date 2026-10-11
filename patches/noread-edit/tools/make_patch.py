# -*- coding: utf-8 -*-
"""构造 dsh「编辑前必须先读」限制的等长补丁片段（干运行，不落盘）。"""
import json, os, struct, sys, difflib

WORK = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(WORK, os.pardir, "patch"))
os.makedirs(OUT, exist_ok=True)

ASAR = os.environ.get("DSH_ASAR") or r"C:\Users\53518\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"

def read_entry(asar, want):
    """按路径片段读 asar 条目文本：布局 = [8B size][pickle 头][JSON 索引][数据区]。"""
    with open(asar, "rb") as f:
        tag, hb_len = struct.unpack("<II", f.read(8))
        assert tag == 4, tag
        tree = json.loads(f.read(hb_len)[8:].decode("utf-8"))
        data_start = 8 + hb_len
        hits = []

        def walk(node, prefix=""):
            for k, v in node.get("files", {}).items():
                path = prefix + "/" + k
                if "files" in v:
                    walk(v, path)
                elif want in path:
                    hits.append((path, v))

        walk(tree)
        assert len(hits) == 1, hits
        path, node = hits[0]
        f.seek(data_start + int(node["offset"]))
        raw = f.read(node["size"])
    assert b"\r\n" not in raw, "unexpected CRLF in " + path
    return path, raw.decode("utf-8")

_, policy = read_entry(ASAR, "dsh-fs-observation-policy/lib/index.js")
_, toolfs = read_entry(ASAR, "dsh-tool-fs/lib/index.js")
if "[dsh-local-patch]" in policy or "[dsh-local-patch]" in toolfs:
    print("注意：目标条目已是补丁后状态。要重新生成片段，先用备份还原 app.asar。")
    raise SystemExit(2)

def slice_between(text, start_marker, end_marker, label):
    i = text.index(start_marker)
    j = text.index(end_marker, i) + len(end_marker)
    frag = text[i:j]
    assert text.count(frag) == 1, "fragment not unique: " + label
    return frag

# ---------- 补丁 1：策略插件 ----------
A_OLD = slice_between(policy,
    '\t/**\n\t* Decide the write intent:',
    '\t\t} : { kind: "createIfAbsent" };\n\t}',
    "writeIntent")
B_OLD = slice_between(policy,
    '\t/**\n\t* Decide the edit version guard:',
    '\t\treturn { version: prior.version };\n\t}',
    "editIntent")

A_NEW_BODY = '''\t// [dsh-local-patch] unobserved/absent target: no guard (provider default
\t// create-or-overwrite); observed present keeps its CAS version.
\twriteIntent(target, actor) {
\t\tconst owner = this.owner(actor);
\t\tconst prior = owner ? this.get(owner, target.targetKey) : void 0;
\t\treturn prior?.kind === "present" ? {
\t\t\tkind: "replaceIfVersion",
\t\t\tversion: prior.version
\t\t} : void 0;
\t}
'''

B_NEW_BODY = '''\t// [dsh-local-patch] no read-before-edit: an unseen or confirmed-absent target
\t// carries no guard instead of throwing FS_NOT_OBSERVED / FS_NOT_FOUND; an
\t// observed present target still supplies its version as the CAS basis.
\teditIntent(target, actor) {
\t\tconst owner = this.owner(actor);
\t\tconst prior = owner ? this.get(owner, target.targetKey) : void 0;
\t\treturn prior?.kind === "present" ? { version: prior.version } : void 0;
\t}
'''

def pad_to(body, want, label):
    """在片段末尾用注释把字节数精确补齐到 want。"""
    b = body.encode("utf-8")
    if len(b) > want:
        raise SystemExit("%s: new content is %d bytes, %d too long" % (label, len(b), len(b) - want))
    need = want - len(b)
    if need == 0:
        return body
    if need < 10:
        return body + " " * need
    prefix = "\t// pad: "
    line = prefix + "-" * max(0, need - len(prefix.encode("utf-8")) - 1) + "\n"
    if len(line.encode("utf-8")) != need:
        raise SystemExit("%s: cannot pad exactly (%d vs %d)" % (label, len(line.encode("utf-8")), need))
    return body + line

A_NEW = pad_to(A_NEW_BODY, len(A_OLD.encode("utf-8")), "writeIntent")
B_NEW = pad_to(B_NEW_BODY, len(B_OLD.encode("utf-8")), "editIntent")

# ---------- 补丁 2：工具系统提示 ----------
W_OLD = slice_between(toolfs, '\t\ttext: ({ scope }) => ctx.tools.get("write", scope)', '\n', "write guidance")
E_OLD = slice_between(toolfs, '\t\ttext: ({ scope }) => ctx.tools.get("edit", scope)', '\n', "edit guidance")
# \n 已被 end_marker 吃掉，补回
W_OLD = W_OLD.rstrip("\n")
E_OLD = E_OLD.rstrip("\n")

W_NEW_BODY = ('\t\ttext: ({ scope }) => /* dsh-local-patch: relaxed fs policy */ '
    'ctx.tools.get("write", scope) === void 0 ? "" : '
    '"No prior read is required: write replaces the whole file atomically." '
    '+ (ctx.tools.get("edit", scope) === void 0 ? "" : " Prefer edit for targeted changes.")')
E_NEW_BODY = ('\t\ttext: ({ scope }) => /* dsh-local-patch: relaxed fs policy */ '
    'ctx.tools.get("edit", scope) === void 0 ? "" : '
    '"No prior read needed: edit replaces literal text and reports missing '
    'or ambiguous matches."')

W_NEW = pad_to(W_NEW_BODY, len(W_OLD.encode("utf-8")), "write guidance")
E_NEW = pad_to(E_NEW_BODY, len(E_OLD.encode("utf-8")), "edit guidance")

def emit(name, old, new):
    op = os.path.join(OUT, name + ".old")
    np = os.path.join(OUT, name + ".new")
    open(op, "wb").write(old.encode("utf-8"))
    open(np, "wb").write(new.encode("utf-8"))
    print("== %s: old=%d new=%d bytes (equal=%s)" % (name, len(old.encode("utf-8")), len(new.encode("utf-8")), len(old.encode("utf-8")) == len(new.encode("utf-8"))))
    for line in difflib.unified_diff(old.splitlines(), new.splitlines(), "old", "new", lineterm="", n=1):
        print("   " + line)

emit("policy.writeIntent", A_OLD, A_NEW)
emit("policy.editIntent", B_OLD, B_NEW)
emit("toolfs.writeGuidance", W_OLD, W_NEW)
emit("toolfs.editGuidance", E_OLD, E_NEW)
print("bytes:", {k: (len(v.encode("utf-8"))) for k, v in
      {"A_OLD": A_OLD, "A_NEW": A_NEW, "B_OLD": B_OLD, "B_NEW": B_NEW,
       "W_OLD": W_OLD, "W_NEW": W_NEW, "E_OLD": E_OLD, "E_NEW": E_NEW}.items()})
print("old fragments unique in entries:", policy.count(A_OLD), policy.count(B_OLD), toolfs.count(W_OLD), toolfs.count(E_OLD))
print("OUT =", OUT)
