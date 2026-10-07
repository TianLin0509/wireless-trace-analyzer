"""本地预览构建产物，响应头与线上 Caddy 一致（CSP 等），用于真实环境等价测试。
用法：python tools/serve_dist.py [端口]"""
import http.server, socketserver, sys, os, functools

CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:; "
       "img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; "
       "form-action 'none'; frame-ancestors 'none'")

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript'}
    def end_headers(self):
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def log_message(self, *a):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5318
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dist')
socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', port), functools.partial(H, directory=root)) as s:
    s.serve_forever()
