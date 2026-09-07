"""Restore a cloud JSON backup in one PostgreSQL transaction.

Requires: python -m pip install "psycopg[binary]>=3.2,<4"
Connection URI is prompted privately, never stored in the site configuration.
"""
import argparse
import getpass
import json
from pathlib import Path
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server import validate_state


def read_backup(path):
    backup = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if backup.get('format') != 'dalmoeum-supabase' or backup.get('version') not in (1, 2):
        raise ValueError('Not a Supabase classroom backup')
    class_id = backup.get('classId') if backup['version'] == 2 else 1
    if type(class_id) is not int or not 1 <= class_id <= 4:
        raise ValueError('Invalid classroom id')
    backup['classId'] = class_id
    students = backup.get('students')
    if not isinstance(students, list) or not 1 <= len(students) <= 40:
        raise ValueError('Invalid student count')
    if not isinstance(backup.get('className'), str) or not 1 <= len(backup['className']) <= 30:
        raise ValueError('Invalid classroom name')
    ids, numbers = set(), set()
    for s in students:
        if type(s.get('id')) is not int or s['id'] in ids:
            raise ValueError('Invalid student id')
        if type(s.get('number')) is not int or not 1 <= s['number'] <= 40 or s['number'] in numbers:
            raise ValueError('Invalid student number')
        if s['id'] != (class_id - 1) * 40 + s['number'] or s.get('classroomId', class_id) != class_id:
            raise ValueError('Student belongs to a different classroom')
        if not isinstance(s.get('name'), str) or not 1 <= len(s['name']) <= 30:
            raise ValueError('Invalid student name')
        ids.add(s['id']); numbers.add(s['number'])
        s['state'] = validate_state(s['state'])
        if len(json.dumps(s['state'], ensure_ascii=False).encode()) > 5 * 1024 * 1024:
            raise ValueError('Student data exceeds 5MB')
    return backup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('backup')
    parser.add_argument('--class-id', required=True, type=int, choices=range(1, 5))
    args = parser.parse_args()
    backup = read_backup(args.backup)
    if backup['classId'] != args.class_id:
        raise ValueError('Backup and destination classroom differ; no data changed')
    print(f"Restore {backup['className']}: {len(backup['students'])} students. Current data will be backed up first.")
    print(f'Only classroom {args.class_id} is restored. Its password is preserved; its links and sessions are replaced.')
    if input('Type RESTORE to continue: ') != 'RESTORE':
        raise SystemExit('Cancelled')
    import psycopg
    from psycopg.types.json import Jsonb
    uri = getpass.getpass('Supabase PostgreSQL connection URI (hidden): ')
    with psycopg.connect(uri, sslmode='require', connect_timeout=20) as conn:
        with conn.cursor() as cur:
            cur.execute('select pg_advisory_xact_lock(649206907)')
            cur.execute('select name from dal_private.classroom where id=%s for update', (args.class_id,))
            classroom = cur.fetchone()
            if not classroom:
                raise ValueError('Initialize the destination classroom first')
            cur.execute('select id,number,name,state,revision from dal_private.students where classroom_id=%s order by number', (args.class_id,))
            prior = {'format':'dalmoeum-supabase','version':2,'classId':args.class_id,'className':classroom[0],
                     'students':[dict(zip(['id','number','name','state','revision'], row)) for row in cur.fetchall()]}
            folder = ROOT / 'data'; folder.mkdir(exist_ok=True)
            snapshot = folder / ('before-supabase-restore-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
            with snapshot.open('x', encoding='utf-8') as target:
                json.dump(prior, target, ensure_ascii=False)
            cur.execute('delete from dal_private.sessions where classroom_id=%s', (args.class_id,))
            cur.execute('delete from dal_private.students where classroom_id=%s', (args.class_id,))
            cur.execute('update dal_private.classroom set name=%s where id=%s', (backup['className'], args.class_id))
            for s in backup['students']:
                cur.execute('insert into dal_private.students(id,classroom_id,number,name,state) values(%s,%s,%s,%s,%s)',
                            (s['id'],args.class_id,s['number'],s['name'],Jsonb(s['state'])))
    print(f'Restored successfully. Previous data: {snapshot}. Reissue student links from teacher.html.')


if __name__ == '__main__':
    main()
