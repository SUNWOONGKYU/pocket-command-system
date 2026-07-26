# Pocket Command Supporting System (PCSS)

*주머니 속 AI 작업팀 지휘통제 지원 시스템 — PO가 여러 Claude Code 소대장 세션을 모바일에서 직접 관리하도록 돕는 콕핏, 상태 관제, Telegram 보고, Git 감사 루프.*

> **공식 영문명**: Pocket Command Supporting System
> **공식 약칭**: PCSS
> **공식 한글명**: 주머니 속 AI 작업팀 지휘통제 지원 시스템
> **대시보드 이름**: Pocket Command Post

PCSS는 지휘관, 참모장, 명령 배정자, 명령 전달자 또는 중앙 오케스트레이터가 아닙니다. 유일한 최상위 지휘권자는 PO이며, PO가 콕핏에서 해당 Claude Code 세션의 소대장을 직접 선택해 명령합니다. PCSS는 세션 접속, 상태 수집·압축, 작업·커밋·감사 상태 표시, 예외 경고, 승인·통제 수단, 기록과 추적을 지원합니다.

현재 공개 코드의 운영 호환 계층은 기존 `agents`/`tasks` 테이블과 legacy worker 프로세스를 유지합니다. PCSS v3.1부터는 `hosts`/`platoons`/`platoon_runs`/`audits`/`events`를 추가해 “Claude Code 세션 하나 = 소대 하나” 모델로 확장합니다.

---

## 구조

```text
[폰: PCSS 콕핏] ──소대/legacy worker 명시 선택──▶ /api/command
                                                   │ 자동 배정 없음
                                                   ▼
[Telegram] ◀─결과 보고(+콕핏 딥링크 버튼)── tasks 큐 (Supabase)
    │                                             │ 폴링
    │ /status·/명단 조회 전용            worker/agent-runner
    ▼                                             │ 하트비트 + 상태
 /api/telegram                            agents/tasks + platoons
                                                   │ Realtime
                                      app/cockpit/page.tsx
```

기존 `agents.name`은 legacy queue consumer로 유지됩니다. 신규 `platoons.leader_worker_id`가 해당 legacy worker row를 가리키며, 콕핏과 API는 점진적으로 `platoon_id` 명시 대상도 지원합니다.

> 2026-07-13 이후 Telegram 자연어 자동 배정 오케스트레이터는 폐지됐습니다. Telegram은 조회·보고 전용이며, 명령은 콕핏에서 사람이 대상을 직접 골라 보냅니다.

| 부품 | 파일 | 역할 |
|---|---|---|
| 콕핏 | `app/cockpit/page.tsx` | 소대/legacy worker 상태 관제 + 직접 대화형 명령 |
| 콘솔 | `app/console/page.tsx` | 작업 대기→진행→완료 칸반 + 취소/재시도 |
| 명령 API | `app/api/command/route.ts` | 명시 대상(`platoon_id` 또는 legacy `agent`)에 task 적재 |
| Telegram | `app/api/telegram/route.ts` | `/status`, `/명단` 조회 전용 webhook |
| 워커 | `worker/agent-runner.ts` | legacy worker 프로세스, Claude Code session resume, heartbeat |
| 감시 | `app/api/monitor/route.ts` | 하트비트 끊김/정체/한도 상태 확인 |
| 상태 저장 | `supabase/schema.sql` | legacy `agents/tasks` + PCSS `hosts/platoons/platoon_runs/audits/events` |
| 프로젝트 매핑 | `config/projects.json` | 공개 예시. 운영 데이터는 `config/projects.local.json` 또는 env 사용 |
| 감사 적재 | `scripts/enqueue-audit.js` | Git post-commit -> 감사 task 적재 |
| 감사 무결성 | `scripts/audit-integrity-check.js` | 감사 원본 SHA-256 프리픽스 체인 기록·검증 |
| 감사 경로 규칙 | `scripts/audit-paths.cjs` | vault·`_audit` 경로 산출 단일 출처 |
| 감사 판정 해석 | `scripts/audit-verdict.cjs` | 판정 규격(`[심각도] [조치필요/불요]`) 정의·해석 |
| 대응 헤더 스캔 | `scripts/audit-response-scan.cjs` | 대응이력 헤더 파싱(코드펜스 인용 제외) 단일 출처 |

`/`는 `/cockpit`로 리다이렉트됩니다.

---

## 빠른 실행

```bash
npm install
npm run dev
# http://localhost:3000
```

환경변수가 없으면 `/console`은 데모 모드로 동작합니다. `/cockpit`은 Supabase 설정이 있어야 live 데이터를 표시합니다.

---

## 실제 연동

### 1. Supabase

1. 프로젝트 생성.
2. SQL Editor에 `supabase/schema.sql`을 붙여넣고 실행.
3. Settings > API에서 URL, anon key, service_role key 복사.

### 2. Telegram bot

1. BotFather에서 bot token 발급.
2. alert를 받을 chat id 확인.

### 3. 환경변수

`.env.local.example`을 `.env.local`로 복사하고 값을 채웁니다.

신규 PCSS env:

- `PCSS_PROJECTS_JSON`: Vercel에서 운영 프로젝트/소대 매핑을 JSON으로 주입할 때 사용.
- `PCSS_WORKTREE=1`: worker git worktree 격리 opt-in.
- `PCSS_ACTOR`: worker가 커밋 actor를 감사 hook에 전달할 때 사용.

legacy `PCS_*` env alias는 2026-07-25 일괄 폐지되었습니다 — `PCSS_*`만 유효합니다.

### 4. 워커 실행

```bash
AGENT_NAME=알파 npm run worker
AGENT_NAME=브라보 npm run worker
```

또는 Windows에서:

```powershell
.\start-workers.ps1
```

`start-workers.ps1`은 현재 PC hostname과 DB `agents.host`가 일치하는 worker만 기동합니다.

### 5. Telegram webhook

```bash
PUBLIC_BASE_URL=https://your-app.vercel.app npm run set-webhook
```

---

## 사용 방식

| 채널 | 유형 | 동작 |
|---|---|---|
| 콕핏 | 작업 지시 | PO가 소대/legacy worker를 명시 선택 -> `/api/command` -> task queued |
| 콕핏 | 급정지/재가동/종료 | `agents.control` 신호로 해당 worker 프로세스 제어 |
| 콘솔 | 취소/재시도 | 대기 작업 취소, 실패/완료 작업 재시도 |
| Telegram | 현황 | `/status` 조회 |
| Telegram | 명단 | `/명단` 또는 `/workers` 조회 |

PCSS는 PO가 선택하지 않은 소대에 임의 배정하지 않습니다. 여러 소대를 동시에 다뤄도 각 소대장과 PO의 직접 지휘선이 유지돼야 합니다.

---

## 감사 루프

1. 대상 repo에 `install-auditor.ps1`로 post-commit hook 설치.
2. 커밋 발생 시 `scripts/enqueue-audit.js <projectKey>`가 감사 task를 Supabase에 적재.
   비기능 커밋(`docs`/`chore`/`style`/`ci`)은 자동 스킵하되 의존성 변경은 항상 감사합니다.
3. 감사관 worker가 읽기 전용 감사 의견을 만들고 아래 "기록 무결성" 절차로 봉인합니다.
4. **판정 게이트** — 감사 의견 첫 줄 규격은 `[<정상|경미|주의|중대>] [<조치필요|조치불요>] — <요약>`입니다.
   `[조치필요]`일 때만 원 worker에 `[감사 대응]` task를 적재합니다. `[조치불요]`면 기록만 남기고
   worker 세션을 쓰지 않습니다. 심각도와 "고쳐야 하는가"는 다른 축이므로 게이트는 뒤쪽 표식만 봅니다.
   표식이 없는 구 형식은 심각도로 폴백하고, 판정을 못 읽으면 조치 필요로 간주합니다(fail-safe).
5. interactive Claude Code 세션 커밋이면 worker에 자동 배정하지 않고 Telegram/SessionStart 주입으로
   사람이 확인합니다. 이때도 게이트가 적용돼 `[조치불요]`는 주입되지 않습니다.

감사관은 지휘관이 아니며 소스코드를 직접 수정하지 않습니다.

### 기록 무결성

감사 원본은 **작업자 저장소 밖**에 둡니다. 작업자와 감사관이 같은 workdir를 공유하므로,
"작업자는 원본에 쓰지 않는다"를 프롬프트 약속이 아니라 물리적 격리로 보장합니다.

| 항목 | 위치 | 쓰는 주체 |
|---|---|---|
| 원본 감사이력 | `<repo의 부모>/_audit_vault/<repo 이름>/감사이력_원본.md` | 감사관만 |
| 해시 체인 로그 | 같은 폴더의 `integrity.log` | `audit-integrity-check.js`만 |
| 사본 감사이력 | `<repo>/_audit/감사이력.md` | 작업자가 읽음 |
| 대응이력 | `<repo>/_audit/대응이력.md` | 작업자가 씀 |

vault는 저장소 밖이라 gitignore와 무관하게 커밋 대상이 아닙니다. 해시 계산은 감사관 LLM이 아니라
`scripts/audit-integrity-check.js`가 결정론적으로 수행합니다(감사관은 트리거만) — 값을 잘못 계산하거나
지어낼 여지를 제거하기 위해서입니다. 각 로그 줄은 그 시점까지의 원본 프리픽스를 증언하므로,
뒤에 append되는 것은 허용하되 과거 구간이 사후 변조되면 탐지됩니다.

### 파견 분대장(외부 벤더 CLI) 산출물 감사

codex/grok/antigravity 등 전용 2폴더(`<kind>-worktree`, `<kind>-artifacts`)를 가진 벤더 CLI는
파견 분대장으로 취급해 작업 완료 시 산출물도 자동 감사합니다. 이들은 샌드박스 때문에 자기 작업폴더
밖(프로젝트 `_audit`)에 쓸 수 없으므로, 감사 대응 기록은 worker에 권한을 열지 않고
**러너가 대신 append**합니다. 좌표는 프롬프트 말미 마커에서 읽되 러너가 스스로 계산한 경로와
대조해 일치할 때만 기록합니다(마커가 오염돼도 임의 경로에 쓰지 않음).

---

## 스택

Next.js 14 App Router · Supabase Postgres/Realtime · Telegram Bot API · Node/tsx worker · TypeScript

> `claude_code` adapter는 무인 실행 경로를 사용하므로 `workdir`를 프로젝트별로 좁게 잡으세요. worker는 대화형 Claude Code 창과 별개 인스턴스이며 같은 계정 인증/구독 rate limit을 공유할 수 있습니다.
