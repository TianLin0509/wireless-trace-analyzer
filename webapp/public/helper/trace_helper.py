#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Trace A/B 分析台 · 本机助手

作用：让网页 https://trace.lt-stockpartner.tech 能按“粘贴的文件夹路径”直接读取本机或网络盘
（如 \\\\100.100.97.83\\cellDT）上的 Trace CSV，不用再在选择窗口里点文件夹。

安全边界：
- 只监听本机 127.0.0.1，局域网里的其他电脑连不上；
- 只接受分析台网页发来的请求（校验 Origin 与 Host），其他网站读不到；
- 只能列出、读取文件名形如 Dest_Txxx_*.csv 的 Trace 文件，且不能跳出所粘贴的文件夹；
- 只读，不写、不删、不改任何文件；数据只在本机传给浏览器，不经过任何外部服务器。

用法：双击运行（或 python trace_helper.py）。窗口里输入 Y 回车可设为开机自动后台运行。
      python trace_helper.py --uninstall   取消开机自启
只用 Python 标准库，不需要 pip 安装任何东西（Python 3.7 及以上）。
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = "1.0.0"
PORT = 17861
SITE_ORIGINS = {"https://trace.lt-stockpartner.tech"}
# 本机调试 / 自动化测试用的本地页面（只在本机，不影响安全边界）
LOCAL_ORIGIN_RE = re.compile(r"^http://(127\.0\.0\.1|localhost):\d{2,5}$")
TRACE_FILE_RE = re.compile(r"Dest_T\d{3,4}_.*\.csv$", re.I)
MAX_FILES = 5000
MAX_DEPTH = 12
CHUNK = 1024 * 1024
SHORTCUT_NAME = "Trace分析台本机助手.lnk"

if sys.stdout is None:  # pythonw 后台运行时没有控制台
    log_dir = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "TraceHelper")
    os.makedirs(log_dir, exist_ok=True)
    sys.stdout = sys.stderr = open(os.path.join(log_dir, "helper.log"), "a", encoding="utf-8", buffering=1)
else:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def normalize_root(text):
    """规范化粘贴的路径：去引号与空白，统一分隔符，去掉末尾分隔符（盘符根目录除外）。"""
    p = (text or "").strip().strip("\"'").strip()
    if os.sep == "/":
        p = p.replace("\\", "/")
    else:
        p = p.replace("/", "\\")
    if re.fullmatch(r"[A-Za-z]:", p):
        p += os.sep
    while len(p) > 1 and p.endswith(os.sep) and not re.fullmatch(r"[A-Za-z]:[\\/]", p):
        p = p[:-1]
    return p


def root_name(root):
    name = os.path.basename(root.rstrip("\\/"))
    return name or root.rstrip("\\/") or root


def scan(root):
    """在 root 下找 Dest_Txxx_*.csv。返回相对路径以“根目录名/”开头，与网页里选择文件夹时的格式一致。"""
    started = time.time()
    name = root_name(root)
    files, skipped, truncated = [], 0, False
    stack = [(root, [], 0)]
    while stack:
        path, parts, depth = stack.pop()
        try:
            with os.scandir(path) as it:
                entries = list(it)
        except OSError:
            skipped += 1
            continue
        for e in entries:
            try:
                if e.is_dir(follow_symlinks=False):
                    if depth < MAX_DEPTH:
                        stack.append((e.path, parts + [e.name], depth + 1))
                elif TRACE_FILE_RE.search(e.name) and e.is_file():
                    if len(files) >= MAX_FILES:
                        truncated = True
                        break
                    st = e.stat()
                    files.append({"rel": "/".join([name] + parts + [e.name]), "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
            except OSError:
                skipped += 1
        if truncated:
            break
    return {"root": root, "rootName": name, "files": files, "truncated": truncated, "skipped": skipped,
            "seconds": round(time.time() - started, 2)}


def resolve_file(root, rel):
    """把 根目录 + 相对路径 拼成实际文件路径；拒绝跳出根目录或不是 Trace CSV 的请求。"""
    parts = [p for p in (rel or "").split("/")]
    if len(parts) < 2 or parts[0] != root_name(root):
        raise PermissionError("路径不在所选文件夹内")
    inner = parts[1:]
    for p in inner:
        if p in ("", ".", "..") or "\\" in p or "/" in p or ":" in p:
            raise PermissionError("路径不合法")
    if not TRACE_FILE_RE.search(inner[-1]):
        raise PermissionError("只允许读取 Dest_Txxx_*.csv 文件")
    full = os.path.join(root, *inner)
    if not os.path.isfile(full):
        raise FileNotFoundError("文件不存在（可能已被移动或删除）")
    return full


class Handler(BaseHTTPRequestHandler):
    server_version = "TraceHelper/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    # ---- 安全校验 ----
    def origin_ok(self):
        o = self.headers.get("Origin") or ""
        return o in SITE_ORIGINS or bool(LOCAL_ORIGIN_RE.match(o)) or o in self.server.extra_origins

    def host_ok(self):
        # 防 DNS 重绑定：只认 127.0.0.1 / localhost
        host = (self.headers.get("Host") or "").lower()
        return host in ("127.0.0.1:%d" % self.server.server_port, "localhost:%d" % self.server.server_port)

    def cors(self):
        o = self.headers.get("Origin")
        if o and self.origin_ok():
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, X-File-Size")
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")

    def reply_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        if not self.host_ok() or not self.origin_ok():
            return self.reply_json(403, {"error": "forbidden"})
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Allow-Private-Network", "true")  # 旧版 Chrome 的本机访问预检
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.host_ok():
            return self.reply_json(403, {"error": "Host 不被允许"})
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/ping":
            return self.reply_json(200, {"ok": True, "name": "trace-helper", "version": VERSION})
        if not self.origin_ok():
            return self.reply_json(403, {"error": "只接受 Trace 分析台网页的请求"})
        try:
            if url.path == "/scan":
                root = normalize_root(q.get("path", ""))
                if not root or not os.path.isabs(root):
                    return self.reply_json(400, {"error": "请粘贴完整路径，例如 D:\\data\\基线 或 \\\\服务器\\共享\\目录"})
                if not os.path.isdir(root):
                    return self.reply_json(404, {"error": "找不到这个文件夹：%s（请确认路径正确，并且在资源管理器里能打开）" % root})
                res = scan(root)
                print("[%s] 扫描 %s：%d 个 Trace 文件，%.1f 秒" % (time.strftime("%H:%M:%S"), root, len(res["files"]), res["seconds"]))
                return self.reply_json(200, res)
            if url.path == "/file":
                root = normalize_root(q.get("root", ""))
                return self.send_file(resolve_file(root, q.get("rel", "")))
            return self.reply_json(404, {"error": "未知接口"})
        except PermissionError as e:
            return self.reply_json(403, {"error": str(e)})
        except FileNotFoundError as e:
            return self.reply_json(404, {"error": str(e)})
        except Exception as e:  # 网络盘断开等
            return self.reply_json(500, {"error": "%s: %s" % (type(e).__name__, e)})

    def send_file(self, full):
        size = os.path.getsize(full)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip()) if rng else None
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                self.send_response(416)
                self.cors()
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        else:
            self.send_response(200)
        length = max(0, end - start + 1)
        self.cors()
        self.send_header("Content-Type", "text/csv")
        self.send_header("Content-Length", str(length))
        self.send_header("X-File-Size", str(size))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(full, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    buf = f.read(min(CHUNK, left))
                    if not buf:
                        break
                    self.wfile.write(buf)
                    left -= len(buf)
        except (ConnectionError, BrokenPipeError):
            pass  # 网页取消了读取


# ---- 开机自启（Windows 启动文件夹里的快捷方式，用 pythonw 后台运行，无窗口） ----
def startup_dir():
    return os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")


def pythonw():
    cand = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    return cand if os.path.isfile(cand) else sys.executable


def install_autostart():
    link = os.path.join(startup_dir(), SHORTCUT_NAME)
    script = os.path.abspath(__file__)
    ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{0}');$s.TargetPath='{1}';"
          "$s.Arguments='\"{2}\"';$s.WorkingDirectory='{3}';$s.WindowStyle=7;$s.Save()").format(
        link.replace("'", "''"), pythonw().replace("'", "''"), script.replace("'", "''"), os.path.dirname(script).replace("'", "''"))
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], check=True,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=30)
    return link


def uninstall_autostart():
    link = os.path.join(startup_dir(), SHORTCUT_NAME)
    if os.path.exists(link):
        os.remove(link)
        return True
    return False


def autostart_installed():
    return os.name == "nt" and os.path.exists(os.path.join(startup_dir(), SHORTCUT_NAME))


def already_running(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/ping" % port, timeout=2) as r:
            return json.loads(r.read().decode("utf-8")).get("version")
    except Exception:
        return None


def pause_exit(code=0):
    if sys.stdin and sys.stdin.isatty():
        try:
            input("按回车关闭窗口…")
        except EOFError:
            pass
    sys.exit(code)


def main():
    args = sys.argv[1:]
    port = PORT
    extra = set()
    if "--port" in args:
        port = int(args[args.index("--port") + 1])
    if "--allow-origin" in args:
        extra.add(args[args.index("--allow-origin") + 1])
    if "--uninstall" in args:
        print("已取消开机自启。" if uninstall_autostart() else "本来就没有设置开机自启。")
        return pause_exit()
    interactive = sys.stdin is not None and sys.stdin.isatty() and "--no-prompt" not in args

    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        v = already_running(port)
        if v:
            print("本机助手已经在运行（v%s），不用重复启动。可以直接回网页使用。" % v)
        else:
            print("端口 %d 被其他程序占用，本机助手无法启动。" % port)
        return pause_exit(0 if v else 1)
    server.daemon_threads = True
    server.extra_origins = extra
    print("=" * 60)
    print(" Trace A/B 分析台 · 本机助手 v%s 已启动（127.0.0.1:%d）" % (VERSION, port))
    print(" 只读 Dest_Txxx_*.csv；只接受分析台网页的请求；数据不出本机。")
    print(" 回到网页，粘贴文件夹路径后点“打开”即可。")
    print("=" * 60)
    if not interactive:
        server.serve_forever()
        return
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    if os.name == "nt" and not autostart_installed():
        print("\n要不要设为开机自动在后台运行（无窗口，以后不用再双击）？")
        try:
            ans = input("输入 Y 回车 = 设置并转入后台；直接回车 = 只这次运行（关掉窗口即停止）：").strip().lower()
        except EOFError:
            ans = ""
        if ans in ("y", "yes", "是"):
            try:
                link = install_autostart()
                server.shutdown()
                server.server_close()
                subprocess.Popen([pythonw(), os.path.abspath(__file__), "--no-prompt", "--port", str(port)],
                                 creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                 close_fds=True, cwd=os.path.dirname(os.path.abspath(__file__)))
                time.sleep(1.5)
                ok = already_running(port)
                print("已设置开机自启（%s）。" % link)
                print("助手已转入后台运行，可以关闭这个窗口了。" if ok else "后台启动没有成功，请重新双击运行本文件。")
                print("以后想取消：python trace_helper.py --uninstall")
                return pause_exit()
            except Exception as e:
                print("设置开机自启失败：%s。本次继续在这个窗口里运行。" % e)
    print("\n运行中…（关闭这个窗口即停止）")
    try:
        while t.is_alive():
            t.join(1)
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
