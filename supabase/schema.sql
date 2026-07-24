-- =====================================================================
-- POCKET COMMAND SUPPORTING SYSTEM (PCSS) — Supabase 스키마
-- 공식 한글 명칭: 주머니 속 AI 작업팀 지휘통제 지원 시스템
--
-- 호환 원칙:
--   - 기존 agents/tasks 기반 설치를 유지한다.
--   - 신규 hosts/platoons/platoon_runs/audits/events는 세션=소대 모델을 위한 확장이다.
--   - PCSS는 명령 배정자/전달자/상위 AI 지휘관이 아니다. PO가 소대장에게 직접 명령한다.
-- =====================================================================

-- ---------- ENUM 정의 ----------
do $$ begin
  create type agent_status as enum ('idle', 'working', 'error', 'offline');
exception when duplicate_object then null; end $$;

do $$ begin
  create type task_status as enum ('queued', 'in_progress', 'done', 'failed');
exception when duplicate_object then null; end $$;

-- ---------- agents : legacy 워커/소대장 실행 프로세스 현황 ----------
-- PCSS v3.1부터 PO의 정식 직접 대상은 platoons(Claude Code 세션=소대)다.
-- agents는 기존 워커 데몬과 운영 데이터를 깨지 않기 위한 호환 실행 계층으로 유지한다.
create table if not exists agents (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,          -- 알파, 브라보, 찰리 ... legacy worker name
  role             text not null,                 -- 역할 설명
  squad            text default '1중대',          -- legacy grouping; 신규 PC 그룹은 hosts 사용
  kind             text not null default 'claude_api', -- python | claude_code | claude_api | legacy orchestrator
  host             text,                          -- 어느 로컬 머신에 사는지 (예: PC-A)
  workdir          text,                          -- 작업 디렉터리 (python/claude_code 실행 위치)
  entry            text,                          -- python 일 때 실행할 스크립트 경로 또는 claude config dir 호환 필드
  skill            text,                          -- claude_code 일 때 발동할 스킬명 (예: youtube-analysis)
  session_id       text,                          -- claude_code 대화 세션 이어붙이기용
  status           agent_status not null default 'idle',
  control          text not null default 'run',   -- 'run' | 'stop' (중단 신호)
  current_task_id  uuid,
  last_heartbeat_at timestamptz,                  -- 농땡이/오프라인 판정 기준
  beats            bigint not null default 0,     -- 누적 하트비트 수(EKG 펄스용)
  usage_state      jsonb,                         -- claude_code 워커의 구독 사용량(5h/7d) 스냅샷
  updated_at       timestamptz not null default now()
);

-- 기존 배포에 컬럼만 추가하는 마이그레이션 (신규 설치는 위 CREATE TABLE에 이미 포함됨)
alter table if exists agents add column if not exists usage_state jsonb;

-- ---------- tasks : 업무 지시 큐 ----------
create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  command_text     text not null,                 -- PO가 선택한 소대/legacy worker에 남긴 명령 텍스트
  assigned_agent   text references agents(name),   -- legacy queue consumer: worker name
  status           task_status not null default 'queued',
  source_chat_id   bigint,                        -- 결과를 돌려보낼 텔레그램 chat id
  result           text,
  progress         text,                          -- 실행 중 진행 로그 꼬리
  attachments      jsonb,                         -- 첨부파일 메타 배열 [{path,url,name,size,mime}]
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_tasks_agent  on tasks(assigned_agent);

-- 기존 배포에 컬럼만 추가하는 마이그레이션 (신규 설치는 위 CREATE TABLE에 이미 포함됨)
alter table if exists tasks add column if not exists progress text;
alter table if exists tasks add column if not exists attachments jsonb;

-- ---------- hosts : PC/중대 단위 물리 그룹 ----------
-- host는 지휘관이 아니다. 한 컴퓨터에 배치된 여러 소대를 묶어 보여주는 물리 그룹이다.
create table if not exists hosts (
  id                  uuid primary key default gen_random_uuid(),
  label               text not null,
  machine_name        text not null unique,
  os                  text,
  capacity            jsonb,
  status              text not null default 'offline',
  last_heartbeat_at   timestamptz,
  active_platoons     integer not null default 0,
  cpu_load            numeric,
  memory_load         numeric,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------- platoons : Claude Code 세션=소대 정본 ----------
create table if not exists platoons (
  id                       uuid primary key default gen_random_uuid(),
  host_id                  uuid references hosts(id) on delete set null,
  project_id               text,
  leader_worker_id         uuid references agents(id) on delete set null,
  claude_session_id        text,
  workdir                  text,
  status                   text not null default 'idle',
  current_task_id          uuid references tasks(id) on delete set null,
  formation_status         text not null default 'none',
  active_internal_agents   integer not null default 0,
  cumulative_agent_runs    bigint not null default 0,
  last_heartbeat_at        timestamptz,
  dirty                    boolean not null default false,
  current_branch           text,
  current_sha              text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint platoons_leader_worker_unique unique (leader_worker_id)
);

do $$ begin
  alter table platoons add constraint platoons_leader_worker_unique unique (leader_worker_id);
exception when duplicate_object then null; end $$;

create index if not exists idx_platoons_host on platoons(host_id);
create index if not exists idx_platoons_status on platoons(status);
create index if not exists idx_platoons_project on platoons(project_id);

-- ---------- platoon_runs : 소대 내부 편성 실행 기록 ----------
-- Claude Agent Teams, Codex, Antigravity, Dynamic Workflows는 직접 지휘 대상이 아니라 소대 내부 실행 기록이다.
create table if not exists platoon_runs (
  id                       uuid primary key default gen_random_uuid(),
  platoon_id               uuid not null references platoons(id) on delete cascade,
  task_id                  uuid references tasks(id) on delete set null,
  formation_type           text not null,
  started_at               timestamptz not null default now(),
  completed_at             timestamptz,
  peak_parallelism         integer not null default 0,
  cumulative_runs          bigint not null default 0,
  claude_teammates         integer not null default 0,
  codex_calls              integer not null default 0,
  antigravity_calls        integer not null default 0,
  dynamic_workflow_runs    integer not null default 0,
  status                   text not null default 'running'
);

create index if not exists idx_platoon_runs_platoon on platoon_runs(platoon_id);
create index if not exists idx_platoon_runs_task on platoon_runs(task_id);

-- ---------- audits : 독립 감사 정본 ----------
create table if not exists audits (
  id                    uuid primary key default gen_random_uuid(),
  project_id            text,
  platoon_id            uuid references platoons(id) on delete set null,
  task_id               uuid references tasks(id) on delete set null,
  audited_sha           text not null,
  auditor_id            uuid references agents(id) on delete set null,
  status                text not null default 'queued',
  verdict               text,
  severity_max          text,
  opinion_path          text,
  findings_path         text,
  fix_sha               text,
  attempt               integer not null default 1,
  idempotency_key       text unique,
  created_at            timestamptz not null default now(),
  completed_at          timestamptz
);

create index if not exists idx_audits_platoon on audits(platoon_id);
create index if not exists idx_audits_task on audits(task_id);
create index if not exists idx_audits_sha on audits(audited_sha);
create index if not exists idx_audits_status on audits(status);

-- ---------- events : 불변 이벤트 로그 ----------
create table if not exists events (
  id                    uuid primary key default gen_random_uuid(),
  event_type            text not null,
  actor                 text,
  host_id               uuid references hosts(id) on delete set null,
  platoon_id            uuid references platoons(id) on delete set null,
  task_id               uuid references tasks(id) on delete set null,
  audit_id              uuid references audits(id) on delete set null,
  idempotency_key       text unique,
  payload               jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists idx_events_type on events(event_type);
create index if not exists idx_events_platoon on events(platoon_id);
create index if not exists idx_events_task on events(task_id);

-- ---------- tasks 호환 확장 컬럼 ----------
alter table if exists tasks add column if not exists assigned_platoon_id uuid references platoons(id) on delete set null;
alter table if exists tasks add column if not exists ordered_by text not null default 'PO';
alter table if exists tasks add column if not exists task_type text not null default 'po_direct_command';
alter table if exists tasks add column if not exists parent_task_id uuid references tasks(id) on delete set null;
alter table if exists tasks add column if not exists audit_id uuid references audits(id) on delete set null;
alter table if exists tasks add column if not exists priority integer not null default 0;
alter table if exists tasks add column if not exists base_sha text;
alter table if exists tasks add column if not exists result_sha text;
alter table if exists tasks add column if not exists branch text;
alter table if exists tasks add column if not exists attempt integer not null default 1;
alter table if exists tasks add column if not exists max_attempts integer not null default 3;
alter table if exists tasks add column if not exists lease_expires_at timestamptz;
alter table if exists tasks add column if not exists idempotency_key text;

create index if not exists idx_tasks_platoon on tasks(assigned_platoon_id);
create index if not exists idx_tasks_audit on tasks(audit_id);
create index if not exists idx_tasks_idempotency on tasks(idempotency_key);

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

drop trigger if exists trg_hosts_touch on hosts;
create trigger trg_hosts_touch before update on hosts
  for each row execute function touch_updated_at();

drop trigger if exists trg_platoons_touch on platoons;
create trigger trg_platoons_touch before update on platoons
  for each row execute function touch_updated_at();

-- ---------- legacy agents -> hosts/platoons best-effort backfill ----------
insert into hosts (machine_name, label, status, last_heartbeat_at, active_platoons)
select
  a.host,
  a.host,
  case when max(a.last_heartbeat_at) is null then 'offline' else 'online' end,
  max(a.last_heartbeat_at),
  count(*)::integer
from agents a
where a.host is not null and a.host <> ''
group by a.host
on conflict (machine_name) do update set
  label = excluded.label,
  last_heartbeat_at = excluded.last_heartbeat_at,
  active_platoons = excluded.active_platoons;

insert into platoons (
  host_id,
  leader_worker_id,
  claude_session_id,
  workdir,
  status,
  current_task_id,
  last_heartbeat_at
)
select
  h.id,
  a.id,
  a.session_id,
  a.workdir,
  case a.status
    when 'working' then 'running'
    when 'offline' then 'offline'
    when 'error' then 'error'
    else 'idle'
  end,
  a.current_task_id,
  a.last_heartbeat_at
from agents a
left join hosts h on h.machine_name = a.host
where coalesce(a.kind, '') <> 'orchestrator'
on conflict (leader_worker_id) do update set
  host_id = excluded.host_id,
  claude_session_id = excluded.claude_session_id,
  workdir = excluded.workdir,
  status = excluded.status,
  current_task_id = excluded.current_task_id,
  last_heartbeat_at = excluded.last_heartbeat_at;

update tasks t
set assigned_platoon_id = p.id
from platoons p
join agents a on a.id = p.leader_worker_id
where t.assigned_platoon_id is null
  and t.assigned_agent = a.name;

-- ---------- Realtime 발행: 대시보드가 변경을 실시간 구독 ----------
do $$ begin alter publication supabase_realtime add table agents; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table tasks; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table hosts; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table platoons; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table platoon_runs; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table audits; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table events; exception when duplicate_object then null; end $$;

-- ---------- RLS : 데모는 읽기 공개, 쓰기는 service_role 키로만 ----------
alter table agents enable row level security;
alter table tasks  enable row level security;
alter table hosts enable row level security;
alter table platoons enable row level security;
alter table platoon_runs enable row level security;
alter table audits enable row level security;
alter table events enable row level security;

drop policy if exists "agents read" on agents;
create policy "agents read" on agents for select using (true);

drop policy if exists "tasks read" on tasks;
create policy "tasks read" on tasks for select using (true);

drop policy if exists "hosts read" on hosts;
create policy "hosts read" on hosts for select using (true);

drop policy if exists "platoons read" on platoons;
create policy "platoons read" on platoons for select using (true);

drop policy if exists "platoon_runs read" on platoon_runs;
create policy "platoon_runs read" on platoon_runs for select using (true);

drop policy if exists "audits read" on audits;
create policy "audits read" on audits for select using (true);

drop policy if exists "events read" on events;
create policy "events read" on events for select using (true);
-- (insert/update 는 service_role 키가 RLS를 우회하므로 별도 정책 불필요)

-- ---------- 시드: legacy 워커(NATO 순차) ----------
-- 워커 이름 원칙: NATO 부호로 순차 생성 (알파 → 브라보 → 찰리 → 델타 …).
-- 오케스트레이터(자연어 명령 라우터)는 2026-07-13 PO 지시로 은퇴했고 신규 시드에서 제외한다.
insert into agents (name, role, squad, kind) values
  ('알파',           '코드 작성 · 디버깅',     '1중대',  'claude_code'),
  ('브라보',         '문서 정리 · 요약 · 교정', '1중대',  'claude_code')
on conflict (name) do nothing;

-- 알파·브라보: 이 PC(claude_code)에서 워커로 동작. host/workdir 는 환경에 맞게 수정.
-- 신규 설치에서는 이 legacy worker row에 대응하는 platoons row가 위 backfill로 생성된다.
update agents set host='YOUR-PC-NAME', workdir='C:/Dev/pocket-command-supporting-system/_agentwork/알파'   where name='알파';
update agents set host='YOUR-PC-NAME', workdir='C:/Dev/pocket-command-supporting-system/_agentwork/브라보' where name='브라보';
