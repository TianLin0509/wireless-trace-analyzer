#!/usr/bin/env python3
from __future__ import annotations

import os
import threading
import time
import webbrowser

from wireless_trace_viewer_app import create_app
from wireless_trace_viewer_app.config import APP_TITLE, HOST, PORT


def open_browser_later() -> None:
    time.sleep(1.0)
    webbrowser.open(f"http://{HOST}:{PORT}")


def main() -> None:
    print("=" * 70)
    print(APP_TITLE)
    print(f"本地访问地址：http://{HOST}:{PORT}")
    print("按 Ctrl+C 停止服务")
    print("=" * 70)
    if os.environ.get("NO_BROWSER", "0") != "1":
        threading.Thread(target=open_browser_later, daemon=True).start()
    create_app().run(host=HOST, port=PORT, debug=False, threaded=True)


if __name__ == "__main__":
    main()
