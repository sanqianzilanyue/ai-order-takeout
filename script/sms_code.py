#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""短信码 · 从这台 Mac 的「信息」库里捞最新的验证码（iPhone 的短信同步到 Mac 之后，机器就能自己读码）。

用法：
  python3 sms_code.py                 # 最近 10 分钟里最新一条带验证码的短信 → 打印 JSON {code, from, text, at}
  python3 sms_code.py --min 30        # 放宽到 30 分钟
  python3 sms_code.py --from 饿了么    # 只认发件内容/号码里含这个字的
  python3 sms_code.py --list 5        # 不找码，列最近 5 条（排障；order.js 的掉登录重登用的就是这个）
读的是 ~/Library/Messages/chat.db（只读打开，一个字不写）。
⚠️需要「完全磁盘访问权限」：给【跑它的那个进程的责任 app】开——终端里手跑＝给终端 app；后台服务跑＝给那个服务的 app
  （而且那个 app 的启动档得是编译好的可执行文件，不能是 shell 脚本，否则系统把它认成 bash、授权永远对不上号，教程坑八十三）。
  没权限时 sqlite 报 authorization denied，这里返回 {"ok": false, "why": "没权限"}。
新系统的短信正文常不在 text 列、在 attributedBody（typedstream）里——这里照 NSString 标记抠出来，抠不出就退回空串。
"""
import json, os, re, sqlite3, sys, time

DB = os.path.expanduser("~/Library/Messages/chat.db")
_码 = re.compile(r"(?<!\d)(\d{4,8})(?!\d)")
_码词 = ("验证码", "校验码", "动态码", "确认码", "code", "Code", "CODE", "驗證碼")


def _抠正文(blob: bytes) -> str:
    """typedstream 里的 NSString：'NSString' … '+' <len> <utf8>。len 一个字节；>=0x80 时是 0x81 + 两字节小端。"""
    if not blob:
        return ""
    i = blob.find(b"NSString")
    if i < 0:
        return ""
    j = blob.find(b"+", i)
    if j < 0:
        return ""
    k = j + 1
    n = blob[k]
    k += 1
    if n == 0x81:
        n = blob[k] | (blob[k + 1] << 8)
        k += 2
    elif n == 0x82:
        n = blob[k] | (blob[k + 1] << 8) | (blob[k + 2] << 16)
        k += 3
    try:
        return blob[k:k + n].decode("utf-8", "ignore")
    except Exception:
        return ""


def 最近(分钟: int = 10, limit: int = 40):
    since = time.time() - 分钟 * 60
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2.0)
    try:
        rows = con.execute(
            "SELECT m.ROWID, m.date/1000000000.0 + 978307200 AS ts, COALESCE(h.id,''), m.service, m.is_from_me, m.text, m.attributedBody "
            "FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id "
            "WHERE m.date/1000000000.0 + 978307200 >= ? ORDER BY m.date DESC LIMIT ?", (since, limit)).fetchall()
    finally:
        con.close()
    out = []
    for rid, ts, who, svc, mine, text, body in rows:
        t = (text or "") or _抠正文(body or b"")
        out.append({"id": rid, "at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)), "from": who, "service": svc,
                    "mine": bool(mine), "text": t.replace("\n", " ").strip()})
    return out


def 找码(分钟: int = 10, 发件含: str = ""):
    for m in 最近(分钟):
        if m["mine"]:
            continue
        t = m["text"]
        if 发件含 and (发件含 not in t and 发件含 not in m["from"]):
            continue
        if not any(w in t for w in _码词):
            continue
        # 优先取紧跟「验证码」之后的那串数字，取不到就取正文里第一串 4~8 位
        mm = re.search(r"(?:验证码|校验码|动态码|确认码|code)[^\d]{0,12}(\d{4,8})", t, re.I) or _码.search(t)
        if mm:
            return {"ok": True, "code": mm.group(1), "from": m["from"], "at": m["at"], "text": t[:120]}
    return {"ok": False, "why": "这段时间里没有带验证码的短信"}


if __name__ == "__main__":
    a = sys.argv[1:]
    def opt(k, d=None):
        return a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d
    try:
        if "--list" in a:
            print(json.dumps(最近(int(opt("--min", 24 * 60)), int(opt("--list", 5)))[: int(opt("--list", 5))], ensure_ascii=False, indent=1))
        else:
            print(json.dumps(找码(int(opt("--min", 10)), opt("--from", "")), ensure_ascii=False))
    except sqlite3.Error as e:
        deny = "authorization" in str(e).lower() or "denied" in str(e).lower()
        print(json.dumps({"ok": False, "why": "没权限（要给跑它的 app 开完全磁盘访问）" if deny else f"{type(e).__name__}: {str(e)[:80]}"}, ensure_ascii=False))
        sys.exit(2)
