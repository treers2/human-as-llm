"""创建桌面 / 开始菜单快捷方式，并自动校验。
用 pylnk3 纯 Python 写 Shell Link 二进制，不触发 COM / Add-Type 拦截。
"""
import json
import os
import sys
import pylnk3

# 路径全部从脚本自身位置推导 —— 不写死用户名和绝对路径，别人 clone 下来直接能跑
PROJ = os.path.dirname(os.path.abspath(__file__))
NODE = r"C:\Program Files\nodejs\node.exe"
CONTROL = os.path.join(PROJ, "control.js")
ICON = os.path.join(PROJ, "dafeigou-ai.ico")
HOME = os.path.expanduser("~")
DESKTOP = os.path.join(HOME, "Desktop")
STARTMENU = os.path.join(os.environ.get("APPDATA", ""),
                         "Microsoft", "Windows", "Start Menu", "Programs")

# 显示名和公网地址都从 config.json 读，跟服务端保持一致
CFG = {}
try:
    with open(os.path.join(PROJ, "config.json"), encoding="utf-8") as _f:
        CFG = json.load(_f) or {}
except (OSError, ValueError):
    pass

PRODUCT = str(CFG.get("productName") or "human-as-llm")
PUBCONSOLE_URL = str(CFG.get("publicUrl") or "").rstrip("/")

NAME = PRODUCT + " 控制面板"
DESC = "本机运维面板：启停本机服务、看 Key 和日志 —— 它就是那个模型"
# 桌面上还会有一个直接指向公网控制台的网址快捷方式（配了 publicUrl 才有），
# 那个才是日常回复请求用的入口。
PUBCONSOLE_NAME = PRODUCT + " 控制台"

WINDOW_NORMAL = getattr(pylnk3, "WINDOW_NORMAL", 1)


def make(link_path):
    if os.path.exists(link_path):
        os.remove(link_path)
    lnk = pylnk3.for_file(
        target_file=NODE,
        lnk_name=link_path,
        arguments='"%s" menu' % CONTROL,
        description=DESC,
        icon_file=ICON,
        icon_index=0,
        work_dir=PROJ,
        window_mode=WINDOW_NORMAL,
    )
    lnk.save(link_path, force_ext=True)
    return link_path


def entry_name(it):
    d = it.__dict__
    for attr in ("root", "drive", "full_name", "short_name"):
        v = d.get(attr)
        if isinstance(v, bytes):
            v = v.decode("utf-8", "replace")
        if isinstance(v, str) and v:
            return v
    return type(it).__name__


def verify(link_path):
    ok = True
    if not os.path.exists(link_path):
        return False, "文件不存在"
    with open(link_path, "rb") as f:
        head = f.read(8)
    expect = bytes([0x4C, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])
    if head != expect:
        ok = False
    back = pylnk3.parse(link_path)
    parts = [entry_name(it) for it in back.shell_item_id_list.items]
    tail = parts[-1] if parts else "(空)"
    info = {
        "header": head.hex(" "),
        "header_ok": head == expect,
        "idlist": " / ".join(parts),
        "target_tail": tail,
        "icon": back.icon,
        "icon_index": back.icon_index,
        "work_dir": back.work_dir,
        "desc": back.description,
        "window_mode": back.window_mode,
    }
    if tail.lower() != "node.exe":
        ok = False
    if len(parts) < 3:
        ok = False
    if back.icon and "dafeigou-ai.ico" not in back.icon:
        ok = False
    if (back.work_dir or "").lower() != PROJ.lower():
        ok = False
    return ok, info


def make_pubconsole_url_shortcut():
    """桌面上的「控制台」：一个 .url 文件，双击用默认浏览器打开公网控制台。

    这才是日常入口 —— 外部调用打的都是公网地址，请求排在公网那台的队列里，
    本机 127.0.0.1:8787 的队列看不到它们。
    没在 config.json 里配 publicUrl 就跳过（本地跑不需要这个快捷方式）。
    """
    if not PUBCONSOLE_URL:
        return None
    path = os.path.join(DESKTOP, PUBCONSOLE_NAME + ".url")
    lines = [
        "[InternetShortcut]",
        "URL=" + PUBCONSOLE_URL + "/admin",
        "IconFile=" + ICON,
        "IconIndex=0",
    ]
    # .url 是 INI 风格，Windows 认 CRLF
    with open(path, "w", encoding="ascii", newline="\r\n") as f:
        f.write("\n".join(lines) + "\n")
    return path


targets = [os.path.join(DESKTOP, NAME + ".lnk")]
if os.path.isdir(STARTMENU) and "--startmenu" in sys.argv:
    targets.append(os.path.join(STARTMENU, NAME + ".lnk"))

all_ok = True
for t in targets:
    p = make(t)
    good, info = verify(p)
    all_ok = all_ok and good
    print(("  [OK]  " if good else "  [!!]  ") + p)
    if isinstance(info, dict):
        print("        目标   : " + info["idlist"])
        print("        图标   : " + str(info["icon"]) + "  index=" + str(info["icon_index"]))
        print("        起始目录: " + str(info["work_dir"]))
        print("        窗口模式: " + str(info["window_mode"]))
        print("        说明   : " + str(info["desc"]))
        print("        文件头 : " + info["header"] + ("  (正确)" if info["header_ok"] else "  (异常!))"))
    else:
        print("        " + str(info))

url_path = make_pubconsole_url_shortcut()
if url_path is None:
    print("  [--]  跳过公网控制台快捷方式（config.json 里没配 publicUrl）")
else:
    try:
        with open(url_path, encoding="ascii") as f:
            url_body = f.read()
        url_ok = ("URL=" + PUBCONSOLE_URL + "/admin") in url_body
    except OSError:
        url_ok = False
    all_ok = all_ok and url_ok
    print(("  [OK]  " if url_ok else "  [!!]  ") + url_path)
    print("        指向   : " + PUBCONSOLE_URL + "/admin")

print("\n结果：" + ("全部校验通过" if all_ok else "存在校验失败项"))
sys.exit(0 if all_ok else 1)
