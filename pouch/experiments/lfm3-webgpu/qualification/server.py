"""Static qualification-only server, bound to loopback with an experimental CSP."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy','same-origin')
        self.send_header('Cross-Origin-Embedder-Policy','require-corp')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://api.bayleaf.dev; style-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'")
        self.send_header('Cache-Control','no-cache')
        super().end_headers()
if __name__ == '__main__':
    os.chdir(Path(__file__).parent)
    ThreadingHTTPServer(('127.0.0.1',8768),Handler).serve_forever()
