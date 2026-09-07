"""Isolated API and browser tests for classroom data and access boundaries."""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest

from server import create_app

ROOT = Path(__file__).resolve().parent


class ClassroomTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = create_app(self.temp.name, testing=True)
        self.password = secrets.token_urlsafe(18)
        with self.app.app_context():
            self.app.initialize_classroom("3학년 2반", self.password, 28)
        self.teacher = self.app.test_client()
        result = self.teacher.post("/api/auth/teacher", json={"password": self.password})
        self.assertEqual(result.status_code, 200)
        self.teacher_headers = {"X-CSRF-Token": result.json["csrf"]}
        self.links = self.teacher.get("/api/teacher/invitations").json["students"]

    def student(self, index=0):
        client = self.app.test_client()
        result = client.post("/api/auth/student", json={"token": self.links[index]["path"].split("#")[1]})
        self.assertEqual(result.status_code, 200)
        return client, {"X-CSRF-Token": result.json["csrf"]}

    def test_access_isolation_persistence_and_conflict(self):
        anonymous = self.app.test_client()
        self.assertEqual(anonymous.get("/api/teacher/students").status_code, 401)
        self.assertEqual(anonymous.get("/api/student/state").status_code, 401)
        first, headers = self.student()
        second, _ = self.student(1)
        for path in ["/api/teacher/students", "/api/teacher/invitations", "/api/teacher/reports?month=2026-09&ids=2", "/api/teacher/backup", "/api/teacher/students/2/qr.svg"]:
            self.assertEqual(first.get(path).status_code, 403)
        original = first.get("/api/student/state").json
        original["state"]["records"]["2026-09-07"] = {"phase": "full", "photo": None, "time": "20:30", "note": "첫 번째 학생의 기록"}
        self.assertEqual(first.put("/api/student/state", json=original).status_code, 403)
        self.assertEqual(first.put("/api/student/state", json=original, headers={**headers, "Origin": "https://attacker.example"}).status_code, 403)
        self.assertEqual(first.put("/api/student/state", json=original, headers=headers).status_code, 200)
        self.assertEqual(first.put("/api/student/state", json=original, headers=headers).status_code, 409)
        self.assertFalse(second.get("/api/student/state?student_id=1").json["state"]["records"])
        restarted = create_app(self.temp.name, testing=True)
        restored_client = restarted.test_client()
        login = restored_client.post("/api/auth/student", json={"token": self.links[0]["path"].split("#")[1]})
        self.assertEqual(login.status_code, 200)
        self.assertEqual(restored_client.get("/api/student/state").json["state"]["records"], original["state"]["records"])
        reports = self.teacher.get("/api/teacher/reports?month=2026-09&ids=1,2").json
        self.assertEqual(len(reports["reports"]), 2)
        self.assertFalse(reports["reports"][1]["state"]["records"])
        for path in ["/data/classroom.sqlite3", "/data/secret.key", "/server.py", "/README.md", "/s/../server.py"]:
            self.assertEqual(anonymous.get(path).status_code, 404)

    def test_28_students_write_concurrently_and_backup(self):
        clients = [self.student(i) for i in range(28)]

        def write(index):
            client, headers = clients[index]
            payload = client.get("/api/student/state").json
            payload["state"]["records"]["2026-09-07"] = {"phase": "crescent", "photo": None, "time": "20:00", "note": f"{index + 1}번 관찰"}
            return client.put("/api/student/state", json=payload, headers=headers).status_code

        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(write, range(28))), [200] * 28)
        roster = self.teacher.get("/api/teacher/students?month=2026-09").json
        self.assertEqual(len(roster["students"]), 28)
        self.assertEqual(sum(s["days"] for s in roster["students"]), 28)
        backup = self.teacher.get("/api/teacher/backup")
        self.addCleanup(backup.close)
        restored = sqlite3.connect(":memory:")
        self.addCleanup(restored.close)
        restored.deserialize(backup.data)
        # Backups use rollback journaling for easy, self-contained restores.
        self.assertEqual(restored.execute("SELECT count(*) FROM students").fetchone()[0], 28)
        self.assertEqual(restored.execute("SELECT count(*) FROM sessions").fetchone()[0], 0)
        self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        backup.close()

    def test_revocation_identity_validation_and_password(self):
        student, headers = self.student()
        self.assertEqual(self.teacher.patch("/api/teacher/students/1", json={"name": "달이"}, headers=self.teacher_headers).status_code, 200)
        payload = student.get("/api/student/state").json
        payload["state"]["profile"]["studentName"] = "다른 이름"
        student.put("/api/student/state", json=payload, headers=headers)
        self.assertEqual(student.get("/api/student/state").json["state"]["profile"]["studentName"], "달이")
        bad = student.get("/api/student/state").json
        bad["state"]["records"]["2026-09-07"] = {"phase": [], "photo": None, "note": "", "time": ""}
        self.assertEqual(student.put("/api/student/state", json=bad, headers=headers).status_code, 400)
        link = self.teacher.post("/api/teacher/students/1/reset-link", json={}, headers=self.teacher_headers)
        self.assertEqual(link.status_code, 200)
        self.assertEqual(student.get("/api/student/state").status_code, 401)
        self.assertEqual(student.post("/api/auth/student", json={"token": self.links[0]["path"].split("#")[1]}).status_code, 401)
        self.assertEqual(student.post("/api/auth/student", json={"token": link.json["path"].split("#")[1]}).status_code, 200)
        password = secrets.token_urlsafe(18)
        self.assertEqual(self.teacher.post("/api/teacher/password", json={"current": self.password, "password": password}, headers=self.teacher_headers).status_code, 200)
        self.assertEqual(self.app.test_client().post("/api/auth/teacher", json={"password": self.password}).status_code, 401)
        self.assertEqual(self.app.test_client().post("/api/auth/teacher", json={"password": password}).status_code, 200)

    def test_whole_class_restore_on_new_server(self):
        backup = self.teacher.get('/api/teacher/backup')
        self.addCleanup(backup.close)
        backup_path = Path(self.temp.name) / 'snapshot.sqlite3'
        backup_path.write_bytes(backup.data)
        destination = Path(self.temp.name) / 'new-server'
        result = subprocess.run([sys.executable, str(ROOT / 'server.py'), 'restore', '--backup-file', str(backup_path)], input='복원\n', encoding='utf-8', capture_output=True, timeout=20,
                                env={**os.environ, 'PYTHONUTF8': '1', 'DAL_DATA_DIR': str(destination)})
        self.assertEqual(result.returncode, 0, result.stderr)
        restored = create_app(destination, testing=True)
        teacher = restored.test_client()
        self.assertEqual(teacher.post('/api/auth/teacher', json={'password': self.password}).status_code, 200)
        links = teacher.get('/api/teacher/invitations').json['students']
        self.assertEqual(len(links), 28)
        self.assertNotEqual(links[0]['path'], self.links[0]['path'])
        student = restored.test_client()
        self.assertEqual(student.post('/api/auth/student', json={'token': links[0]['path'].split('#')[1]}).status_code, 200)
        self.assertEqual(student.get('/api/student/state').json['state']['profile']['className'], '3학년 2반')
        self.assertEqual(len(list(destination.glob('before-restore-*.sqlite3'))), 1)

    def test_https_host_and_cookie_configuration(self):
        from unittest.mock import patch
        with patch.dict(os.environ, {'DAL_SECURE_COOKIES': '1', 'DAL_PUBLIC_ORIGIN': 'https://moon.example'}):
            app = create_app(self.temp.name)
        teacher = app.test_client()
        login = teacher.post('/api/auth/teacher', base_url='https://moon.example', headers={'Origin': 'https://moon.example'}, json={'password': self.password})
        self.assertEqual(login.status_code, 200)
        cookie = login.headers['Set-Cookie']
        self.assertIn('Secure', cookie)
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Lax', cookie)
        self.assertEqual(teacher.get('/api/me', base_url='https://moon.example').status_code, 200)
        self.assertEqual(teacher.get('/api/me', base_url='https://wrong.example').status_code, 400)

    def test_browser_student_teacher_print_and_network_failure(self):
        from playwright.sync_api import sync_playwright, expect
        from werkzeug.serving import make_server, WSGIRequestHandler
        import fitz

        class Quiet(WSGIRequestHandler):
            def log(self, *args, **kwargs):
                pass

        httpd = make_server("127.0.0.1", 0, self.app, threaded=True, request_handler=Quiet)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        origin = f"http://127.0.0.1:{httpd.server_port}"
        with sync_playwright() as p:
            browser = p.chromium.launch()
            teacher_context = browser.new_context(viewport={"width": 1440, "height": 1080})
            teacher = teacher_context.new_page()
            errors = []
            teacher.on("pageerror", lambda error: errors.append(str(error)))
            teacher.goto(origin + "/teacher")
            teacher.locator("#teacher-password").fill(self.password)
            teacher.locator("#login-button").click()
            expect(teacher.locator('#roster tr')).to_have_count(28)
            teacher.locator("#report-month").fill("2026-09")
            teacher.locator("#report-month").dispatch_event("change")
            teacher.locator("#roster tr").first.get_by_role("button", name="수정", exact=True).click()
            teacher.locator("#new-name").fill("달이")
            teacher.locator("#name-form button[type=submit]").click()
            expect(teacher.locator('#roster .student-name').first).to_contain_text('달이')
            student_context = browser.new_context(viewport={"width": 390, "height": 844})
            student = student_context.new_page()
            student.on("pageerror", lambda error: errors.append(str(error)))
            student.goto(origin + self.links[0]["path"])
            student.wait_for_selector("#sync-status")
            self.assertEqual(student.locator("#studentName").input_value(), "달이")
            self.assertEqual(student.url, origin + "/")
            self.assertTrue(student.locator("#studentName").get_attribute("readonly") is not None)
            student.locator("#record-today").click()
            student.locator("#record-date").fill("2026-09-07")
            student.locator('[data-phase="full"]').click()
            student.locator("#record-note").fill("동그란 달을 보았어요.")
            student.locator("#save-record").click()
            expect(student.locator('#editor')).not_to_be_visible()
            student.reload()
            student.wait_for_selector("#sync-status")
            self.assertEqual(student.locator("#record-count").inner_text(), "1")
            student.get_by_role("button", name="9월 7일, 보름달", exact=True).click()
            student.locator("#photo-file").set_input_files(str(ROOT / "worksheet-reference.png"))
            expect(student.locator('#save-record')).to_be_enabled()
            student.locator("#save-record").click()
            expect(student.locator('#editor')).not_to_be_visible()
            self.assertEqual(student.locator(".day img").count(), 1)
            # Offline save keeps the draft and shows a failure, then can retry.
            student.get_by_role("button", name="9월 7일, 사진 기록", exact=True).click()
            student.locator("#record-note").fill("연결이 돌아와도 남아 있는 메모")
            student_context.set_offline(True)
            student.locator("#save-record").click()
            expect(student.locator('#sync-status')).to_contain_text('저장되지')
            self.assertTrue(student.locator("#editor").is_visible())
            student_context.set_offline(False)
            student.locator("#save-record").click()
            expect(student.locator('#editor')).not_to_be_visible()
            student.locator("#learned").fill("달의 모양이 조금씩 달라져요.")
            expect(student.locator('#sync-status')).to_contain_text('저장 완료')
            self.assertTrue(student.evaluate("document.documentElement.scrollWidth <= innerWidth"))
            teacher.locator("#refresh-roster").click()
            expect(teacher.locator('#total-records')).to_have_text('1')
            teacher.screenshot(path=str(ROOT / "preview-teacher.png"), full_page=True)
            student.screenshot(path=str(ROOT / "preview-classroom-mobile.png"), full_page=True)
            with teacher.expect_popup() as popup:
                teacher.locator("#print-selected").click()
            reports = popup.value
            expect(reports.locator('#print-reports')).to_be_enabled()
            self.assertEqual(reports.locator(".print-report").count(), 28)
            self.assertEqual(reports.locator(".day img").count(), 1)
            filename = Path(self.temp.name) / "28-reports.pdf"
            reports.pdf(path=str(filename), prefer_css_page_size=True, print_background=True)
            with fitz.open(filename) as pdf:
                self.assertEqual(len(pdf), 28)
                self.assertIn("달이", pdf[0].get_text())
            reports.goto(origin + "/reports?month=2026-08&ids=" + ",".join(str(i) for i in range(1,29)))
            expect(reports.locator('#print-reports')).to_be_enabled()
            reports.pdf(path=str(filename), prefer_css_page_size=True)
            with fitz.open(filename) as pdf:
                self.assertEqual(len(pdf), 28)
            with teacher.expect_popup() as popup:
                teacher.locator("#invitation-sheet").click()
            invitations = popup.value
            expect(invitations.locator('#print-reports')).to_be_enabled()
            self.assertEqual(invitations.locator(".invite-qr").count(), 28)
            self.assertTrue(invitations.evaluate("Array.from(document.images).every(i=>i.naturalWidth>0)"))
            # A student print view ignores forged teacher selections.
            student.goto(origin + "/reports?month=2026-09&ids=2")
            expect(student.locator('#print-reports')).to_be_enabled()
            self.assertEqual(student.locator(".print-report").count(), 1)
            self.assertIn("달이", student.locator(".print-identity").inner_text())
            self.assertEqual(errors, [])
            browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
