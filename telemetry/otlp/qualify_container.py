"""Full OWUI artifact qualification, isolated synthetic Docker network only.

python3 telemetry/otlp/qualify_container.py <locally-built-image> <postgres-image> [60000|300000] [full|boot]
Uses only uniquely named owned containers. No production credentials or calls.
"""
import json
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = Path(__file__).resolve().parent


def sink():
    root = Path("/fixture")
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            body = json.dumps({"object": "list", "data": [{"id": "synthetic-model", "object": "model", "created": 1, "owned_by": "local"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            body = self.rfile.read(int(self.headers["content-length"]))
            if self.path == "/v1/otlp/metrics":
                # Keep only source-minimized metrics, never model API bodies.
                assert b"LOCAL_ONLY" not in body and b"synthetic-model" not in body
                assert self.headers.get("Authorization") == "Bearer synthetic-local-only-write-capability"
                root.joinpath("capture.pb").write_bytes(body)
                self.send_response(200)
                self.send_header("Content-Type", "application/x-protobuf")
                self.end_headers()
                return
            request = json.loads(body)
            if request.get("stream"):
                chunk = dict(id="synthetic", object="chat.completion.chunk", created=1, model="synthetic-model", choices=[dict(index=0, delta=dict(role="assistant", content="local fixture okay"), finish_reason=None)])
                body = ("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode()
                content_type = "text/event-stream"
            else:
                body = json.dumps(dict(id="synthetic", object="chat.completion", created=1, model="synthetic-model", choices=[dict(index=0, message=dict(role="assistant", content="local fixture okay"), finish_reason="stop")], usage=dict(prompt_tokens=1, completion_tokens=1, total_tokens=2))).encode()
                content_type = "application/json"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    plain = ThreadingHTTPServer(("0.0.0.0", 8090), Handler)
    threading.Thread(target=plain.serve_forever, daemon=True).start()
    tls = ThreadingHTTPServer(("0.0.0.0", 443), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(root / "cert.pem", root / "key.pem")
    tls.socket = context.wrap_socket(tls.socket, server_side=True)
    tls.serve_forever()


def docker(*args, input=None, timeout=120):
    return subprocess.check_output(["docker", *args], input=input, timeout=timeout, stderr=subprocess.STDOUT if args[0] == "logs" else subprocess.PIPE).decode().strip()


def qualify(image, pg_image, interval="300000", mode="full"):
    if mode not in ("full", "boot"):
        raise ValueError("unsupported_qualification_mode")
    prefix = "bayleaf-otlp-q-" + uuid.uuid4().hex[:10]
    network, app, pg, fixture = [prefix + suffix for suffix in ("-net", "-app", "-pg", "-fixture")]
    names = []
    proof = dict(status="incomplete", production_requests=0, interval_ms=int(interval), internal_network=True, published_ports=False, image=docker("image", "inspect", image, "--format", "{{.Id}}"), architecture=docker("image", "inspect", image, "--format", "{{.Architecture}}"), postgres_image=docker("image", "inspect", pg_image, "--format", "{{.Id}}"))
    proof["mode"] = mode
    platform = "linux/" + proof["architecture"]
    drift_code = "from pathlib import Path; import os; p=Path('/app/backend/open_webui/utils/telemetry/metrics.py'); p.write_bytes(p.read_bytes()+b'\\n# synthetic drift\\n'); os.execvp('python',['python','/opt/bayleaf-otlp/startup_patch.py'])"
    drift_command = ["docker", "run", "--rm", "--platform", platform, "--network", "none"]
    for flag in ("ENABLE_OTEL", "ENABLE_OTEL_METRICS", "ENABLE_OTEL_TRACES", "ENABLE_OTEL_LOGS"):
        drift_command += ["-e", flag + "=false"]
    refused = subprocess.run([*drift_command, image, "python", "-c", drift_code], capture_output=True, timeout=30)
    assert refused.returncode == 1 and b"OTLP startup refused" in refused.stderr
    proof["actual_container_source_drift_refused"] = True
    root = Path(tempfile.gettempdir()) / "opencode"
    root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=prefix, dir=root) as temporary:
        temporary = Path(temporary)
        shutil.copyfile(__file__, temporary / "qualify_container.py")
        (temporary / "cert.conf").write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=telemetry.bayleaf.dev\n[ext]\nsubjectAltName=DNS:telemetry.bayleaf.dev\nbasicConstraints=critical,CA:TRUE\n")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", str(temporary / "cert.conf"), "-keyout", str(temporary / "key.pem"), "-out", str(temporary / "cert.pem")], check=True, capture_output=True)
        docker("network", "create", "--internal", network)
        try:
            print("starting isolated synthetic PostgreSQL and TLS fixture", flush=True)
            docker("run", "-d", "--name", pg, "--network", network, "--network-alias", "pg", "--memory", "512m", "--cpus", "1", "--tmpfs", "/var/lib/postgresql/data:rw,size=256m", "-e", "POSTGRES_PASSWORD=synthetic-local-only", "-e", "POSTGRES_DB=synthetic", pg_image)
            names.append(pg)
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                try:
                    docker("exec", pg, "pg_isready", "-U", "postgres", "-d", "synthetic", timeout=5)
                    break
                except subprocess.CalledProcessError:
                    time.sleep(1)
            else:
                raise RuntimeError("synthetic_pg_start_timeout")
            fixture_image = docker("image", "inspect", "python:3.11-slim", "--format", "{{.Id}}")
            docker("run", "-d", "--name", fixture, "--network", network, "--network-alias", "fixture", "--network-alias", "telemetry.bayleaf.dev", "--memory", "128m", "-v", str(temporary) + ":/fixture", fixture_image, "python", "/fixture/qualify_container.py", "--sink")
            names.append(fixture)
            settings = dict(
                ENABLE_OTEL="true", ENABLE_OTEL_METRICS="true", ENABLE_OTEL_TRACES="false", ENABLE_OTEL_LOGS="false",
                OTEL_METRICS_OTLP_SPAN_EXPORTER="http", OTEL_METRICS_EXPORTER_OTLP_ENDPOINT="https://telemetry.bayleaf.dev/v1/otlp/metrics",
                OTEL_METRICS_EXPORT_INTERVAL_MILLIS=interval, OTEL_EXPORTER_OTLP_METRICS_TIMEOUT="2", OTEL_METRIC_EXPORT_TIMEOUT="3000",
                OTEL_EXPORTER_OTLP_METRICS_COMPRESSION="none", OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE="CUMULATIVE",
                OTEL_METRICS_EXEMPLAR_FILTER="always_off", OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED="false",
                OTEL_TRACES_EXPORTER="none", OTEL_LOGS_EXPORTER="none", OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer synthetic-local-only-write-capability",
                OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE="/fixture/cert.pem",
                DATABASE_URL="postgresql://postgres:synthetic-local-only@pg:5432/synthetic", DATABASE_POOL_SIZE="10",
                WEBUI_SECRET_KEY="synthetic-local-only-container-secret-key", ENABLE_SIGNUP="true", ENABLE_LOGIN_FORM="true",
                ENABLE_OLLAMA_API="false", ENABLE_OPENAI_API="true", OPENAI_API_BASE_URL="http://fixture:8090/v1", OPENAI_API_KEY="synthetic-local-only",
                ENABLE_VERSION_UPDATE_CHECK="false", OFFLINE_MODE="true", HF_HUB_OFFLINE="1", RAG_EMBEDDING_ENGINE="openai",
                DO_NOT_TRACK="true", SCARF_NO_ANALYTICS="true", ANONYMIZED_TELEMETRY="false", UVICORN_WORKERS="1",
            )
            command = ["run", "-d", "--platform", platform, "--name", app, "--network", network, "--network-alias", "owui", "--memory", "3g", "--cpus", "2", "-v", str(temporary) + ":/fixture:ro"]
            for k, v in settings.items():
                command.extend(["-e", k + "=" + v])
            docker(*command, image)
            names.append(app)
            def request(path, data=None, token=None, method=None):
                headers = {"Content-Type": "application/json"}
                if token:
                    headers["Authorization"] = "Bearer " + token
                payload = dict(url="http://owui:8080" + path, data=data, headers=headers, method=method)
                code = "import json,sys,urllib.request; p=json.load(sys.stdin); d=p.pop('data'); r=urllib.request.Request(data=None if d is None else json.dumps(d).encode(),**p); sys.stdout.buffer.write(urllib.request.urlopen(r,timeout=40).read())"
                return docker("exec", "-i", fixture, "python", "-c", code, input=json.dumps(payload).encode(), timeout=45).encode()
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                try:
                    if json.loads(request("/health")).get("status"):
                        break
                except Exception:
                    if docker("inspect", app, "--format", "{{.State.Running}}") != "true":
                        raise RuntimeError("owui_container_exited_before_health")
                    time.sleep(2)
            else:
                raise RuntimeError("owui_health_timeout")
            proof["health"] = True
            proof["version"] = json.loads(request("/api/version"))
            print("full OWUI healthy; checking synthetic auth, JSON and SSE", flush=True)
            signup = json.loads(request("/api/v1/auths/signup", dict(name="LOCAL_ONLY", email="synthetic@example.invalid", password="synthetic-local-only-password")))
            token = signup["token"]
            models = json.loads(request("/api/models", token=token))
            assert any(m["id"] == "synthetic-model" for m in models["data"])
            payload = dict(model="synthetic-model", messages=[dict(role="user", content="LOCAL_ONLY_PROMPT")], stream=False)
            answer = request("/api/chat/completions", payload, token)
            assert b"local fixture okay" in answer
            payload["stream"] = True
            streamed = request("/api/chat/completions", payload, token)
            assert b"local fixture okay" in streamed and b"[DONE]" in streamed
            proof.update(synthetic_auth=True, json_inference=True, sse_inference=True)
            if mode == "boot":
                check = "import sys,json,hashlib;from pathlib import Path;sys.path.insert(0,'/opt/bayleaf-otlp');from startup_patch import patch,validate_versions,validate_environment;validate_versions();validate_environment();patch(Path('/app/backend'));print(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('/app/backend/open_webui/utils/telemetry').glob('*.py') if p.name in ['metrics.py','setup.py','bayleaf_runtime.py','bayleaf_source_policy.py']}))"
                proof["installed_sha256"] = json.loads(docker("exec", app, "python", "-c", check).splitlines()[-1])
                db_check = "import os,json;from sqlalchemy import create_engine,text;from open_webui.utils.telemetry.bayleaf_runtime import bounded_engine;a=create_engine(os.environ['DATABASE_URL']);b=bounded_engine(a);c=b.connect();assert c.execute(text('SELECT 1')).scalar()==1;print(json.dumps({k:c.execute(text('SHOW '+k)).scalar() for k in ['statement_timeout','lock_timeout','default_transaction_read_only']}));c.close();b.dispose();a.dispose()"
                proof["metrics_pg_connection"] = json.loads(docker("exec", app, "python", "-c", db_check).splitlines()[-1])
                logs = docker("logs", app)
                assert "[bayleaf] rung-3 harness alive" in logs and "metrics source minimization verified" in logs
                proof["sentinel"] = True
                proof["pid1_cmdline"] = docker("exec", app, "python", "-c", "print(open('/proc/1/cmdline','rb').read().replace(b'\\0',b' ').decode())")
                assert "uvicorn open_webui.main:app" in proof["pid1_cmdline"]
                proof["resources"] = docker("stats", "--no-stream", "--format", "{{.CPUPerc}} {{.MemUsage}}", app)
                proof["status"] = "full_container_boot_and_inference_pass"
                return
            try:
                request("/LOCAL_ONLY_UNMATCHED?token=LOCAL_ONLY_QUERY", method="PROPFIND")
            except subprocess.CalledProcessError:
                pass
            # Independent process, same exact installed runtime and synthetic DB:
            # verify real server timeouts/pool behavior without reaching app state.
            pg_code = '''import importlib.util,json,time,os,sys,types
from sqlalchemy import create_engine,text
sys.path.insert(0,'/app/backend')
from open_webui.utils.telemetry.bayleaf_runtime import bounded_engine,gauge_value
a=create_engine(os.environ['DATABASE_URL']); b=bounded_engine(a)
with b.connect() as c:
 settings={k:c.execute(text('SHOW '+k)).scalar() for k in ['statement_timeout','lock_timeout','default_transaction_read_only']}
assert settings=={'statement_timeout':'200ms','lock_timeout':'100ms','default_transaction_read_only':'on'},settings
first=b.connect(); started=time.monotonic(); refused=False
try:
 b.connect()
except Exception: refused=True
pool_ms=(time.monotonic()-started)*1000; first.close(); assert refused and 80<pool_ms<1000,pool_ms
started=time.monotonic()
try:
 with b.connect() as c: c.execute(text('SELECT pg_sleep(1)'))
 raise AssertionError('statement_not_bounded')
except Exception as e:
 assert getattr(getattr(e,'orig',None),'pgcode',None)=='57014'
statement_ms=(time.monotonic()-started)*1000; assert 150<statement_ms<1500,statement_ms
lock=a.connect(); tx=lock.begin(); lock.execute(text('LOCK TABLE "user" IN ACCESS EXCLUSIVE MODE'))
started=time.monotonic()
def count(e):
 with e.connect() as c: return c.execute(text('SELECT count(*) FROM "user"')).scalar()
assert gauge_value(count,b) is None
lock_ms=(time.monotonic()-started)*1000; assert 70<lock_ms<1000,lock_ms
tx.rollback(); lock.close()
assert gauge_value(lambda e: (_ for _ in ()).throw(AssertionError('backoff_not_respected')),b) is None
b._bayleaf_retry_at=0
assert gauge_value(count,b)==1
dead=bounded_engine(types.SimpleNamespace(dialect=a.dialect,url=a.url.set(port=1))); attempts=[]
def unavailable(e):
 attempts.append(1)
 with e.connect() as c: return 1
started=time.monotonic(); assert gauge_value(unavailable,dead) is None
unavailable_ms=(time.monotonic()-started)*1000
assert gauge_value(unavailable,dead) is None and len(attempts)==1
print(json.dumps(dict(settings=settings,pool_wait_ms=round(pool_ms,2),statement_cancel_ms=round(statement_ms,2),lock_cancel_ms=round(lock_ms,2),unavailable_ms=round(unavailable_ms,2),unavailable_backoff=True,failure_backoff=True,healthy_count_recovered=True,max_metrics_connections=1)))
dead.dispose();b.dispose();a.dispose()
'''
            proof["postgresql"] = json.loads(docker("exec", "-i", app, "python", "-", input=pg_code.encode(), timeout=30).splitlines()[-1])
            print("PG timeout/pool checks passed; awaiting native periodic TLS export", flush=True)
            deadline = time.monotonic() + int(interval) / 1000 + 30
            while time.monotonic() < deadline and not (temporary / "capture.pb").exists():
                time.sleep(1)
            assert (temporary / "capture.pb").exists(), "no_periodic_native_export"
            wire = (temporary / "capture.pb").read_bytes()
            script = f'''import {{otlpHook}} from {json.dumps((HERE / 'worker-adapter.mjs').as_uri())};
const a=[];for await(const c of process.stdin)a.push(c);const b=Buffer.concat(a);
const e=await otlpHook(new Request('http://synthetic/v1/otlp/metrics',{{method:'POST',headers:{{'content-type':'application/x-protobuf'}},body:b}}),{{source:'owui',now:Date.now()}});
console.log(JSON.stringify({{points:e.points.length,names:[...new Set(e.points.map(p=>p.name))],routes:[...new Set(e.points.flatMap(p=>p.attributes.route?[p.attributes.route]:[]))],methods:[...new Set(e.points.flatMap(p=>p.attributes.method?[p.attributes.method]:[]))]}}));'''
            proof["native_export"] = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script], input=wire))
            assert len(proof["native_export"]["names"]) == 5
            assert "OTHER" in proof["native_export"]["methods"]
            proof["native_metrics_connections"] = int(docker("exec", pg, "psql", "-U", "postgres", "-d", "synthetic", "-Atc", "SELECT count(*) FROM pg_stat_activity WHERE application_name='bayleaf-otlp'"))
            assert proof["native_metrics_connections"] == 1
            (HERE / "container-fixture.pb").write_bytes(wire)
            logs = docker("logs", app)
            assert "[bayleaf] rung-3 harness alive" in logs and "metrics source minimization verified" in logs
            proof["sentinel"] = True
            proof["traces_logs_disabled"] = docker("exec", app, "python", "-c", "import os; assert os.environ['ENABLE_OTEL_TRACES']=='false' and os.environ['ENABLE_OTEL_LOGS']=='false'; print('true')") == "true"
            proof["pid1"] = docker("exec", app, "python", "-c", "print(open('/proc/1/comm').read().strip())")
            proof["resources"] = docker("stats", "--no-stream", "--format", "{{.CPUPerc}} {{.MemUsage}}", app)
            proof["status"] = "full_container_synthetic_pass"
        except Exception as e:
            proof["failure"] = type(e).__name__ + ":" + str(e)[:200]
            # All logs here are synthetic only; keep them out of public evidence.
            if app in names:
                (root / (prefix + "-app.log")).write_text(docker("logs", app))
            raise
        finally:
            for name in reversed(names):
                docker("rm", "-f", name)
            docker("network", "rm", network)
            proof["owned_containers_removed"] = names
            if mode == "full":
                (HERE / "container-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
                (HERE / f"container-proof-{interval}.json").write_text(json.dumps(proof, indent=2) + "\n")
            else:
                (HERE / f"container-proof-{proof['architecture']}-boot.json").write_text(json.dumps(proof, indent=2) + "\n")
            print(json.dumps(proof, indent=2), flush=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["--sink"]:
        sink()
    else:
        qualify(*sys.argv[1:])
