"""Browser smoke checks; uses a temporary browser profile, never user records."""
from pathlib import Path
from tempfile import TemporaryDirectory
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent
with sync_playwright() as p, TemporaryDirectory() as temp:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1100})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto((root / "index.html").as_uri())
    page.locator("#studentName").fill("달이")
    page.locator("#record-today").click()
    page.locator("#record-date").fill("2026-09-15")
    page.locator('[data-phase="crescent"]').click()
    page.locator("#record-note").fill("가느다란 달을 보았어요.")
    page.locator("#save-record").click()
    assert page.locator("#record-count").inner_text() == "1"
    page.reload()
    assert page.locator("#studentName").input_value() == "달이"
    page.get_by_role("button", name="9월 15일, 초승달", exact=True).click()
    assert page.locator("#record-note").input_value() == "가느다란 달을 보았어요."
    page.locator("#photo-file").set_input_files(str(root / "worksheet-reference.png"))
    page.wait_for_function("!document.getElementById('save-record').disabled")
    assert page.locator("#photo-preview").is_visible()
    page.locator("#save-record").click()
    assert page.locator(".day img").count() == 1
    with page.expect_download() as download:
        page.locator("#backup").click()
    backup = Path(temp) / "backup.json"
    download.value.save_as(backup)
    page.get_by_role("button", name="9월 15일, 사진 기록", exact=True).click()
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#delete-record").click()
    assert page.locator("#record-count").inner_text() == "0"
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#backup-file").set_input_files(str(backup))
    page.wait_for_function("document.getElementById('record-count').textContent === '1'")
    page.get_by_role("button", name="9월 15일, 사진 기록", exact=True).click()
    page.locator("#remove-photo").click()
    page.locator('[data-phase="full"]').click()
    page.locator("#save-record").click()
    page.locator("#learned").fill("달의 모양은 날마다 조금씩 달라졌어요.")
    page.screenshot(path=str(root / "preview-desktop.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.screenshot(path=str(root / "preview-mobile.png"), full_page=True)
    page.get_by_role("button", name="9월 15일, 보름달", exact=True).click()
    assert page.locator("#editor").is_visible()
    assert page.evaluate("document.getElementById('editor').getBoundingClientRect().right <= innerWidth")
    page.locator("#close-editor").click()
    page.set_viewport_size({"width": 1440, "height": 1100})
    page.pdf(path=str(root / "preview-print.pdf"), prefer_css_page_size=True, print_background=True)
    # A six-row month must still fit on one printed sheet.
    page.locator("#next").click()
    page.locator("#next").click()
    page.locator("#prev").click()
    page.locator("#prev").click()
    page.locator("#prev").click()
    assert page.locator("#calendar > *").count() == 42
    page.pdf(path=str(Path(temp) / "six-weeks.pdf"), prefer_css_page_size=True)
    import fitz
    assert len(fitz.open(root / "preview-print.pdf")) == 1
    assert len(fitz.open(Path(temp) / "six-weeks.pdf")) == 1
    assert not errors, errors
    browser.close()
    print("PASS: record, reload, photo, edit, delete, backup/restore, mobile layout, 5/6-week A4 print, no browser errors")
