# LEGACY 구현 지시서 보존본

> 이 문서는 초기 Pocket Command System 구현 지시서 보존본입니다. PCSS v3.1의 정본 설계와 충돌하는 오케스트레이터/자동 자연어 배정 지시는 적용하지 않습니다. 최신 기준은 codex-artifacts/Pocket_Command_Supporting_System_개선_구현_설계서.md입니다.

# LEGACY POCKET COMMANDER — Claude Code 작업 지시서

> 주머니 속 지휘소 — 폰에서 명령하는 AI 에이전트 지휘 시스템 (by 2GOSOO AI LAB)

> ⚠️ **역사적 스냅샷** — 이 문서는 초기 빌드 당시의 지시서 원본입니다. 이후 시스템이 달라진 부분이 있습니다.
> 대표적으로 **오케스트레이터(참모장, 자연어 자동 배정)는 2026-07-13 폐지**되어 현재는 콕핏에서 사람이
> 프로젝트·워커를 직접 골라 명령합니다(텔레그램은 조회·보고 전용). 현행 구조는
> [`Pocket-Command-System-설명자료.md`](Pocket-Command-System-설명자료.md)를 보세요.

> 이 문서는 **Claude Code에게 한 페이즈씩 시키기 위한** 빌드 지시서입니다.
> 각 페이즈의 `▶ 프롬프트`를 Claude Code에 그대로 붙여넣고, `✅ 완료 기준`으로 검증한 뒤 다음으로 넘어가세요.
> 한 번에 다 시키지 말 것 — 단계마다 검증 가능하게 쪼개져 있습니다.

---

## 0. 두 가지 경로

- **(A) 빠른 길** — 동봉된 `2gosoo-command-center.zip`을 기준 구현으로 Claude Code에 주고, "이 구조를 따라 검증·보완하라"고 시킨다. 이 문서의 `✅ 완료 기준`을 체크리스트로 쓴다.
- **(B) 처음부터 빌드** — 아래 페이즈를 순서대로 실행시킨다.

어느 쪽이든 아래 **데이터 모델 / 명령 스펙 / 완료 기준**이 정답지입니다.

---

## 1. 프로젝트 개요 (Claude Code에 줄 컨텍스트)

**무엇을 만드나:** 텔레그램으로 명령을 던지면, 여러 로컬 PC에 상주한 워커들이 작업(파이썬 스크립트 / Claude Code 헤드리스 / Claude API)을 실행하고, 그 상태를 Supabase Realtime으로 받아 관제 보드 + 칸반 콘솔에서 실시간 감시·제어하는 시스템.

**스택:** Next.js 14 (App Router) · Supabase (Postgres + Realtime) · 텔레그램 Bot API · Anthropic API(선택) · 워커는 Node(tsx).

**핵심 설계 원칙 (반드시 지킬 것):**
1. 워커는 Supabase를 **outbound 폴링(pull)** 한다 → 로컬이 방화벽/NAT 뒤에 있어도 됨. 인바운드 포트 절대 열지 않는다.
2. 상태의 단일 진실원천은 **Supabase DB**. 화면은 Realtime 구독으로만 갱신.
3. **쓰기는 service_role(서버)만.** 브라우저는 anon 키 + RLS로 읽기 전용. 버튼 액션은 API 라우트를 거친다.
4. 에이전트 종류(`kind`)별로 **실행기 어댑터**만 갈라지고, 큐·하트비트·관제는 공통.
5. Supabase 미설정 시 대시보드는 **데모 모드**로 동작(설치 즉시 화면 확인 가능).

---

## 1.5 텔레그램과 대시보드의 관계 (중요)

**둘은 직접 연결되지 않는다.** 텔레그램과 대시보드는 서로 주소를 모르며, 오직 **같은 Supabase(DB)를 공유**함으로써 동기화된다.

```
        텔레그램 ──┐
                   ├──▶  Supabase (DB)  ◀── 워커들이 상태 기록
        대시보드 ──┘     (공통의 다리)
```

- **텔레그램 = 명령/알림 채널** (글로 주고받음). 봇 ↔ 서버는 Webhook 1회 등록으로만 연결.
- **대시보드 = 웹페이지** (`/` 관제 보드, `/console` 칸반). 별도 주소를 **브라우저로 열어** 본다. 텔레그램에 등록하지 않는다.
- 대시보드 주소는 **북마크/홈 화면 추가**로 저장해두고 누르면 됨.
- 공개 URL이므로 운영 시 **비밀번호 게이트**(P9)를 권장.

운영 그림: 폰에서 **텔레그램 앱**으로 지시·알림, **브라우저(북마크한 대시보드)**로 화면 관제 — 두 탭을 오간다.

---

## 2. 아키텍처 한 장

```
[텔레그램] ──톡──▶ /api/telegram ──▶ 오케스트레이터 ── 담당 결정
    ▲                                      │
    │ 결과/경고                             ▼
    │                              tasks 큐 (Supabase)
    │                                      │ 폴링(pull)
    │                          worker/agent-runner (머신별·에이전트별)
    │                                      │ 하트비트 + 상태 + 결과
    │                              agents/tasks 테이블
    │                              ├── Realtime ─▶ /        관제 보드
    │                              └── Realtime ─▶ /console 칸반 콘솔
    │                                                  │ 취소/재시도
    └──[/api/monitor Cron]──타임아웃 체크        /api/control (service_role)
```

---

## 3. 데이터 모델 (확정 스펙)

```
agents
  id uuid PK
  name text unique          -- 오케스트레이터, 알파, 브라보 ...
  role text                 -- 역할 설명(오케스트레이터 매핑 참고)
  squad text                -- 그룹(소대)
  kind text                 -- python | claude_code | claude_api | orchestrator
  host text                 -- 어느 머신 (PC-A 등)
  workdir text              -- 작업 디렉터리 (python/claude_code 실행 위치)
  entry text                -- python 스크립트 경로
  skill text                -- claude_code 발동 스킬명
  session_id text           -- claude_code 대화 이어붙이기(resume)
  status text               -- idle | working | error | offline
  control text              -- run | stop  (중단 신호)
  current_task_id uuid
  last_heartbeat_at timestamptz   -- ★ offline/농땡이 판정 기준
  beats bigint              -- 누적 하트비트
  updated_at timestamptz

tasks
  id uuid PK
  command_text text         -- 텔레그램 원문 명령
  assigned_agent text → agents.name
  status text               -- queued | in_progress | done | failed
  source_chat_id bigint     -- 결과 회신용 텔레그램 chat id
  result text
  created_at / updated_at timestamptz
```

**파생 상태(화면 계산):** `offline`(하트비트 끊김) / `idle`(할 일 없이 대기) / `stuck`(working인데 정체) — 세 가지를 분리해 오탐 방지. 임계값: 하트비트 30초, 정체 180초.

---

## 4. 텔레그램 명령 스펙

| 유형 | 예시 | 동작 |
|---|---|---|
| 단일 지시 | `알파, 리포트 뽑아줘` | 오케스트레이터가 담당 배정 → 큐 적재 |
| 동시 투입 | `전원, 일일 점검` / `@all ...` | 전 실행형 에이전트에 동시 적재 |
| 중단 | `정지 브라보` / `브라보 그만` | control=stop + 대기열 취소 |
| 전체 중단 | `전원 정지` | 전원 중단 |
| 세션 초기화 | `새세션 알파` / `리셋 브라보` | claude_code 맥락 끊기 |
| 현황 | `/status` | 작업/대기 인원 브리핑 |

라우팅 우선순위: 이름 직접 지정 > LLM 판단 > 키워드 규칙 > 예비(마이크조).

---

## 5. 환경변수 (`.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY   # 대시보드 읽기+Realtime
SUPABASE_SERVICE_ROLE_KEY                                  # 서버/워커 쓰기
TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID
ANTHROPIC_API_KEY            # 선택(없으면 키워드 라우팅 + claude_api 비활성)
PUBLIC_BASE_URL              # set-webhook 용
```

---

## 6. 페이즈별 작업 지시

### P1 — 스캐폴딩
**목표:** Next.js 14 App Router + TS + Supabase 클라이언트 기본 골격.
**파일:** `package.json`, `tsconfig.json`(paths `@/*`), `next.config.js`, `app/layout.tsx`, `app/globals.css`, `lib/supabase.ts`, `lib/types.ts`

```
▶ 프롬프트
Next.js 14 App Router + TypeScript 프로젝트를 만들어줘.
- tsconfig에 "@/*" → "./*" 경로 별칭.
- @supabase/supabase-js 의존성.
- lib/supabase.ts 에 createBrowserClient(anon, 없으면 null 반환)과 createAdminClient(service_role) 두 함수.
- lib/types.ts 에 위 데이터 모델의 Agent/Task 타입과, deriveStatus(agent) 함수(offline/idle/stuck/working/error 판정, 임계값 하트비트 30s·정체 180s).
- app/layout.tsx 에 Chakra Petch / IBM Plex Mono / Inter 폰트 link.
```
**✅ 완료 기준:** `npm install && npx tsc --noEmit` 통과. `npm run dev` 기동.

---

### P2 — Supabase 스키마
**목표:** agents/tasks 테이블 + Realtime 발행 + RLS(읽기 공개) + 16명 시드.
**파일:** `supabase/schema.sql`

```
▶ 프롬프트
supabase/schema.sql 을 작성해줘. 위 데이터 모델 그대로.
- agent_status/task_status enum.
- updated_at 자동 갱신 트리거.
- alter publication supabase_realtime add table agents, tasks.
- RLS 활성화, select는 모두 허용(쓰기는 service_role이 우회).
- 16명 시드(오케스트레이터=orchestrator + 워커 15). 일부에 kind=python(workdir/entry), kind=claude_code(workdir, skill) 예시 지정.
```
**✅ 완료 기준:** SQL Editor에서 에러 없이 실행, agents 16행, Realtime에 두 테이블 포함.

---

### P3 — 관제 보드 (Realtime + 데모 폴백)
**목표:** `/` 에 16개 에이전트 타일(하트비트 EKG), 집계 패널, 라이브 피드. Supabase 없으면 데모 시뮬레이션.
**파일:** `app/page.tsx`, `app/components/{AgentTile,CommandBar,StatPanel,TaskFeed}.tsx`

```
▶ 프롬프트
관제 보드 페이지(/)를 만들어줘.
- createBrowserClient()가 null이면 데모 모드: 16명을 로컬에서 시뮬레이션(하트비트 증가, 가끔 working/idle 전이, 한 명은 offline로 시연).
- 있으면 agents/tasks를 로드하고 postgres_changes로 Realtime 구독.
- AgentTile: 이름/소대/역할/상태점/누적beats + 하트비트를 심전도(EKG) SVG로. offline이면 평탄선.
- CommandBar: 워드마크 + 상단 네비(/ , /console) + 상태 집계 칩 + 실시간 시계.
- StatPanel: 가동률(working/total) + 범례. TaskFeed: 최근 작업 이벤트.
- 디자인: 다크 슬레이트 관제실(NOC) 톤, 브랜드=시그널 오렌지(#ff7a1a), working=#3ba7f0, done=#2dd4a7, stuck=#f5a524, offline=#e0556a.
```
**✅ 완료 기준:** `npm run dev`에서 16타일이 살아 움직이고, offline 타일이 빨간 평탄선으로 보임.

---

### P4 — 텔레그램 수신 + 오케스트레이터
**목표:** Webhook 수신 → 담당 배정 → 큐 적재 → 회신. 브로드캐스트/중단/세션초기화/`/status` 파싱.
**파일:** `lib/orchestrator.ts`, `lib/telegram.ts`, `app/api/telegram/route.ts`, `scripts/set-webhook.ts`

```
▶ 프롬프트
app/api/telegram/route.ts (runtime nodejs, POST)를 만들어줘.
- 텔레그램 update에서 message.text, chat.id 추출.
- "/status" → 작업/대기 집계 회신.
- "정지|중지|그만 <이름>" / "전원 정지" → 해당 agents.control='stop' + 그 에이전트의 queued 작업 취소. (정지 키워드는 단어 경계로 매칭해 오탐 방지)
- "새세션|리셋 <이름>" → session_id=null.
- "전원, ..." / "@all ..." → orchestrator 제외 전원에게 동일 작업 적재.
- 그 외 → lib/orchestrator.routeCommand(text, agents)로 담당 1명 결정 후 큐 적재 + 접수 회신.
lib/orchestrator.ts: 이름직지정 > LLM(claude-haiku, ANTHROPIC_API_KEY 있을 때) > 키워드규칙 > 예비 순으로 담당 결정.
scripts/set-webhook.ts: PUBLIC_BASE_URL/api/telegram 로 setWebhook.
```
**✅ 완료 기준:** 봇에 `/status` 응답. `알파, 테스트` → tasks에 queued 1건 + 접수 메시지.

---

### P5 — 워커 (실행기 어댑터 3종)
**목표:** 에이전트당 1프로세스. 하트비트 + 큐 폴링 + kind별 실행.
**파일:** `worker/agent-runner.ts`

```
▶ 프롬프트
worker/agent-runner.ts (tsx 실행, AGENT_NAME 환경변수로 자기 이름 지정)를 만들어줘.
- 5초마다 하트비트(last_heartbeat_at, beats+1; offline이었으면 idle 복귀).
- 3초마다 자기 앞 queued 작업 1건 픽업 → in_progress → 실행 → done/failed.
- 어댑터 3종:
  · python: spawn('python3', [entry, command_text], {cwd: workdir}), stdout 수집.
  · claude_code: claude -p "<prompt>" --output-format json --dangerously-skip-permissions --append-system-prompt "<역할>" (cwd: workdir). 응답 JSON의 .result 파싱.
  · claude_api: Anthropic Messages API 호출(model claude-sonnet-4-6).
- 결과를 tasks.result에 저장하고 source_chat_id로 텔레그램 회신. 한 번에 한 작업만.
```
**✅ 완료 기준:** `AGENT_NAME=마이크조 npm run worker` 기동 → 관제 보드에서 마이크조 하트비트가 뜨고, 텔레그램 지시가 처리되어 결과 회신.

---

### P6 — 중단(stop)
**목표:** control='stop' 감지 → 실행 중 프로세스 즉시 종료.
**파일:** `worker/agent-runner.ts` 보강

```
▶ 프롬프트
워커에 중단 기능을 추가해줘.
- 현재 실행 핸들 추적(자식 프로세스 ChildProcess, 또는 claude_api용 AbortController, 현재 taskId).
- 1.5초마다 자기 agents.control 확인 → 'stop'이면: 신호를 'run'으로 리셋하고, 실행 중인 자식 프로세스를 SIGTERM(3초 뒤 SIGKILL) 또는 fetch abort. 해당 task를 '중단됨'으로 마감, status는 idle 복귀.
```
**✅ 완료 기준:** 긴 작업 실행 중 `정지 <이름>` → 1~2초 내 프로세스 종료 + task가 '중단됨'.

---

### P7 — 세션 resume + 스킬 + 대화 모드
**목표:** claude_code 맥락 유지 + 스킬을 에이전트로 + 첫 턴 이후 자동 대화 전환.
**파일:** `worker/agent-runner.ts`(claude_code 어댑터), `app/api/telegram/route.ts`(새세션 처리)

```
▶ 프롬프트
claude_code 어댑터를 보강해줘.
- 실행 전에 DB에서 그 에이전트의 session_id를 먼저 읽는다.
- 첫 턴(session_id 없음)이고 agent.skill이 있으면 프롬프트를 "/<skill> <command_text>"로 만들어 스킬을 명시 발동.
- 이어지는 턴(session_id 있음)은 평문 command_text 그대로 보내고 --resume <session_id> 를 붙인다 → 자동으로 대화 모드.
- 실행 후 응답 JSON의 session_id를 agents.session_id에 저장.
- "새세션 <이름>"으로 session_id=null 이 되면 다시 첫 턴(스킬 발동)으로 돌아간다.
전제: 스킬은 workdir/.claude/skills/<skill>/SKILL.md 또는 전역 ~/.claude/skills/에 설치.
```
**✅ 완료 기준:** 첫 메시지는 스킬로 실행되고, 후속 메시지는 같은 대화 맥락을 이어감(스킬 재호출 없이). `새세션`으로 초기화 시 다시 스킬 발동. (실행 도중 끼어드는 실시간 채팅이 아니라 턴 방식임을 확인)

---

### P8 — 콘솔(칸반) + 제어 API + 감시 Cron
**목표:** 작업을 대기/진행/완료/실패 칸반으로, 카드별 취소·재시도. 하트비트 타임아웃 경고.
**파일:** `app/console/page.tsx`, `app/api/control/route.ts`, `app/api/monitor/route.ts`, `vercel.json`

```
▶ 프롬프트
1) app/console/page.tsx — tasks를 4열(queued/in_progress/done/failed) 칸반으로. Realtime 구독 + 데모 폴백. 카드: 에이전트/명령/결과/시각 + 버튼(대기·진행=취소/중단, 완료·실패=재시도). 버튼은 /api/control 호출(데모면 로컬 상태 변경).
2) app/api/control/route.ts (service_role) — {action:'cancel'|'retry', taskId}. cancel: in_progress면 그 에이전트 control='stop', queued면 task 취소. retry: 같은 명령으로 새 queued 작업 적재.
3) app/api/monitor/route.ts (GET, Cron) — 하트비트 30s 초과면 status='offline' + 텔레그램 경고, working 180s 정체면 경고. vercel.json에 1분 cron.
```
**✅ 완료 기준:** `/console`에서 카드가 열 사이를 흐르고, 취소/재시도 버튼이 실제 DB(또는 데모 상태)를 바꿈. 워커를 끄면 1분 내 offline + 경고.

---

### P9 — 배포 & 접속 (대시보드를 인터넷 주소로)

**목표:** 앱을 Vercel에 올려 대시보드 URL을 만들고, 텔레그램 Webhook을 연결하고, 선택적으로 비밀번호로 보호한다.
**파일:** (선택) `middleware.ts` 또는 간단한 비번 게이트

**수동 절차 (운영자가 직접):**
1. GitHub에 푸시 → Vercel에서 Import.
2. Vercel 프로젝트 설정 > Environment Variables 에 `.env.local`의 값 전부 입력
   (`NEXT_PUBLIC_*`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_*`, `ANTHROPIC_API_KEY`, `PUBLIC_BASE_URL`=배포 도메인).
3. 배포 완료 → `https://<프로젝트>.vercel.app` 주소 생성.
4. Webhook 연결: 로컬에서 `PUBLIC_BASE_URL=https://<도메인> npm run set-webhook`.
5. `vercel.json`의 Cron(`/api/monitor`)이 자동 활성.
6. **대시보드 접속:** 폰/PC 브라우저로 그 주소를 열고 **북마크 또는 홈 화면에 추가**. 텔레그램에 등록하는 절차는 없음.

```
▶ 프롬프트 (비밀번호 게이트 — 선택)
대시보드(/, /console)를 간단한 비밀번호로 보호해줘.
- 환경변수 DASHBOARD_PASSWORD 를 둔다.
- middleware.ts 에서 쿠키/세션에 인증 표시가 없으면 /login 으로 보내고,
  /login 에서 비번이 맞으면 httpOnly 쿠키를 심고 대시보드로 통과시킨다.
- /api/* 중 telegram·monitor·control 은 게이트에서 제외(서버 간 호출/봇용).
  단 control은 별도 토큰 헤더로 보호하거나 동일 세션 쿠키를 요구한다.
```
**✅ 완료 기준:** 배포된 URL을 폰 브라우저로 열어 관제 보드/콘솔이 보임. 텔레그램 명령이 그 화면에 실시간 반영. (게이트 적용 시) 비번 없이는 대시보드 접근 불가.

---

## 7. 최종 검증 체크리스트

- [ ] `npx tsc --noEmit` 에러 0
- [ ] 데모 모드(`npm run dev`)에서 관제 보드 + 콘솔 둘 다 살아 움직임
- [ ] Supabase 연동 후 텔레그램 단일/전원/정지/새세션/`/status` 동작
- [ ] 워커 3종(python/claude_code/claude_api) 각각 실제 실행 확인
- [ ] 중단이 실행 중 프로세스를 실제로 죽임
- [ ] claude_code resume으로 맥락 유지, 스킬 명시 발동
- [ ] 콘솔 취소·재시도가 워커까지 전달
- [ ] 모니터 Cron이 offline 경고 발송
- [ ] (배포) Vercel URL에서 대시보드가 폰 브라우저로 열림
- [ ] (배포) 텔레그램 명령이 배포된 대시보드에 실시간 반영
- [ ] (선택) 비밀번호 게이트로 대시보드 보호

---

## 8. 실행 순서 요약 (운영)

```
# 1. Supabase: schema.sql 실행
# 2. .env.local 작성
# 3. 각 머신에서 워커 기동 (에이전트당 1개)
AGENT_NAME=브라보 npm run worker
AGENT_NAME=알파 npm run worker
# 4. 배포 후 텔레그램 연결
PUBLIC_BASE_URL=https://<배포도메인> npm run set-webhook
# 5. 텔레그램으로 지시 → /(관제) 와 /console(콘솔) 에서 관제
# 6. 대시보드 접속: 배포 주소를 폰/PC 브라우저로 열어 북마크(텔레그램에 등록 안 함)
```

> **대시보드 ↔ 텔레그램은 직접 연결되지 않는다.** 둘 다 같은 Supabase를 봐서 동기화될 뿐. 대시보드는 배포 주소를 브라우저로 열기만 하면 되고, 공개 URL이므로 비밀번호 게이트(P9) 권장.

> 주의: claude_code 어댑터는 `--dangerously-skip-permissions`로 무인 실행되므로 `workdir`를 프로젝트별로 좁게 잡을 것. 워커는 네가 쓰는 Claude Code 창과 **별개 인스턴스**이며 같은 계정 인증/구독 rate limit을 공유함.
