"""Exercise the unchanged UI against real PostgreSQL SQL and the Edge handler."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run():
    process = subprocess.Popen(['node', 'tests/local_cloud_server.mjs'], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
    try:
        info = json.loads(process.stdout.readline())
        origin = info['origin']
        with sync_playwright() as playwright, tempfile.TemporaryDirectory() as temp:
            browser = playwright.chromium.launch()
            teacher_context = browser.new_context(accept_downloads=True)
            teacher = teacher_context.new_page()
            errors = []
            teacher.on('pageerror', lambda error: errors.append(str(error)))
            teacher.goto(origin + '/teacher.html')
            teacher.locator('#teacher-password').fill(info['password'])
            teacher.locator('#login-button').click()
            teacher.wait_for_function("document.querySelectorAll('#roster tr').length===28")
            teacher.locator('#report-month').fill('2026-09')
            teacher.locator('#refresh-roster').click()

            student_context = browser.new_context(viewport={'width':390,'height':844}, accept_downloads=True)
            student = student_context.new_page()
            student.on('dialog', lambda dialog: dialog.accept())
            student.on('pageerror', lambda error: errors.append(str(error)))
            student.goto(origin)
            student.locator('#student-class option[value="1"]').wait_for(state='attached')
            student.locator('#student-class').select_option('1')
            student.locator('#student-number').fill('1')
            student.locator('#student-pin').fill(info['invitations'][0]['pin'])
            student.locator('#student-pin-access button').click()
            student.locator('#record-today').wait_for(state='visible')
            student.locator('#record-today').click()
            student.locator('#record-date').fill('2026-09-07')
            student.locator('[data-phase="full"]').click()
            student.locator('#record-note').fill('휴대폰에서 기록한 보름달')
            student.locator('#save-record').click()
            student.wait_for_function("document.querySelector('#sync-status').textContent.includes('저장') && !document.querySelector('#editor').open")
            student.reload()
            student.wait_for_function("document.querySelector('#record-count').textContent==='1'")
            assert student.locator('#studentName').input_value() == '1번 학생'
            assert student.evaluate('document.documentElement.scrollWidth <= innerWidth')

            # Offline save keeps the editor's input for retry.
            student.get_by_role('button', name='9월 8일, 기록하기', exact=True).click()
            student.locator('[data-phase="crescent"]').click()
            student.locator('#record-note').fill('연결 복구 후 저장')
            student_context.set_offline(True)
            student.locator('#save-record').click()
            student.wait_for_function("document.querySelector('#sync-status').classList.contains('sync-error')")
            assert student.locator('#record-note').input_value() == '연결 복구 후 저장'
            student_context.set_offline(False)
            student.locator('#save-record').click()
            student.wait_for_function("!document.querySelector('#editor').open")
            student.reload()
            student.wait_for_function("document.querySelector('#record-count').textContent==='2'")

            # Upload and reload a real image, then verify it is included in backup/print.
            student.get_by_role('button', name='9월 9일, 기록하기', exact=True).click()
            student.locator('[data-phase="full"]').click()
            png = student.screenshot()
            student.locator('#photo-file').set_input_files({'name':'moon.png','mimeType':'image/png','buffer':png})
            student.locator('#photo-preview').wait_for(state='visible')
            student.locator('#save-record').click()
            student.wait_for_function("!document.querySelector('#editor').open")
            student.reload()
            student.wait_for_function("document.querySelector('#record-count').textContent==='3'")
            with student.expect_download() as download:
                student.locator('#backup').click()
            personal_path=Path(temp)/'personal.json';download.value.save_as(personal_path)
            personal=json.loads(personal_path.read_text(encoding='utf-8'))
            assert personal['records']['2026-09-09']['photo'].startswith('data:image/jpeg;base64,')

            teacher.locator('#refresh-roster').click()
            teacher.wait_for_function("document.querySelector('#roster tr').textContent.includes('3일 관찰')")
            with teacher.expect_popup() as report_popup:
                teacher.locator('#roster tr').first.get_by_role('button',name='보고서',exact=True).click()
            report=report_popup.value
            report.wait_for_function("document.body.dataset.ready==='true'")
            assert report.locator('.print-report').count()==1
            assert report.locator('.day img').count()==1
            assert report.locator('.day-note').filter(has_text='휴대폰에서 기록한 보름달').count()==1

            with teacher.expect_popup() as qr_popup:
                teacher.locator('#invitation-sheet').click()
            qr=qr_popup.value
            qr.wait_for_function("document.body.dataset.ready==='true'",timeout=60000)
            assert qr.locator('.invite-qr').count()==28
            assert qr.evaluate('Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0)')

            with teacher.expect_download(timeout=60000) as backup_download:
                teacher.locator('#class-backup').click()
            backup_path=Path(temp)/'classroom.json';backup_download.value.save_as(backup_path)
            backup=json.loads(backup_path.read_text(encoding='utf-8'))
            assert backup['format']=='dalmoeum-supabase'
            assert backup['version']==2 and backup['classId']==1
            assert len(backup['students'])==28
            assert backup['students'][0]['state']['records']==personal['records']
            assert 'token' not in backup and 'invitation' not in backup['students'][0]

            # Existing links and sessions really stop working after teacher reset.
            teacher.locator('#roster tr').first.get_by_role('button',name='접속 정보',exact=True).click()
            teacher.locator('#invite-link').wait_for(state='visible')
            previous=teacher.locator('#invite-link').input_value()
            assert teacher.locator('#issued-pin').input_value()==info['invitations'][0]['pin']
            teacher.on('dialog',lambda dialog:dialog.accept())
            teacher.locator('#reset-invite').click()
            teacher.wait_for_function('(previous)=>document.querySelector("#invite-link").value!==previous',arg=previous)
            student.reload()
            student.locator('#student-pin-access').wait_for(state='visible')
            assert not student.locator('#record-today').is_visible()
            # Reissuing PIN keeps observations, invalidates the old PIN and allows number login.
            old_pin=teacher.locator('#issued-pin').input_value()
            teacher.locator('#reset-pin').click()
            teacher.wait_for_function('(old)=>document.querySelector("#issued-pin").value!==old',arg=old_pin)
            new_pin=teacher.locator('#issued-pin').input_value()
            student.locator('#student-class').select_option('1')
            student.locator('#student-number').fill('1')
            student.locator('#student-pin').fill(new_pin)
            student.locator('#student-pin-access button').click()
            student.wait_for_function("document.querySelector('#record-count').textContent==='3'")
            # Each of the other three teachers logs into a separate, empty classroom.
            for classroom in range(2,5):
                other_context=browser.new_context(accept_downloads=True)
                other=other_context.new_page()
                other.goto(origin+'/teacher.html')
                other.locator('#teacher-username').select_option('teacher'+str(classroom))
                other.locator('#teacher-password').fill(info['password']+'-'+str(classroom))
                other.locator('#login-button').click()
                other.wait_for_function("document.querySelectorAll('#roster tr').length===28")
                assert other.locator('#class-title').inner_text().startswith(str(classroom)+'반')
                assert other.locator('#total-records').inner_text()=='0'
                with other.expect_download(timeout=60000) as download:
                    other.locator('#class-backup').click()
                path=Path(temp)/('classroom-'+str(classroom)+'.json');download.value.save_as(path)
                data=json.loads(path.read_text(encoding='utf-8'))
                assert data['classId']==classroom
                assert len(data['students'])==28
                assert all((classroom-1)*40<s['id']<=classroom*40 for s in data['students'])
                assert all(not s['state']['records'] for s in data['students'])
                other_context.close()
            assert not errors, errors
            browser.close()
            print('PASS: mobile save/reload, offline retry, photo, report, 28 QR cards, backup, link revocation; four teacher accounts and isolated backups')
    finally:
        process.terminate()
        process.wait(timeout=10)


if __name__ == '__main__':
    run()
