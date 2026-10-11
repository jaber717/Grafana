#!/usr/bin/env python3
"""Minimal Zabbix JSON-RPC stand-in for ISOLATED acceptance tests only (dummy credentials, answers fixed fake data).

It implements just what the Grafana Zabbix datasource health check and the item-map tool call:
apiinfo.version, user.login, user.logout, host.get, item.get, hostgroup.get, history.get/trend.get (empty).
Usage: mock-zabbix.py <cert.pem> <key.pem> [port]      (listens on 0.0.0.0:<port>, default 8443, TLS 1.2+)
"""
import json, ssl, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USER, PASSWORD = "grafana-ro", None
HOSTS = {"SITE-A": "10001", "SITE-B": "10002", "STC": "10003", "MOBILY": "10004"}


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        sys.stderr.write("mock-zabbix: " + fmt % a + "\n")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        m, p, i = body.get("method"), body.get("params") or {}, body.get("id")
        if m == "apiinfo.version":
            res = "7.0.0"
        elif m == "user.login":
            res = "mock-session-token"
        elif m in ("user.logout", "user.checkAuthentication"):
            res = True
        elif m == "host.get":
            names = (p.get("filter") or {}).get("host") or list(HOSTS)
            res = [{"hostid": HOSTS[n], "host": n, "name": n} for n in names if n in HOSTS]
        elif m == "item.get":
            res = []
        else:
            res = []
        out = json.dumps({"jsonrpc": "2.0", "result": res, "id": i}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


if __name__ == "__main__":
    cert, key = sys.argv[1], sys.argv[2]
    port = int(sys.argv[3]) if len(sys.argv) > 3 else 8443
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    srv = ThreadingHTTPServer(("0.0.0.0", port), H)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    srv.serve_forever()
