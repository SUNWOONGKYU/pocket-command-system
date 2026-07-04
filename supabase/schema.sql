-- =====================================================================
-- POCKET COMMANDER  —  Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 그대로 붙여넣고 실행하세요.
-- =====================================================================

-- ---------- ENUM 정의 ----------
do $$ begin
  create type agent_status as enum ('idle', 'working', 'error', 'offline');
exception when duplicate_object then null; end $$;

do $$ begin
  create type task_status as enum ('queued', 'in_progress', 'done', 'failed');
exception when duplicate_object then null; end $$;

-- ---------- agents : 에이전트(소대원) 현황 ----------
create table if not exists agents (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,          -- 허실장, 알파조, 정화백, 소통꾼 ...
  role             text not null,                 -- 역할 설명 (오케스트레이터가 매핑 시 참고)
  squad            text default '1중대',          -- 그룹핑(선택)
  kind             text not null default 'claude_api', -- python | claude_code | claude_api | orchestrator
  host             text,                          -- 어느 로컬 머신에 사는지 (예: PC-A)
  workdir          text,                          -- 작업 디렉터리 (python/claude_code 실행 위치)
  entry            text,                          -- python 일 때 실행할 스크립트 경로
  skill            text,                          -- claude_code 일 때 발동할 스킬명 (예: youtube-analysis)
  session_id       text,                          -- claude_code 대화 세션 이어붙이기용
  status           agent_status not null default 'idle',
  control          text not null default 'run',   -- 'run' | 'stop' (중단 신호)
  current_task_id  uuid,
  last_heartbeat_at timestamptz,                  -- ★ 농땡이/오프라인 판정 기준
  beats            bigint not null default 0,     -- 누적 하트비트 수(EKG 펄스용)
  updated_at       timestamptz not null default now()
);

-- ---------- tasks : 업무 지시 큐 ----------
create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  command_text     text not null,                 -- 텔레그램으로 받은 원문 명령
  assigned_agent   text references agents(name),   -- 배정된 에이전트 이름
  status           task_status not null default 'queued',
  source_chat_id   bigint,                        -- 결과를 돌려보낼 텔레그램 chat id
  result           text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_tasks_agent  on tasks(assigned_agent);

-- ---------- updated_at 자동 갱신 트리거 ----------
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_agents_touch on agents;
create trigger trg_agents_touch before update on agents
  for each row execute function touch_updated_at();

drop trigger if exists trg_tasks_touch on tasks;
create trigger trg_tasks_touch before update on tasks
  for each row execute function touch_updated_at();

-- ---------- Realtime 발행: 대시보드가 변경을 실시간 구독 ----------
alter publication supabase_realtime add table agents;
alter publication supabase_realtime add table tasks;

-- ---------- RLS : 데모는 읽기 공개, 쓰기는 service_role 키로만 ----------
alter table agents enable row level security;
alter table tasks  enable row level security;

drop policy if exists "agents read" on agents;
create policy "agents read" on agents for select using (true);

drop policy if exists "tasks read" on tasks;
create policy "tasks read" on tasks for select using (true);
-- (insert/update 는 service_role 키가 RLS를 우회하므로 별도 정책 불필요)

-- ---------- 시드: 오케스트레이터 + 워커(NATO 순차) ----------
-- 워커 이름 원칙: NATO 부호로 순차 생성 (알파 → 브라보 → 찰리 → 델타 …). 한 PC = 한 중대.
-- 워커를 늘리려면 다음 NATO 이름으로 행을 추가하고, 해당 PC에서 AGENT_NAME=<이름> npm run worker 로 띄운다.
insert into agents (name, role, squad, kind) values
  ('오케스트레이터(참모장)', '총괄 지휘 · 작업 배분',  '지휘부', 'orchestrator'),
  ('알파',           '코드 작성 · 디버깅',     '1중대',  'claude_code'),
  ('브라보',         '문서 정리 · 요약 · 교정', '1중대',  'claude_code')
on conflict (name) do nothing;

-- 알파·브라보: 이 PC(claude_code)에서 워커로 동작. host/workdir 는 환경에 맞게 수정.
-- (claude_code 어댑터는 워커 PC의 claude CLI 구독을 사용한다.)
update agents set host='YOUR-PC-NAME', workdir='C:/Dev/pocket-command-system/_agentwork/알파'   where name='알파';
update agents set host='YOUR-PC-NAME', workdir='C:/Dev/pocket-command-system/_agentwork/브라보' where name='브라보';
