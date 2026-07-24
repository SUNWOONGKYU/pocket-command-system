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

호환 legacy env:

- `PCS_PROJECTS_JSON`
- `PCS_WORKTREE`
- `PCS_ACTOR`

위 legacy env는 기존 설치 보호를 위해 당분간 fallback으로 유지됩니다.

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
3. 감사관 worker가 읽기 전용 감사 의견을 만든다.
4. daemon worker 커밋이면 원 worker에 `[감사 대응]` task를 적재한다.
5. interactive Claude Code 세션 커밋이면 worker에 자동 배정하지 않고 Telegram/SessionStart 주입으로 사람이 확인한다.

감사관은 지휘관이 아니며 소스코드를 직접 수정하지 않습니다.

---

## 스택

Next.js 14 App Router · Supabase Postgres/Realtime · Telegram Bot API · Node/tsx worker · TypeScript

> `claude_code` adapter는 무인 실행 경로를 사용하므로 `workdir`를 프로젝트별로 좁게 잡으세요. worker는 대화형 Claude Code 창과 별개 인스턴스이며 같은 계정 인증/구독 rate limit을 공유할 수 있습니다.
