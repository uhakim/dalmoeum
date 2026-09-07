"""Single-classroom service. Run `python server.py init`, then `python server.py`."""
from __future__ import annotations

import argparse
from contextlib import closing
import base64
import getpass
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import tempfile
import time
from datetime import date
from functools import wraps

from flask import Flask, Response, g, jsonify, request, send_file, send_from_directory, session, stream_with_context
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent
PHASES = {"new", "crescent", "first", "waxing", "full", "waning", "last", "old", "hidden"}
ASSETS = {"cloud-config.js", "cloud.js", "index.html", "style.css", "app.js", "classroom.js", "classroom.css", "teacher.html", "teacher.js", "reports.html", "reports.js", "moon.js"}


def empty_state():
    return {"version": 1, "profile": {}, "records": {}, "reflections": {}}


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def clean_text(value, maximum):
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError("입력 길이나 형식을 확인해 주세요.")
    return value


def valid_month(value):
    return isinstance(value, str) and re.fullmatch(r"(19\d\d|20\d\d|2100)-(0[1-9]|1[0-2])", value)


def validate_state(data):
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("지원하지 않는 기록 형식이에요.")
    if any(not isinstance(data.get(k), dict) for k in ("profile", "records", "reflections")):
        raise ValueError("기록 형식을 확인해 주세요.")
    if len(data["records"]) > 4000 or len(data["reflections"]) > 240:
        raise ValueError("한 학생이 저장할 수 있는 기록 수를 초과했어요.")
    clean = empty_state()
    for name, limit in {"className": 150, "studentName": 150, "studentNumber": 150, "place": 100, "precaution": 150}.items():
        clean["profile"][name] = clean_text(data["profile"].get(name, ""), limit)
    for day, r in data["records"].items():
        try:
            if date.fromisoformat(day).isoformat() != day or not "1900-01-01" <= day <= "2100-12-31":
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError("관찰 날짜를 확인해 주세요.") from None
        if not isinstance(r, dict) or not (r.get("phase") is None or isinstance(r.get("phase"), str) and r["phase"] in PHASES):
            raise ValueError("달 모양을 확인해 주세요.")
        observed_time = clean_text(r.get("time", ""), 5)
        if observed_time and not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", observed_time):
            raise ValueError("관찰 시각을 확인해 주세요.")
        photo = r.get("photo")
        if photo is not None:
            if not isinstance(photo, str) or len(photo) > 1500000:
                raise ValueError("사진 용량이 너무 커요.")
            match = re.fullmatch(r"data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)", photo)
            if not match:
                raise ValueError("지원하지 않는 사진 형식이에요.")
            try:
                raw = base64.b64decode(match[2], validate=True)
            except ValueError:
                raise ValueError("사진 파일을 읽지 못했어요.") from None
            if not (raw.startswith(b"\xff\xd8\xff") or raw.startswith(b"\x89PNG\r\n\x1a\n") or raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"):
                raise ValueError("사진 파일을 확인해 주세요.")
        if not photo and not r.get("phase"):
            raise ValueError("달 모양이나 사진이 필요해요.")
        clean["records"][day] = {"phase": r.get("phase"), "photo": photo, "time": observed_time, "note": clean_text(r.get("note", ""), 100)}
    for month, reflection in data["reflections"].items():
        if not valid_month(month):
            raise ValueError("관찰 월을 확인해 주세요.")
        clean["reflections"][month] = clean_text(reflection, 2000)
    return clean


def create_app(data_dir=None, testing=False):
    app = Flask(__name__, static_folder=None)
    folder = Path(data_dir or os.environ.get("DAL_DATA_DIR", ROOT / "data"))
    folder.mkdir(parents=True, exist_ok=True)
    key_file = folder / "secret.key"
    if not key_file.exists():
        # Exclusive creation makes parallel starts safe.
        try:
            with key_file.open("x", encoding="ascii") as target:
                target.write(secrets.token_hex(32))
            key_file.chmod(0o600)
        except FileExistsError:
            pass
    secret = key_file.read_text(encoding="ascii").strip()
    secure = os.environ.get("DAL_SECURE_COOKIES") == "1" and not testing
    public_origin = os.environ.get("DAL_PUBLIC_ORIGIN", "").rstrip("/")
    app.config.update(SECRET_KEY=secret, TESTING=testing, SESSION_COOKIE_NAME="dal_session", SESSION_COOKIE_HTTPONLY=True,
                      SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_SECURE=secure, MAX_CONTENT_LENGTH=24 * 1024 * 1024)
    app.config["DAL_FOLDER"] = folder
    if public_origin:
        from urllib.parse import urlparse
        parsed = urlparse(public_origin)
        if parsed.scheme != "https" and not testing:
            raise ValueError("DAL_PUBLIC_ORIGIN must be an HTTPS origin.")
        app.config["TRUSTED_HOSTS"] = [parsed.hostname, "localhost", "127.0.0.1"]

    def connection():
        if "db" not in g:
            g.db = sqlite3.connect(folder / "classroom.sqlite3", timeout=20)
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys=ON")
        return g.db

    @app.teardown_appcontext
    def close_db(_error):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    with app.app_context():
        db = connection()
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS students (
                id INTEGER PRIMARY KEY, number INTEGER NOT NULL UNIQUE, name TEXT NOT NULL,
                invite_version INTEGER NOT NULL DEFAULT 1, invite_hash TEXT UNIQUE NOT NULL,
                state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at REAL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, student_id INTEGER REFERENCES students(id),
                csrf TEXT NOT NULL, expires REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at REAL NOT NULL);
        """)
        db.commit()

    def setting(key, default=""):
        row = connection().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def invitation(student):
        return hmac.new(secret.encode(), f"student:{student['id']}:{student['invite_version']}".encode(), hashlib.sha256).hexdigest()

    def initialize(class_name, password, count):
        clean_text(class_name, 30)
        if not 12 <= len(password) <= 200:
            raise ValueError("선생님 비밀번호를 12~200자로 정해 주세요.")
        if not 1 <= count <= 40:
            raise ValueError("학생 수는 1~40명으로 설정해 주세요.")
        db = connection()
        db.execute("BEGIN IMMEDIATE")
        if setting("teacher_hash"):
            db.rollback()
            raise ValueError("이미 설정된 학급이에요. 기존 기록은 유지됩니다.")
        db.executemany("INSERT INTO settings(key,value) VALUES (?,?)", [("class_name", class_name), ("teacher_hash", generate_password_hash(password))])
        for number in range(1, count + 1):
            token = invitation({"id": number, "invite_version": 1})
            db.execute("INSERT INTO students(id,number,name,invite_hash,state) VALUES (?,?,?,?,?)", (number, number, f"{number}번 학생", digest(token), json.dumps(empty_state())))
        db.commit()

    app.initialize_classroom = initialize
    app.classroom_connection = connection

    @app.before_request
    def protect_request():
        if not request.path.startswith("/api/"):
            return None
        g.auth = None
        token = session.get("token")
        if isinstance(token, str):
            g.auth = connection().execute("SELECT * FROM sessions WHERE token_hash=? AND expires>?", (digest(token), time.time())).fetchone()
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("Origin")
            allowed_origin = public_origin or ("https://" + request.host if secure else request.host_url.rstrip("/"))
            if request.headers.get("Sec-Fetch-Site") == "cross-site" or origin and origin != allowed_origin:
                return jsonify(error="다른 사이트에서 보낸 요청은 허용되지 않아요."), 403
            if not request.is_json:
                return jsonify(error="JSON 요청이 필요해요."), 415
            if request.path not in ("/api/auth/teacher", "/api/auth/student"):
                if not g.auth:
                    return jsonify(error="다시 접속해 주세요."), 401
                if not hmac.compare_digest(request.headers.get("X-CSRF-Token", ""), g.auth["csrf"]):
                    return jsonify(error="접속 확인에 실패했어요. 새로고침해 주세요."), 403

    @app.after_request
    def headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
        if secure:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    @app.errorhandler(ValueError)
    def invalid(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error="요청이 너무 커요." if error.code == 413 else "요청을 처리할 수 없어요."), error.code

    def authenticated(role):
        def decorator(function):
            @wraps(function)
            def wrapper(*args, **kwargs):
                if not g.auth:
                    return jsonify(error="접속 링크 또는 선생님 로그인이 필요해요."), 401
                if g.auth["role"] != role:
                    return jsonify(error="이 화면에 접근할 수 없어요."), 403
                return function(*args, **kwargs)
            return wrapper
        return decorator

    def payload():
        body = request.get_json()
        if not isinstance(body, dict):
            raise ValueError("요청 형식을 확인해 주세요.")
        return body

    def allow_login(kind):
        # One classroom may share a school IP: bound teacher guesses tightly,
        # but allow enough student logins for the entire class.
        db = connection()
        stamp = time.time()
        key = digest(f"{request.remote_addr}:{kind}")
        db.execute("DELETE FROM attempts WHERE reset_at<?", (stamp,))
        db.execute("INSERT INTO attempts(key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1", (key, stamp + 900))
        count = db.execute("SELECT count FROM attempts WHERE key=?", (key,)).fetchone()[0]
        db.commit()
        return count <= (10 if kind == "teacher" else 200)

    def start_session(role, student_id=None):
        db = connection()
        if g.auth:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (g.auth["token_hash"],))
        db.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        lifetime = 12 * 3600 if role == "teacher" else 30 * 86400
        db.execute("INSERT INTO sessions VALUES (?,?,?,?,?)", (digest(token), role, student_id, csrf, time.time() + lifetime))
        db.commit()
        session.clear()
        session["token"] = token
        # Browser session cookie; server also enforces an absolute expiration.
        return jsonify(role=role, csrf=csrf)

    @app.get("/api/health")
    def health():
        return jsonify(ok=True)

    @app.post("/api/auth/teacher")
    def teacher_login():
        if not allow_login("teacher"):
            return jsonify(error="접속 시도가 많아요. 15분 뒤 다시 시도해 주세요."), 429
        password = clean_text(payload().get("password", ""), 200)
        hashed = setting("teacher_hash")
        if not hashed or not check_password_hash(hashed, password):
            return jsonify(error="비밀번호를 확인해 주세요. 학급 최초 설정이 완료되어야 접속할 수 있어요."), 401
        return start_session("teacher")

    @app.post("/api/auth/student")
    def student_login():
        if not allow_login("student"):
            return jsonify(error="접속 시도가 많아요. 잠시 뒤 다시 시도해 주세요."), 429
        token = clean_text(payload().get("token", ""), 64)
        student = connection().execute("SELECT id FROM students WHERE invite_hash=?", (digest(token),)).fetchone() if re.fullmatch(r"[a-f0-9]{64}", token) else None
        if not student:
            return jsonify(error="학생 접속 링크를 확인해 주세요. 선생님이 새 링크를 발급했을 수도 있어요."), 401
        return start_session("student", student["id"])

    @app.get("/api/me")
    def me():
        if not g.auth:
            return jsonify(error="로그인이 필요해요."), 401
        result = {"role": g.auth["role"], "csrf": g.auth["csrf"], "className": setting("class_name")}
        if g.auth["role"] == "student":
            row = connection().execute("SELECT id,number,name FROM students WHERE id=?", (g.auth["student_id"],)).fetchone()
            if not row:
                return jsonify(error="학생 정보를 찾지 못했어요."), 401
            result["student"] = dict(row)
        return jsonify(result)

    @app.post("/api/auth/logout")
    def logout():
        connection().execute("DELETE FROM sessions WHERE token_hash=?", (g.auth["token_hash"],))
        connection().commit()
        session.clear()
        return jsonify(ok=True)

    def document(student):
        data = json.loads(student["state"])
        data["profile"].update(className=setting("class_name"), studentNumber=str(student["number"]), studentName=student["name"])
        return data

    @app.get("/api/student/state")
    @authenticated("student")
    def read_state():
        row = connection().execute("SELECT * FROM students WHERE id=?", (g.auth["student_id"],)).fetchone()
        return jsonify(state=document(row), revision=row["revision"])

    @app.put("/api/student/state")
    @authenticated("student")
    def write_state():
        body = payload()
        data = validate_state(body.get("state"))
        revision = body.get("revision")
        if type(revision) is not int or revision < 0:
            raise ValueError("저장 버전이 올바르지 않아요.")
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode()) > 20 * 1024 * 1024:
            raise ValueError("학생별 저장 용량(20MB)을 초과했어요. 기록을 백업한 뒤 오래된 사진을 정리해 주세요.")
        db = connection()
        cursor = db.execute("UPDATE students SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", (encoded, time.time(), g.auth["student_id"], revision))
        db.commit()
        if cursor.rowcount != 1:
            return jsonify(error="다른 기기에서 기록이 바뀌었어요. 입력 중인 내용을 복사해 두고 새로고침한 뒤 다시 저장해 주세요.", conflict=True), 409
        row = db.execute("SELECT * FROM students WHERE id=?", (g.auth["student_id"],)).fetchone()
        return jsonify(revision=row["revision"], profile=document(row)["profile"])

    @app.get("/api/teacher/students")
    @authenticated("teacher")
    def roster():
        month = request.args.get("month", date.today().strftime("%Y-%m"))
        if not valid_month(month):
            raise ValueError("월을 확인해 주세요.")
        rows = connection().execute("SELECT * FROM students ORDER BY number")
        result = []
        for row in rows:
            data = document(row)
            records = {d: r for d, r in data["records"].items() if d.startswith(month)}
            result.append({"id": row["id"], "number": row["number"], "name": row["name"], "days": len(records), "photos": sum(bool(r["photo"]) for r in records.values()), "lastDate": max(records, default=None), "updatedAt": row["updated_at"], "hasReflection": bool(data["reflections"].get(month, "").strip())})
        return jsonify(className=setting("class_name"), students=result, month=month)

    @app.patch("/api/teacher/students/<int:student_id>")
    @authenticated("teacher")
    def rename_student(student_id):
        name = clean_text(payload().get("name", ""), 30).strip()
        if not name:
            raise ValueError("학생 이름을 입력해 주세요.")
        db = connection()
        cursor = db.execute("UPDATE students SET name=?,revision=revision+1 WHERE id=?", (name, student_id))
        db.commit()
        if cursor.rowcount != 1:
            return jsonify(error="학생을 찾지 못했어요."), 404
        return jsonify(ok=True)

    @app.patch("/api/teacher/classroom")
    @authenticated("teacher")
    def rename_class():
        name = clean_text(payload().get("className", ""), 30).strip()
        if not name:
            raise ValueError("학급 이름을 입력해 주세요.")
        db = connection()
        db.execute("UPDATE settings SET value=? WHERE key='class_name'", (name,))
        db.execute("UPDATE students SET revision=revision+1")
        db.commit()
        return jsonify(ok=True)

    @app.get("/api/teacher/invitations")
    @authenticated("teacher")
    def invitations():
        return jsonify(students=[{"id": r["id"], "number": r["number"], "name": r["name"], "path": "/s/#" + invitation(r)} for r in connection().execute("SELECT * FROM students ORDER BY number")])

    @app.post("/api/teacher/students/<int:student_id>/reset-link")
    @authenticated("teacher")
    def reset_link(student_id):
        db = connection()
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM students WHERE id=?", (student_id,)).fetchone()
        if not row:
            db.rollback()
            return jsonify(error="학생을 찾지 못했어요."), 404
        next_version = row["invite_version"] + 1
        token = invitation({"id": student_id, "invite_version": next_version})
        db.execute("UPDATE students SET invite_version=?,invite_hash=? WHERE id=?", (next_version, digest(token), student_id))
        db.execute("DELETE FROM sessions WHERE student_id=?", (student_id,))
        db.commit()
        return jsonify(path="/s/#" + token)

    @app.get("/api/teacher/students/<int:student_id>/qr.svg")
    @authenticated("teacher")
    def invitation_qr(student_id):
        import qrcode
        import qrcode.image.svg
        row = connection().execute("SELECT * FROM students WHERE id=?", (student_id,)).fetchone()
        if not row:
            return jsonify(error="학생을 찾지 못했어요."), 404
        origin = public_origin or ("https://" + request.host if secure else request.host_url.rstrip("/"))
        image = qrcode.make(origin + "/s/#" + invitation(row), image_factory=qrcode.image.svg.SvgPathImage)
        buffer = io.BytesIO()
        image.save(buffer)
        buffer.seek(0)
        return send_file(buffer, mimetype="image/svg+xml")

    @app.get("/api/teacher/reports")
    @authenticated("teacher")
    def reports():
        month = request.args.get("month", "")
        raw_ids = request.args.get("ids", "")
        if not valid_month(month) or not re.fullmatch(r"\d+(,\d+){0,39}", raw_ids):
            raise ValueError("출력할 월과 학생을 선택해 주세요.")
        ids = list(dict.fromkeys(int(i) for i in raw_ids.split(",")))
        db = connection()
        rows = db.execute(f"SELECT id FROM students WHERE id IN ({','.join('?' for _ in ids)}) ORDER BY number", ids).fetchall()
        if len(rows) != len(ids):
            raise ValueError("학생을 찾지 못했어요.")
        @stream_with_context
        def generate():
            # Stream one student's photos at a time, keeping server memory
            # bounded even when the whole class has a month full of photos.
            stream_db = connection()
            stream_db.execute("BEGIN")
            yield '{"month":' + json.dumps(month) + ',"reports":['
            for index, selected in enumerate(rows):
                row = stream_db.execute("SELECT * FROM students WHERE id=?", (selected["id"],)).fetchone()
                data = document(row)
                data["records"] = {d: r for d, r in data["records"].items() if d.startswith(month)}
                data["reflections"] = {month: data["reflections"].get(month, "")}
                if index:
                    yield ','
                yield json.dumps({"id": row["id"], "state": data}, ensure_ascii=False)
            yield ']}'
        return Response(generate(), mimetype="application/json")

    @app.get("/api/teacher/backup")
    @authenticated("teacher")
    def backup():
        # A transactional database snapshot is a restorable backup, not a live
        # copy of the SQLite file while WAL writes may still be outstanding.
        fd, filename = tempfile.mkstemp(prefix="dalmoeum-backup-", suffix=".sqlite3")
        os.close(fd)
        try:
            with closing(sqlite3.connect(filename)) as snapshot:
                connection().backup(snapshot)
                snapshot.execute("DELETE FROM sessions")
                snapshot.execute("DELETE FROM attempts")
                snapshot.commit()
                snapshot.execute("PRAGMA journal_mode=DELETE")
            stream = open(filename, "rb")
            response = send_file(stream, mimetype="application/octet-stream", as_attachment=True, download_name=f"dalmoeum-classroom-{date.today()}.sqlite3")
            response.direct_passthrough = False
            def cleanup():
                stream.close()
                Path(filename).unlink(missing_ok=True)
            response.call_on_close(cleanup)
            return response
        except Exception:
            Path(filename).unlink(missing_ok=True)
            raise

    @app.post("/api/teacher/password")
    @authenticated("teacher")
    def change_password():
        if not allow_login("teacher"):
            return jsonify(error="시도가 많아요. 15분 뒤 다시 시도해 주세요."), 429
        body = payload()
        old = clean_text(body.get("current", ""), 200)
        new = clean_text(body.get("password", ""), 200)
        if len(new) < 12:
            raise ValueError("새 비밀번호는 12자 이상으로 정해 주세요.")
        if not check_password_hash(setting("teacher_hash"), old):
            return jsonify(error="현재 비밀번호가 맞지 않아요."), 400
        db = connection()
        db.execute("UPDATE settings SET value=? WHERE key='teacher_hash'", (generate_password_hash(new),))
        db.execute("DELETE FROM sessions WHERE role='teacher' AND token_hash<>?", (g.auth["token_hash"],))
        db.commit()
        return jsonify(ok=True)

    @app.get("/")
    @app.get("/s/")
    def student_page():
        return send_from_directory(ROOT, "index.html")

    @app.get("/teacher")
    def teacher_page():
        return send_from_directory(ROOT, "teacher.html")

    @app.get("/reports")
    def report_page():
        return send_from_directory(ROOT, "reports.html")

    @app.get("/<path:asset>")
    def asset(asset):
        if asset.startswith("s/"):
            asset = asset[2:]
        if asset not in ASSETS:
            return jsonify(error="파일을 찾지 못했어요."), 404
        return send_from_directory(ROOT, asset)

    # Hosting setup uses a private environment variable once, never a public
    # 'first visitor becomes teacher' web page. Existing databases are preserved.
    with app.app_context():
        initial_password = os.environ.get("DAL_INITIAL_PASSWORD")
        if not setting("teacher_hash") and initial_password:
            initialize(os.environ.get("DAL_CLASS_NAME", "우리 반"), initial_password, int(os.environ.get("DAL_STUDENT_COUNT", "28")))
    return app


def main():
    parser = argparse.ArgumentParser(description="달모음 학급 서버")
    parser.add_argument("command", nargs="?", choices=["serve", "init", "reset-password", "restore"], default="serve")
    parser.add_argument("--class-name", default="우리 반")
    parser.add_argument("--students", type=int, default=28)
    parser.add_argument("--backup-file")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()
    app = create_app()
    if args.command == "init":
        password = getpass.getpass("선생님 비밀번호 (12자 이상): ")
        if password != getpass.getpass("한 번 더 입력: "):
            raise SystemExit("비밀번호가 일치하지 않습니다.")
        with app.app_context():
            app.initialize_classroom(args.class_name, password, args.students)
        print("학급을 만들었습니다. python server.py 실행 후 http://localhost:8000/teacher 에 접속하세요.")
    elif args.command == "reset-password":
        password = getpass.getpass("새 선생님 비밀번호 (12자 이상): ")
        if len(password) < 12 or len(password) > 200 or password != getpass.getpass("한 번 더 입력: "):
            raise SystemExit("비밀번호 길이 또는 확인 입력을 확인하세요.")
        with app.app_context():
            db = app.classroom_connection()
            cursor = db.execute("UPDATE settings SET value=? WHERE key='teacher_hash'", (generate_password_hash(password),))
            if cursor.rowcount != 1:
                raise SystemExit("먼저 init으로 학급을 만드세요.")
            db.execute("DELETE FROM sessions WHERE role='teacher'")
            db.commit()
        print("비밀번호를 변경하고 기존 선생님 로그인을 해제했습니다.")
    elif args.command == "restore":
        if not args.backup_file:
            raise SystemExit("--backup-file로 학급 백업 파일을 지정하세요. 서버를 먼저 종료해야 합니다.")
        source_path = Path(args.backup_file).resolve(strict=True)
        with sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True) as source:
            if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise SystemExit("백업 파일이 손상되었습니다.")
            tables = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"students", "sessions", "attempts", "settings"} <= tables:
                raise SystemExit("달모음 학급 백업이 아닙니다.")
            if input("현재 기록을 백업하고 이 파일로 교체합니다. 계속하려면 복원 입력: ") != "복원":
                raise SystemExit("취소했습니다.")
            with app.app_context():
                db = app.classroom_connection()
                prior = app.config["DAL_FOLDER"] / f"before-restore-{time.time_ns()}.sqlite3"
                with sqlite3.connect(prior) as destination:
                    db.backup(destination)
                source.backup(db)
                db.execute("DELETE FROM sessions")
                db.execute("DELETE FROM attempts")
                # Regenerate link hashes using this installation's private key.
                for row in db.execute("SELECT id,invite_version FROM students").fetchall():
                    token = hmac.new(app.secret_key.encode(), f"student:{row['id']}:{row['invite_version']}".encode(), hashlib.sha256).hexdigest()
                    db.execute("UPDATE students SET invite_hash=? WHERE id=?", (digest(token), row["id"]))
                db.commit()
            print(f"복원했습니다. 교체 전 기록: {prior}. 다른 서버에 복원했다면 학생 링크를 다시 배부하세요.")
    else:
        from waitress import serve
        print(f"달모음: http://{args.host}:{args.port}/teacher")
        serve(app, host=args.host, port=args.port, threads=8, max_request_body_size=24 * 1024 * 1024)


if __name__ == "__main__":
    main()
