#!/usr/bin/env python3
"""
Локальный сервер голосового помощника.

1. Раздаёт файлы веб-приложения по адресу http://localhost:8765
   (localhost — безопасный контекст: браузер разрешает микрофон и установку PWA).
2. Принимает команды запуска программ: POST /api/open {"app": "notepad"}.
   Запускаются только программы из белого списка ALLOWED_APPS.

Зависимостей нет — только стандартная библиотека Python 3.8+.
"""
import json
import os
import platform
import subprocess
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", 8765))
ROOT = os.path.dirname(os.path.abspath(__file__))
OS = platform.system()  # 'Windows' | 'Darwin' | 'Linux'

# Белый список: ключ -> команда для каждой ОС
ALLOWED_APPS = {
    "notepad":    {"Windows": ["notepad"],           "Darwin": ["open", "-a", "TextEdit"],        "Linux": ["gedit"]},
    "calculator": {"Windows": ["calc"],              "Darwin": ["open", "-a", "Calculator"],      "Linux": ["gnome-calculator"]},
    "explorer":   {"Windows": ["explorer"],          "Darwin": ["open", os.path.expanduser("~")], "Linux": ["xdg-open", os.path.expanduser("~")]},
    "paint":      {"Windows": ["mspaint"],           "Darwin": ["open", "-a", "Preview"],         "Linux": ["kolourpaint"]},
    "terminal":   {"Windows": ["cmd", "/c", "start", "cmd"], "Darwin": ["open", "-a", "Terminal"], "Linux": ["x-terminal-emulator"]},
    "taskmgr":    {"Windows": ["taskmgr"],           "Darwin": ["open", "-a", "Activity Monitor"], "Linux": ["gnome-system-monitor"]},
    "settings":   {"Windows": ["cmd", "/c", "start", "ms-settings:"], "Darwin": ["open", "-a", "System Settings"], "Linux": ["gnome-control-center"]},
    "control":    {"Windows": ["control"],           "Darwin": ["open", "-a", "System Settings"], "Linux": ["gnome-control-center"]},
    "word":       {"Windows": ["cmd", "/c", "start", "winword"],   "Darwin": ["open", "-a", "Microsoft Word"],       "Linux": ["libreoffice", "--writer"]},
    "excel":      {"Windows": ["cmd", "/c", "start", "excel"],     "Darwin": ["open", "-a", "Microsoft Excel"],      "Linux": ["libreoffice", "--calc"]},
    "powerpoint": {"Windows": ["cmd", "/c", "start", "powerpnt"],  "Darwin": ["open", "-a", "Microsoft PowerPoint"], "Linux": ["libreoffice", "--impress"]},
    "browser":    {"Windows": ["cmd", "/c", "start", "https://www.google.com"], "Darwin": ["open", "https://www.google.com"], "Linux": ["xdg-open", "https://www.google.com"]},
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stdout.write("[api] " + (fmt % args) + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/ping":
            return self._json(200, {"ok": True, "os": OS, "apps": sorted(ALLOWED_APPS)})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/open":
            return self._json(404, {"ok": False, "error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"ok": False, "error": "bad json"})
        app = str(data.get("app", ""))
        cmd = ALLOWED_APPS.get(app, {}).get(OS)
        if not cmd:
            return self._json(400, {"ok": False, "error": f"программа '{app}' не поддерживается на {OS}"})
        try:
            subprocess.Popen(cmd, shell=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self._json(200, {"ok": True, "app": app})
        except OSError as e:
            return self._json(500, {"ok": False, "error": str(e)})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}/"
    print(f"Голосовой помощник запущен: {url}")
    print("Откройте адрес в Google Chrome или Microsoft Edge. Для остановки закройте это окно (Ctrl+C).")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
