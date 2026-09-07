# 달모음 Supabase 운영 안내

PC를 계속 켜 두지 않고 운영하는 구성입니다. 화면은 정적 웹 호스팅에, 로그인과 관찰 기록은 Supabase에 배포합니다. **현재 코드를 수정한 것만으로 인터넷에 배포되지는 않습니다.** 아래 최초 설정이 필요합니다.

**Supabase 하나에서 관리자 4명이 각자 자기 반을 관리합니다.** 이미 첫 번째 SQL을 설치했다면 [4반 전환 안내](SUPABASE_4반_설정.md)를 먼저 따르세요. 기존 학급은 첫 번째 반으로 유지됩니다.

## 구성과 무료 범위

- 화면: Cloudflare Pages 등 정적 웹 호스팅. Python 서버를 실행하지 않습니다.
- 서버: Supabase Edge Function `classroom`.
- 저장: PostgreSQL 비공개 `dal_private` 스키마. **사진도 압축 JPEG로 DB에 함께 저장하며 Storage 버킷은 사용하지 않습니다.**
- 로그인: 관리 계정 `teacher1`~`teacher4`와 각자의 비밀번호, 학생별 전용 링크. Supabase Auth 회원가입 없이 매 요청에서 세션·역할·소속 반을 확인합니다.
- 학생별 5MB, 반별 최초 생성 시 1~40명(기본 28명). 네 반은 하나의 프로젝트 용량을 공유합니다. 28명씩 네 반이 모두 상한까지 저장하면 약 560MB이므로 무료 DB 한도를 넘습니다. DB 인덱스·세션·갱신 여유 공간도 필요합니다.

확인 시점(2026-09-07)에 Supabase 무료 DB는 500MB입니다. 사진도 DB 용량을 사용합니다. 전송량과 함수 호출 등 다른 한도도 있으므로 항상 무료 운영을 보장하지 않습니다. 활동이 적은 상태가 7일간 이어지면 프로젝트가 일시 중지될 수 있습니다. [요금제](https://supabase.com/pricing), [일시 중지 안내](https://supabase.com/docs/guides/platform/free-project-pausing).

## 1. Supabase 프로젝트 생성

학급 전용 Supabase 프로젝트를 만들고 아래 정보를 확인합니다.

- 프로젝트 URL: `https://프로젝트ID.supabase.co`
- 프로젝트 ID(ref)
- DB 비밀번호: 선생님 로그인 비밀번호와 별개이며 안전하게 보관합니다.

## 2. 데이터베이스 설치

아직 SQL을 설치하지 않은 새 프로젝트라면 Node.js 20 이상을 준비하고, 이 폴더의 PowerShell에서 실행합니다. `프로젝트ID`를 실제 ref로 바꿉니다. SQL Editor로 이미 설치했다면 [4반 전환 안내](SUPABASE_4반_설정.md)에 따라 두 번째 SQL만 실행하고 아래 `db push`는 실행하지 않습니다.

```powershell
npx supabase login
npx supabase link --project-ref 프로젝트ID
npx supabase db push
```

마이그레이션 폴더의 첫 번째·두 번째 SQL이 순서대로 적용됩니다. CLI로 처음 설치한 경우 이후 `db push`를 반복해도 기존 기록을 초기화하지 않습니다. 같은 SQL 전체를 SQL Editor에서 다시 실행하지 마세요.

Supabase **SQL Editor**에서 아래의 네 비밀번호와 학급 이름을 실제 값으로 바꿔 실행합니다.

```sql
select * from public.dal_initialize_four(
  array['REPLACE_WITH_PASSWORD_1', 'REPLACE_WITH_PASSWORD_2',
        'REPLACE_WITH_PASSWORD_3', 'REPLACE_WITH_PASSWORD_4'],
  array['3학년 1반', '3학년 2반', '3학년 3반', '3학년 4반'],
  array[28, 28, 28, 28]
);
```

비밀번호는 **12자 이상, UTF-8 72바이트 이하**이며 계정마다 다르게 정합니다. 한글은 보통 한 글자에 3바이트입니다. SQL 문자열 안의 작은따옴표는 두 번(`''`) 입력합니다. 비밀번호가 든 SQL을 프로젝트 파일이나 저장소에 저장하지 마세요. 이미 생성된 학급은 기존 이름·비밀번호·학생 수를 유지하고 건너뜁니다. 학생 수는 반별 최초 생성할 때 지정합니다.

## 3. 화면 배포 파일 생성

**이 프로젝트는 Vercel 설정이 준비되어 있습니다.** Vercel의 Add New → Project에서 GitHub 저장소 `uhakim/dalmoeum`을 Import하고 배포합니다. `vercel.json`이 프레임워크 Other, 빌드 명령, 출력 폴더를 지정하므로 별도 패키지 설치나 환경변수 입력은 필요 없습니다. 배포 후 생성된 HTTPS 주소를 아래 4단계의 `DAL_PUBLIC_ORIGIN`으로 사용합니다. Supabase Edge Function 배포까지 끝나야 로그인·저장이 동작합니다.

아래 ZIP 생성 방식은 파일 업로드 방식의 다른 정적 호스팅을 사용할 때 적용합니다.

```powershell
python tools/build_static.py --supabase-url "https://프로젝트ID.supabase.co"
```

`dist/` 폴더와 `dalmoeum-supabase-site.zip`이 만들어집니다. 공개 화면 파일만 포함하며 생성된 `cloud-config.js`에는 공개 프로젝트 URL만 들어갑니다. **service_role 키, DB 비밀번호, 백업 파일을 넣지 않습니다.** 원본 프로젝트 전체가 아니라 ZIP 또는 `dist`만 호스팅에 올립니다. `dist`에 예상하지 못한 파일이 있으면 빌더가 중단합니다.

Cloudflare Pages에서는 **Pages → Direct Upload**로 ZIP 또는 `dist`를 올리고 HTTPS 주소를 확인합니다. 예: `https://dalmoeum.pages.dev`. [공식 업로드 안내](https://developers.cloudflare.com/pages/get-started/direct-upload/).

최상위 경로에 배포하세요. `/학교/달모음/` 같은 하위 경로는 지원하지 않습니다. `/teacher.html`, `/reports.html`을 사용하므로 별도 경로 재작성은 필요 없습니다.

## 4. Edge Function 배포

화면의 실제 HTTPS 주소를 마지막 `/` 없이 설정합니다.

```powershell
npx supabase secrets set DAL_PUBLIC_ORIGIN="https://dalmoeum.pages.dev"
npx supabase functions deploy classroom --use-api
```

`--use-api`는 Docker 없이 서버에서 번들링하도록 합니다. CLI가 오래되었다면 `npx supabase@latest`로 실행하세요. [Supabase 배포 안내](https://supabase.com/docs/guides/functions/deploy).

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`는 Supabase가 함수에 제공하는 서버 환경변수를 사용합니다. 브라우저용 키는 필요 없습니다. 레거시 service_role 키를 비활성화한 프로젝트라면 서버 키 설정을 먼저 확인해야 합니다.

`supabase/config.toml`의 `verify_jwt = false`는 자체 세션을 사용하는 설정입니다. Function과 DB RPC가 매 요청의 권한을 검사하며 `anon`·`authenticated` 역할은 테이블이나 RPC에 접근할 수 없습니다. CORS는 `DAL_PUBLIC_ORIGIN` 한 곳만 허용합니다. 도메인이 바뀌면 이 값도 바꾸세요. [함수 인증 설정](https://supabase.com/docs/guides/functions/auth-headers), [DB 함수 권한](https://supabase.com/docs/guides/database/functions).

## 5. 학급에서 사용

1. `https://화면주소/teacher.html`에서 자기 관리 계정(`teacher1`~`teacher4`)을 선택하고 비밀번호로 로그인합니다.
2. 학생 이름을 수정합니다.
3. 가상의 기록으로 저장 → 새로고침 → 선생님 보고서 출력을 확인합니다.
4. 학생별 전용 링크·QR을 각 가정에 개별 전달합니다.
5. 학생은 자기 링크에서 사진·달 모양·관찰 시각·메모를 저장합니다.

PC를 꺼도 동작합니다. 같은 링크로 다른 휴대폰에서도 기록을 불러옵니다. 선생님 세션은 12시간, 학생 세션은 30일 후 만료됩니다. 다시 로그인하거나 전용 링크로 들어오면 됩니다. 브라우저 데이터를 지워도 서버 기록은 유지됩니다.

학생 링크를 재발급하면 이전 링크와 해당 학생의 기존 로그인이 무효가 됩니다. 선생님 비밀번호를 바꾸면 다른 선생님 로그인이 해제됩니다. 비밀번호 입력 실패가 15분 동안 10회 쌓이면 잠시 제한됩니다.

## 기존 기록 이전

개인용 또는 기존 Python 학급용 학생 화면에서 **기록 내보내기**를 누르고, 새 Supabase 학생 링크에서 **불러오기**로 JSON을 선택합니다. 해당 학생의 현재 기록 전체를 교체하며 새 학급 이름·번호는 유지됩니다. 5MB를 넘는 기록은 원본 백업을 보관한 뒤 오래된 사진을 정리해야 합니다.

기존 `.sqlite3` 학급 백업을 바로 불러올 수는 없습니다. 기존 Python 서버에 복원하고 학생별 JSON으로 내보내 옮깁니다.

## 학급 전체 백업·복원

Supabase 모드의 **학급 전체 백업**은 학생 명단, 전체 기간 기록과 사진을 담은 `.json`을 내려받습니다. 로그인 세션·학생 링크·선생님 비밀번호는 포함하지 않습니다. 선생님만 접근할 수 있는 곳에 보관합니다.

학생별로 순서대로 읽으므로 백업 중 저장이 일어나면 학생마다 백업 시점이 다를 수 있습니다. 가급적 학생들이 입력하지 않는 시간에 백업하세요. 중간 요청이 실패하면 미완성 파일을 내려받지 않습니다.

전체 복원은 선생님 PC에서 일회성 관리 명령으로 실행합니다.

```powershell
python -m pip install -r requirements.txt
python -m pip install "psycopg[binary]>=3.2,<4"
python tools/restore_supabase.py "백업파일.json" --class-id 1
```

`RESTORE`를 직접 입력해 확인하고, Supabase **Connect**의 PostgreSQL 연결 URI를 비공개 프롬프트에 입력합니다. IPv4 환경은 Session pooler 연결을 사용하고 URI의 비밀번호 특수문자는 URL 인코딩합니다.

`--class-id`는 백업의 반 번호(1~4)와 일치해야 합니다. 도구는 해당 반의 현재 기록을 `data/before-supabase-restore-날짜.json`으로 먼저 백업합니다. 해당 반의 학생 명단과 기록 교체는 **한 트랜잭션**으로 실행되어 오류가 나면 전체 취소됩니다. 해당 선생님 비밀번호는 유지하며 해당 반의 로그인만 해제하고 학생 링크를 새로 만듭니다. 다른 반은 바꾸지 않습니다. 복원 후 다시 로그인하고 링크를 재배부합니다. 다른 프로젝트에 복원할 때는 먼저 위 초기 설정을 완료합니다.

## 개발 테스트와 문제 해결

원본 `cloud-config.js`는 빈 URL로 기존 Python/개인용 동작을 유지합니다. 빌더가 생성하는 배포 파일에는 실제 URL이 들어갑니다.

```powershell
npm ci
npm test
python -m pip install playwright
python -m playwright install chromium
npm run test:browser
python -m unittest discover -s tests -p test_cloud_tools.py -q
python -m unittest test_classroom -q
```

테스트는 로컬 PGlite PostgreSQL에서 실제 SQL과 Edge HTTP 처리 코드를 실행합니다. 운영 Supabase 계정이나 학생 데이터는 사용하지 않습니다. 브라우저 검증은 사진 저장·연결 실패 후 재시도·보고서·QR·백업·링크 폐기를 확인합니다. 실제 Supabase의 네트워크·요금 한도·배포 설정은 배포 후 별도 확인해야 합니다.

동기화 드라이브에서 `npm ci` 파일 쓰기 오류가 나면 일반 로컬 디스크에 소스를 복사해 테스트하세요. 배포 ZIP은 Python 빌더로 만들 수 있습니다.

- 초기 설정 오류: `dal_initialize` 실행 여부 확인
- 연결/CORS 오류: 화면 주소와 `DAL_PUBLIC_ORIGIN` 일치 여부, 프로젝트 일시 중지 여부 확인
- 저장소 요청 실패: 마이그레이션과 Edge 환경변수·로그 확인
- 저장 충돌: 입력을 JSON으로 내보내 보관하고 새로고침 후 다시 편집
- 5MB 초과: 백업 후 오래된 사진 정리
