'use client';

// PCSS 콕핏 — PO가 소대 세션을 직접 선택해 지휘하는 지원 화면. legacy worker 매핑을 호환 표시하고,
// 카드를 탭해 소대장/legacy worker를 고른 뒤 하단 독에서 직접 대화한다(텔레그램 없이).

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import { createBrowserClient } from '@/lib/supabase';
import { Agent, Task, Attachment, Platoon, Host, EventLog, deriveStatus, STATUS_META, USAGE_STALE_SEC, LEADER_SEEN_STALE_SEC, HEARTBEAT_TIMEOUT_SEC } from '@/lib/types';
import s from './cockpit.module.css';

type TeamMember = { name: string; role: string; model?: string };
// meta: true — PCSS 본체·비서관 같은 실제 "프로젝트"가 아니라
//   체계 조직 항목인 카드. 카드로는 계속 보이되 "내 프로젝트 N개" 집계에선 제외한다.
type Proj = { id: string; label: string; worker: string; auditor: string; git: string; team?: TeamMember[]; meta?: boolean };
// ★ 운영 실데이터(프로젝트 실명·워커 편제)를 클라이언트 번들에 안 박기 위해 정적 import 대신
//   /api/projects에서 서버(Node fs)로만 읽어 fetch한다 — config/projects.json 직접 import 금지.
//   공개 clone엔 projects.local.json 자체가 없어 서버가 예시(config/projects.json)로 자동 폴백한다.

const TASK_LABELS: Record<string, string> = { queued: '대기', in_progress: '진행', done: '완료', failed: '실패' };
const TASK_COLORS: Record<string, string> = { queued: '#7C8AA0', in_progress: '#38BDF8', done: '#22C55E', failed: '#E5556F' };
// 상태 미상(워커 없음 등) 도트·트레이스 기본색 — 정제된 뉴트럴 보더 톤(과거 #3a3a3a 대체)
const NEUTRAL_DOT = '#2C3546';

// 파일 크기 사람이 읽는 단위로 — 12.3 KB / 4.5 MB.
function fmtSize(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 말풍선 코너 상태 아이콘(텔레그램식) — 전송중=시계 · 대기=✓ · 완료=✓✓ · 실패=⚠.
//   진행중(in_progress)은 글리프 대신 애니메이션 타이핑 점(●●●)을 statusIcon에서 별도 반환.
const ICONS = { sending: '🕘', queued: '✓', done: '✓✓', failed: '⚠' } as const;

// 태스크 상태 → 말풍선 코너에 찍을 상태 글리프(진행중은 호출부에서 타이핑 점으로 별도 처리).
function statusIcon(status: string): string {
  if (status === 'done') return ICONS.done;
  if (status === 'failed') return ICONS.failed;
  return ICONS.queued; // queued 및 기타
}

// 말풍선 내부 우하단에 찍는 짧은 시각 — 텔레그램처럼 "오후 3:07" 형태(HH:MM만).
//   상대시간(relTime)은 카드/메타 배지용, 이건 대화 말풍선 코너 전용.
function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  return new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

// 날짜 구분 칩 라벨 — "오늘 / 어제 / 7월 5일 / 2025년 12월 3일(해 넘어가면)".
//   스레드에서 날짜가 바뀔 때마다 중앙에 필 칩으로 끼워 넣는다(텔레그램식).
function dateChip(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const then = new Date(iso);
  if (!then.getTime()) return '';
  const nd = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOf(nd) - startOf(then)) / 86400000);
  if (dayDiff === 0) return '오늘';
  if (dayDiff === 1) return '어제';
  if (then.getFullYear() === nd.getFullYear())
    return then.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
  return then.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

// 로컬 날짜 키(YYYY-MM-DD) — 스레드에서 "날짜가 바뀌었나" 비교용(타임존 안전하게 로컬 기준).
function dayKey(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!d.getTime()) return '';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// 상대 시간 — "방금 · N분 전 · N시간 전 · N일 전". 카드/태스크 최신성을 한눈에.
//   1분 미만은 '방금', 하루 넘어가면 날짜(MM.DD)로 떨어뜨려 오래된 항목이 과장돼 보이지 않게 한다.
function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!then) return '';
  const sec = Math.max(0, (now - then) / 1000);
  if (sec < 60) return '방금';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(then).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' });
}

// 관제 보드에서 통합한 하트비트(EKG) 파형 — 살아있으면 심전도, offline이면 평평
const EKG_TRACE = 'M0 13 L34 13 L40 13 L44 4 L49 22 L54 13 L72 13 L78 13 L82 9 L86 13 L120 13 L154 13 L160 13 L164 4 L169 22 L174 13 L192 13 L198 13 L202 9 L206 13 L240 13';
const EKG_FLAT = 'M0 13 L240 13';

// 감사관이 자동으로 낸 최근 판정을 텍스트에서 추출 (감사관 태스크의 결과/명령문 기준)
// ★ PCSS 감사관의 top-line verdict는 '[정상]' 마커 — 이게 있으면 본문에 '권고/지적' 언급이 있어도 정상.
//   그래서 [정상]을 먼저 판정하고, 없을 때만 문제 마커([필수]/[중대]/결함 등)로 지적 여부를 본다.
function classifyAudit(text?: string | null): { label: string; warn: boolean } | null {
  if (!text) return null;
  if (/\[정상\]/.test(text)) return { label: '정상', warn: false };
  if (/\[(필수|주의|중대|치명|major|critical)\]|결함|위반|불합격|누락 발견|취약점|🔴|\bFail\b|\bDanger\b/i.test(text))
    return { label: '지적', warn: true };
  return { label: '완료', warn: false };
}

// 감사 태스크 command_text에서 diff 블록을 추출한다.
//   enqueue-audit.js가 만드는 프롬프트 포맷(고정): '[변경 내용]' 또는 '[변경 내용 (앞부분만)]' 다음 줄부터
//   빈 줄 하나를 사이에 두고 "너는 '<감사관명>'이다." 문단이 시작되기 직전까지가 diff 전체다.
//   서버 git 호출 없이 이미 태스크에 실려온 텍스트만 파싱한다(순수 프론트).
function extractAuditDiff(commandText?: string | null): { diff: string; truncated: boolean; commit: string | null; added: number; removed: number } | null {
  if (!commandText) return null;
  const m = commandText.match(/\[변경 내용([^\]]*)\]\r?\n([\s\S]*?)\r?\n\n너는 '/);
  if (!m || !m[2].trim()) return null;
  const truncated = /앞부분만/.test(m[1]);
  const diff = m[2];
  const commitMatch = commandText.match(/^커밋:\s*(\S+)/m);
  const commit = commitMatch ? commitMatch[1].slice(0, 8) : null;
  // 대략적인 +/- 라인 카운트 — diff 메타(+++/---  헤더)는 제외하고 실제 변경 라인만.
  let added = 0, removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { diff, truncated, commit, added, removed };
}

// 구독 사용량 게이지 — stale(10분 이상 미갱신)이면 표시하지 않는다(오판 방지).
function usageGauge(a: Agent | null, now: number): { text: string; color: string } | null {
  const u = a?.usage_state;
  if (!u?.fetched_at) return null;
  const ageSec = (now - new Date(u.fetched_at).getTime()) / 1000;
  if (ageSec > USAGE_STALE_SEC) return null;
  const color = u.severity === 'critical' ? '#E5556F' : u.severity === 'warning' ? '#E0A93B' : 'var(--text-dim)';
  const resetTime = u.five_hour?.resets_at
    ? new Date(u.five_hour.resets_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '—';
  return { text: `5h ${u.five_hour?.pct ?? 0}% · 리셋 ${resetTime} · 주 ${u.seven_day?.pct ?? 0}%`, color };
}

export default function Cockpit() {
  const [PROJECTS, setProjects] = useState<Proj[]>([]); // /api/projects에서 로드(정적 import 아님 — 번들 분리 목적)
  const [projLoaded, setProjLoaded] = useState(false); // 최초 /api/projects 응답 도착 여부 — 로딩/빈 상태 구분용
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [platoons, setPlatoons] = useState<Platoon[]>([]); // 소대 정본 — 소대장 모드(세션/데몬) 표시용
  const [hosts, setHosts] = useState<Host[]>([]); // PC/중대 물리 그룹 — 프로젝트 카드를 PC별로 묶어 보여주는 데 사용
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(new Set()); // 접힌 PC 그룹(호스트 키) — 기본 펼침
  const [events, setEvents] = useState<EventLog[]>([]); // 인박스(충돌 경고)용 — 최근 50건만(RLS 공개 조회)
  const [inboxOpen, setInboxOpen] = useState(false); // 헤더 🔔 → 인박스 패널 펼침
  // 예외함 'failed 24h' 전용 쿼리 결과 — 일반 tasks(limit 120, updated_at desc)에 얹으면 24h 내 갱신량이
  //   120건을 넘을 때 오래된 failed 건이 배열 밖으로 밀려 조용히 누락된다(V① 반려 결함). 그래서 별도 쿼리로 분리.
  const [failedTasks24h, setFailedTasks24h] = useState<Task[]>([]);
  const [now, setNow] = useState(Date.now());
  const [sel, setSel] = useState<string | null>(null); // 선택된 프로젝트 id
  const [selAgent, setSelAgent] = useState<string | null>(null); // 프로젝트 내 명령 대상(팀원 선택 시 override, null=워커)
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [pending, setPending] = useState<{ id: string; text: string; agent: string; failed?: boolean; attachments?: Attachment[] }[]>([]);
  const [diffOpen, setDiffOpen] = useState<Set<string>>(new Set()); // "diff 보기" 펼침 상태 — 카드(프로젝트 id)별 로컬
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState<'all' | 'alert' | 'working'>('all'); // 프로젝트 카드 빠른 필터
  const [query, setQuery] = useState(''); // 프로젝트 이름/워커 검색
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockH, setDockH] = useState(168); // 하단 독의 실제 높이 — 본문 여백으로 예약(최신 글이 독 뒤에 가리지 않게)
  const [actionsOpen, setActionsOpen] = useState(false); // 채팅 헤더 ⚡ → 급정지/재가동/종료 액션시트 펼침
  const [files, setFiles] = useState<File[]>([]); // 컴포저에서 고른(아직 안 보낸) 첨부파일들
  const [uploading, setUploading] = useState(false); // 첨부 업로드 중(전송 버튼 스피너)
  const fileRef = useRef<HTMLInputElement>(null); // 📎 → hidden file input

  // 모바일 키보드가 올라오면 명령 독을 키보드 위로 띄운다(전송 버튼이 안 가리게)
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const onResize = () => {
      const overlap = window.innerHeight - vv.height - vv.offsetTop;
      if (dockRef.current) dockRef.current.style.transform = `translateY(-${Math.max(0, overlap)}px)`;
    };
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => { vv.removeEventListener('resize', onResize); vv.removeEventListener('scroll', onResize); };
  }, []);

  // 하단 독의 실제 높이를 추적 — 독 높이만큼 본문 아래 여백을 예약해야 맨 아래 글이 독에 가리지 않는다.
  // (독은 position:fixed이고 빠른버튼+여러 줄 컴포저로 높이가 변해, CSS 고정 padding-bottom으론 부족했다.)
  useEffect(() => {
    const el = dockRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setDockH(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 대상 프로젝트/에이전트가 바뀌거나 대화를 닫으면 액션시트는 접고, 고른 첨부도 비운다(엉뚱한 대상에 남지 않게).
  useEffect(() => { setActionsOpen(false); setFiles([]); }, [sel, selAgent]);

  // 프로젝트 매핑(운영 실데이터 or 공개본 예시) — 서버 API로만 로드, 클라이언트 번들엔 안 실림.
  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok || !Array.isArray(j.projects)) return;
        setProjects(j.projects);
        // 텔레그램 회신 버튼의 프로젝트 딥링크(?p=프로젝트id) — PO 지시(2026-07-17 "프로젝트별로 바로 연결").
        //   존재하는 id면 첫 로드에 그 프로젝트 대화를 바로 연다. 최초 1회(마운트 시)만 — 이후 탐색은 안 건드림.
        const p = new URLSearchParams(window.location.search).get('p');
        if (p && (j.projects as Proj[]).some((x) => x.id === p)) setSel(p);
      })
      .catch(() => {}) // 실패해도 조용히 — 아래 목록 렌더가 빈 배열로 자연스럽게 처리
      .finally(() => setProjLoaded(true)); // 성공·실패 무관하게 로딩 종료 표시(빈 상태 vs 로딩 구분)
  }, []);

  useEffect(() => {
    const sb = createBrowserClient();
    if (!sb) { setLive(false); return; } // 콕핏은 라이브 전용 (데모 시드 없음) — 미설정 시 안내 배너로 알림
    const load = async () => {
      const [{ data: a }, { data: tk }, { data: pl }, { data: h }, { data: ev }, { data: ft }] = await Promise.all([
        sb.from('agents').select('*'),
        sb.from('tasks').select('*').order('updated_at', { ascending: false }).limit(120),
        sb.from('platoons').select('*'), // 미적용 DB(마이그레이션 전)면 data=null — 배지만 안 뜨고 나머지 무영향
        sb.from('hosts').select('*'), // 미적용 DB면 data=null — PC 그룹핑 없이 '미지정 PC' 단일 그룹으로 폴백
        sb.from('events').select('*').order('created_at', { ascending: false }).limit(50), // 인박스 충돌경고용
        // 인박스 예외함 'failed 24h' 전용 — 위 tasks(limit 120)와 별개로 직접 필터링해 누락 방지(V① 반려 수정).
        sb.from('tasks').select('*').eq('status', 'failed')
          .gte('updated_at', new Date(Date.now() - 86400000).toISOString())
          .order('updated_at', { ascending: false }).limit(200),
      ]);
      if (a) setAgents(a as Agent[]);
      if (tk) setTasks(tk as Task[]);
      if (pl) setPlatoons(pl as Platoon[]);
      if (h) setHosts(h as Host[]);
      if (ev) setEvents(ev as EventLog[]);
      if (ft) setFailedTasks24h(ft as Task[]);
    };
    load();
    const poll = setInterval(load, 15000);
    const ch = sb
      .channel('cockpit')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'platoons' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hosts' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, () => load())
      .subscribe();
    return () => { clearInterval(poll); sb.removeChannel(ch); };
  }, []);

  const byName = (n: string) => agents.find((x) => x.name === n) || null;
  const flash = (msg: string, err = false) => { setToast({ msg, err }); setTimeout(() => setToast(null), 2600); };

  async function post(agent: string, body: Record<string, unknown>, okMsg: string): Promise<boolean> {
    setSending(true);
    let ok = false;
    try {
      const r = await fetch('/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, ...body }),
      });
      const j = await r.json();
      ok = !!j.ok;
      if (ok) flash(okMsg); else flash(j.error || '실패', true);
    } catch { flash('네트워크 오류', true); }
    setSending(false);
    return ok;
  }

  const selProj = PROJECTS.find((p) => p.id === sel) || null;
  // 명령 대상 후보: 워커 + 팀원(감사관 제외 — 감사는 자동 전용이라 대화 대상 아님).
  const cmdTargets = selProj ? [selProj.worker, ...(selProj.team?.map((m) => m.name) ?? [])].filter(Boolean) : [];
  // 실제 명령 대상: 팀원을 골랐으면 그 이름, 아니면 워커.
  const activeAgent = selProj ? ((selAgent && cmdTargets.includes(selAgent)) ? selAgent : selProj.worker) : null;

  async function sendCommand() {
    if (!selProj || !activeAgent) return;
    const body = text.trim();
    const toSend = files;
    // 텍스트도 첨부도 없으면 전송 안 함(둘 중 하나는 있어야).
    if (!body && toSend.length === 0) return;
    if (uploading || sending) return; // 업로드/전송 진행 중엔 중복 전송 방지
    const worker = activeAgent;
    // 낙관적 표시: 보내는 즉시 내 말풍선을 대화에 띄우고 유지 (서버 반영 전까지 '전송중').
    //   첨부는 업로드 전이라 아직 url이 없으므로, 로컬 미리보기(object URL)로 임시 표시한다.
    const optId = 'opt-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const optAtt: Attachment[] = toSend.map((f) => ({
      path: '', url: f.type.startsWith('image/') ? URL.createObjectURL(f) : '', name: f.name, size: f.size, mime: f.type,
    }));
    setPending((prev) => [...prev, { id: optId, text: body, agent: worker, attachments: optAtt.length ? optAtt : undefined }]);
    setText('');
    setFiles([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    inputRef.current?.focus();

    // 첨부가 있으면 먼저 업로드 → 메타 획득. 업로드 실패면 전송 중단하고 낙관적 말풍선을 실패 마킹.
    let attachments: Attachment[] = [];
    if (toSend.length > 0) {
      setUploading(true);
      try {
        const fd = new FormData();
        toSend.forEach((f) => fd.append('file', f));
        const r = await fetch('/api/upload', { method: 'POST', body: fd });
        const j = await r.json();
        if (!j.ok) { flash(j.error || '첨부 업로드 실패', true); setPending((prev) => prev.map((p) => (p.id === optId ? { ...p, failed: true } : p))); setUploading(false); return; }
        attachments = j.attachments as Attachment[];
      } catch { flash('첨부 업로드 네트워크 오류', true); setPending((prev) => prev.map((p) => (p.id === optId ? { ...p, failed: true } : p))); setUploading(false); return; }
      setUploading(false);
    }

    // 전송 실패 시 낙관적 말풍선을 '전송 실패'로 마킹(무기한 '전송중' 잔존 방지). 성공 시 태스크 도착 dedup가 제거.
    const ok = await post(worker, { text: body, ...(attachments.length ? { attachments } : {}) }, `▶ ${worker}에게 전송`);
    if (!ok) setPending((prev) => prev.map((p) => (p.id === optId ? { ...p, failed: true } : p)));
  }

  // 📎 파일 선택 — 최대 5개, 각 20MB 제한(서버와 동일). 초과분은 잘라내고 안내.
  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const picked = Array.from(list);
    const tooBig = picked.filter((f) => f.size > 20 * 1024 * 1024);
    let next = [...files, ...picked.filter((f) => f.size <= 20 * 1024 * 1024)];
    if (tooBig.length) flash(`${tooBig.length}개 파일이 20MB를 초과해 제외됨`, true);
    if (next.length > 5) { flash('첨부는 최대 5개까지', true); next = next.slice(0, 5); }
    setFiles(next);
    if (fileRef.current) fileRef.current.value = ''; // 같은 파일 재선택 허용
  }
  function removeFile(idx: number) { setFiles((prev) => prev.filter((_, i) => i !== idx)); }

  // 말풍선 안 첨부 렌더 — 이미지면 썸네일, 아니면 파일 칩(이름·크기 + 다운로드 링크).
  function renderAtts(atts: Attachment[] | null | undefined) {
    if (!atts || atts.length === 0) return null;
    return (
      <div className={s.attWrap}>
        {atts.map((a, i) => {
          const isImg = a.mime?.startsWith('image/') && a.url;
          if (isImg) {
            return (
              <a key={i} href={a.url} target="_blank" rel="noreferrer" className={s.attThumb} title={a.name}>
                {/* 원격 이미지(썸네일) — next/image 대신 순수 img(외부 signed URL·도메인 화이트리스트 불필요) */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt={a.name} loading="lazy" />
              </a>
            );
          }
          const chip = (
            <>
              <span className={s.attIco}>📄</span>
              <span className={s.attInfo}>
                <span className={s.attName}>{a.name}</span>
                <span className={s.attSize}>{fmtSize(a.size)}</span>
              </span>
            </>
          );
          return a.url
            ? <a key={i} href={a.url} target="_blank" rel="noreferrer" className={s.attFile} title={`${a.name} 다운로드`}>{chip}</a>
            : <span key={i} className={s.attFile}>{chip}</span>;
        })}
      </div>
    );
  }

  // 실제 태스크가 도착하면 같은 문구의 낙관적 말풍선 제거(중복 방지)
  useEffect(() => {
    setPending((prev) => prev.filter((p) => !tasks.some((t) => t.assigned_agent === p.agent && t.command_text === p.text)));
  }, [tasks]);

  // 태스크 취소/재시도 — 콘솔에서 흡수. 기존 /api/control(action,taskId) 재사용.
  async function taskAction(action: 'cancel' | 'retry', task: Task) {
    setSending(true);
    try {
      const r = await fetch('/api/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, taskId: task.id }),
      });
      const j = await r.json();
      flash(j.ok ? (action === 'cancel' ? '취소/중단 신호 전송' : '재시도 큐 적재') : (j.error || '실패'), !j.ok);
    } catch { flash('네트워크 오류', true); }
    setSending(false);
  }

  // 미분류: projects.json에 없는 에이전트 (새 워커도 절대 안 숨김 — 관제 보드 흡수)
  const mappedNames = new Set(PROJECTS.flatMap((p) => [p.worker, p.auditor, ...(p.team?.map((m) => m.name) ?? [])].filter(Boolean)));
  const unmapped = agents.filter((a) => !mappedNames.has(a.name));
  // 태스크 섹션: 프로젝트 선택 시 그 워커 것만(감사관 제외 — 채팅은 워커와만, 감사는 자동 전용),
  //   미선택 시 전체(콘솔 흡수)
  const shownTasks = selProj
    ? tasks.filter((t) => t.assigned_agent === activeAgent)
    : tasks.slice(0, 30);

  // 대화 열기·전송·새 메시지 도착(텔레그램 포함)·독 높이 변화 시 맨 아래(최신)로 스크롤 — 방금 보낸/도착한 글이 항상 보이게.
  // 고정 타이머(70ms) 대신 레이아웃 반영 후(rAF 2회) 스크롤해, 새 말풍선의 실제 높이가 반영된 뒤 정확히 바닥으로 간다.
  const chatSig = `${sel}|${selAgent}|${pending.length}|${shownTasks.length}|${dockH}`;
  useEffect(() => {
    if (!sel) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSig]);

  // 경고 배너: 오프라인/오류/무응답 워커
  const alerts = PROJECTS.map((p) => {
    const w = byName(p.worker);
    if (!w) return null;
    const st = deriveStatus(w, now);
    return (st === 'offline' || st === 'error' || st === 'stuck') ? { label: p.label, st } : null;
  }).filter(Boolean) as { label: string; st: keyof typeof STATUS_META }[];

  // 감사 지적 배너: 감사관이 자동 검토에서 문제를 잡은 프로젝트
  const auditAlerts = PROJECTS.map((p) => {
    if (!p.auditor) return null;
    const at = tasks.find((t) => t.assigned_agent === p.auditor);
    const v = classifyAudit(at?.result || at?.command_text);
    return v?.warn ? { label: p.label } : null;
  }).filter(Boolean) as { label: string }[];

  // ── 인박스(안건2 MVP) — 신규 테이블 없이 기존 tasks/events/agents에서 파생 + 계약(convention)만 정의 ──
  //   PCSS는 지휘관이 아니라 '모아 보여주고 PO가 처리'하는 관측 UI다.
  const DAY_MS = 24 * 60 * 60 * 1000;

  // 예외함 ① 최근 24h 내 실패 태스크 — 전용 쿼리(failedTasks24h) 사용.
  //   일반 tasks(limit 120, updated_at desc)에 의존하면 24h 내 갱신량이 120건을 넘길 때 오래된 failed 건이
  //   배열 밖으로 밀려 조용히 누락된다(V① 반려 결함). id로 중복 제거(전용 쿼리가 정본, 못 미더우면 tasks에서 보강).
  type InboxItem = { id: string; kind: 'failed_task' | 'stuck_agent' | 'audit_flag' | 'approval' | 'conflict'; label: string; detail: string; time: string; projectId?: string; agentName?: string };
  const failedIds = new Set(failedTasks24h.map((t) => t.id));
  const failedSource = [
    ...failedTasks24h,
    ...tasks.filter((t) => t.status === 'failed' && !failedIds.has(t.id) && now - new Date(t.updated_at).getTime() < DAY_MS),
  ];
  const exFailedTasks: InboxItem[] = failedSource
    .filter((t) => now - new Date(t.updated_at).getTime() < DAY_MS)
    .map((t) => {
      const proj = PROJECTS.find((p) => p.worker === t.assigned_agent);
      return {
        id: 'ft-' + t.id, kind: 'failed_task',
        label: proj?.label || t.assigned_agent || '미배정',
        detail: (t.result || t.command_text || '').slice(0, 80),
        time: t.updated_at, projectId: proj?.id, agentName: t.assigned_agent || undefined,
      } as InboxItem;
    });

  // 예외함 ② STUCK/OFFLINE 워커(감사관 제외 — 감사관은 자동 전용이라 지휘 대상 아님)
  const exStuckAgents: InboxItem[] = agents
    .filter((a) => !a.name.endsWith('감사관'))
    .map((a) => ({ a, st: deriveStatus(a, now) }))
    .filter(({ st }) => st === 'stuck' || st === 'offline')
    .map(({ a, st }) => {
      const proj = PROJECTS.find((p) => p.worker === a.name);
      return {
        id: 'sa-' + a.id, kind: 'stuck_agent',
        label: proj?.label || a.name,
        detail: STATUS_META[st].label,
        time: a.updated_at, projectId: proj?.id, agentName: a.name,
      } as InboxItem;
    });

  // 예외함 ③ 최근 24h 내 감사 '지적' 판정
  const exAuditFlags: InboxItem[] = PROJECTS
    .filter((p) => p.auditor)
    .map((p) => {
      const at = tasks.find((t) => t.assigned_agent === p.auditor);
      if (!at || now - new Date(at.updated_at).getTime() >= DAY_MS) return null;
      const v = classifyAudit(at.result || at.command_text);
      if (!v?.warn) return null;
      return {
        id: 'af-' + at.id, kind: 'audit_flag',
        label: p.label, detail: (at.result || at.command_text || '').slice(0, 80),
        time: at.updated_at, projectId: p.id, agentName: p.worker,
      } as InboxItem;
    })
    .filter(Boolean) as InboxItem[];

  const exceptionItems = [...exFailedTasks, ...exStuckAgents, ...exAuditFlags]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  // 승인함 — 계약: task_type='approval_request' AND status='queued'. 적재 주체는 향후 워커/스킬(현재는 계약 정의뿐).
  const approvalItems: InboxItem[] = tasks
    .filter((t) => t.task_type === 'approval_request' && t.status === 'queued')
    .map((t) => {
      const proj = PROJECTS.find((p) => p.worker === t.assigned_agent);
      return {
        id: 'ap-' + t.id, kind: 'approval',
        label: proj?.label || t.assigned_agent || '미배정',
        detail: (t.command_text || '').slice(0, 80),
        time: t.created_at, projectId: proj?.id, agentName: t.assigned_agent || undefined,
      } as InboxItem;
    })
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  // 충돌 경고 — 계약: event_type='merge_conflict', payload.resolved !== true. payload 형식은 schema.sql 주석 참조.
  const conflictItems: InboxItem[] = events
    .filter((e) => e.event_type === 'merge_conflict' && (e.payload as Record<string, unknown> | null)?.resolved !== true)
    .map((e) => {
      const payload = (e.payload || {}) as { repo?: string; worker?: string; branch?: string; base?: string };
      const proj = PROJECTS.find((p) => p.worker === payload.worker);
      return {
        id: 'cf-' + e.id, kind: 'conflict',
        label: proj?.label || payload.repo || '알 수 없음',
        detail: payload.branch ? `${payload.branch} → ${payload.base || '?'}` : '충돌 정보 없음',
        time: e.created_at, projectId: proj?.id, agentName: payload.worker,
      } as InboxItem;
    })
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  const inboxCount = exceptionItems.length + approvalItems.length + conflictItems.length;

  // ── 함대 상태 집계 — 헤더 스트립용 (전 에이전트를 파생상태로 분류) ──
  const fleet = (() => {
    let working = 0, idle = 0;
    for (const a of agents) {
      const st = deriveStatus(a, now);
      if (st === 'working' || st === 'command') working++;
      else if (st === 'idle') idle++;
    }
    return { total: agents.length, working, idle };
  })();

  // 감사 지적 프로젝트 라벨 집합 (정렬·필터에서 재사용)
  const flaggedLabels = new Set(auditAlerts.map((a) => a.label));

  // 프로젝트 정렬 우선순위: 체계조직(meta — PCSS 본체·비서관)은 항상 맨 위 고정(원본 순서 유지) →
  //   그 아래 실제 프로젝트만 문제(오프라인/정체) → 감사지적 → 작업중 → 대기 → 워커없음 순.
  //   (PO 지시: PCSS/비서관는 상태와 무관하게 최상단에 고정돼야 함 — 과거 90으로 밀어 최하단에
  //   가던 버그를 -1로 정정)
  const projRank = (p: Proj): number => {
    if (p.meta) return -1;
    const w = byName(p.worker);
    const st = w ? deriveStatus(w, now) : null;
    if (st === 'offline' || st === 'error' || st === 'stuck') return 0;
    if (flaggedLabels.has(p.label)) return 1;
    if (st === 'working') return 2;
    if (st === 'command') return 3;
    if (st === 'idle') return 4;
    return 5;
  };

  // 카드 필터/검색 적용 + 우선순위 정렬 (원본 순서 보존을 위해 index tiebreak)
  const q = query.trim().toLowerCase();
  const visibleProjects = PROJECTS
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => {
      if (q && !(`${p.label} ${p.worker}`.toLowerCase().includes(q))) return false;
      if (filter === 'all') return true;
      const w = byName(p.worker);
      const st = w ? deriveStatus(w, now) : null;
      if (filter === 'working') return st === 'working' || st === 'command';
      // 'alert' — 문제 상태 or 감사지적
      return st === 'offline' || st === 'error' || st === 'stuck' || flaggedLabels.has(p.label);
    })
    .sort((a, b) => projRank(a.p) - projRank(b.p) || a.i - b.i)
    .map(({ p }) => p);

  // meta 카드(PCSS 본체·비서관)는 그룹핑 밖 최상단 고정 — projRank가 이미 이들을 맨 앞에 두므로
  //   원본 순서(visibleProjects)에서 그대로 분리하면 정렬이 보존된다.
  const metaProjects = visibleProjects.filter((p) => p.meta);
  const groupableProjects = visibleProjects.filter((p) => !p.meta);

  // worker → agents.host(machine_name) → hosts row 로 PC 그룹을 결정한다.
  //   host 미매칭(호스트 필드 없음/hosts에 없는 값)이면 '미지정 PC' 그룹으로 묶는다.
  const UNASSIGNED_HOST_KEY = '__unassigned__';
  const hostGroups = (() => {
    const map = new Map<string, { host: Host | null; projects: Proj[] }>();
    for (const p of groupableProjects) {
      const w = byName(p.worker);
      const h = w?.host ? hosts.find((x) => x.machine_name === w.host) || null : null;
      const key = h ? h.id : UNASSIGNED_HOST_KEY;
      if (!map.has(key)) map.set(key, { host: h, projects: [] });
      map.get(key)!.projects.push(p);
    }
    // 정렬: 이름 있는 호스트 먼저(label 가나다), 미지정은 항상 마지막.
    return Array.from(map.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => {
        if (a.key === UNASSIGNED_HOST_KEY) return 1;
        if (b.key === UNASSIGNED_HOST_KEY) return -1;
        return (a.host?.label || '').localeCompare(b.host?.label || '', 'ko');
      });
  })();

  function toggleHostGroup(key: string) {
    setCollapsedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <div className="console-shell">
      <header className="bar">
        <div className="wordmark">
          PCSS <span className="accent">COMMAND POST</span>
          <span className="sub">콕핏 · 오너 지휘 — 명령·취소·재시도 (결과 알림은 텔레그램)</span>
        </div>
        <nav className="nav">
          <button
            className={s.inboxBtn}
            onClick={() => setInboxOpen((v) => !v)}
            aria-label="인박스 (예외·승인·충돌)"
            aria-expanded={inboxOpen}
            title="인박스 — 예외·승인 대기·충돌 경고"
          >
            🔔{inboxCount > 0 && <span className={s.inboxBadge}>{inboxCount > 99 ? '99+' : inboxCount}</span>}
          </button>
          <Link href="/cockpit" className="active">콕핏</Link>
          <Link href="/console">콘솔</Link>
        </nav>
      </header>

      <div className={selProj ? `${s.cockpit} ${s.chatMode}` : s.cockpit} style={{ paddingBottom: dockH + 24 }}>
        {/* 함대 상태 스트립 — 카드를 다 훑지 않아도 함대 건강을 한눈에 */}
        <div className={s.fleet}>
          <div className={`${s.fleetStat} ${s.fleetTotal}`}>
            <span className={s.fleetNum}>{fleet.total}</span>
            <div className={s.fleetMeta}>
              <span className={s.fleetLabel}>에이전트</span>
              <span className={s.fleetSub}>내 프로젝트 {PROJECTS.filter((p) => !p.meta).length}개</span>
            </div>
          </div>
          <div className={s.fleetStat} style={{ '--fc': 'var(--s-idle)' } as CSSProperties}>
            <span className={s.fleetPip} /><span className={s.fleetNum}>{fleet.idle}</span>
            <div className={s.fleetMeta}><span className={s.fleetLabel}>대기</span></div>
          </div>
          <div className={s.fleetLive}>
            {live ? <><span className={s.livePulse} />LIVE</> : <span style={{ color: 'var(--s-stuck)' }}>◌ 오프라인</span>}
          </div>
        </div>

        {/* 인박스 패널 — 예외함/승인함/충돌 경고 3분류. 헤더 🔔로 토글, 대화 모드에선 숨김(.chatMode에서 처리). */}
        {inboxOpen && (
          <div className={s.inboxPanel}>
            <details className={s.inboxSection} open>
              <summary className={s.inboxSectionHead}>
                ⚠ 예외함 <span className={s.inboxCount}>{exceptionItems.length}</span>
              </summary>
              {exceptionItems.length === 0
                ? <div className={s.inboxEmpty}>예외 없음</div>
                : exceptionItems.map((it) => (
                  <button
                    key={it.id} className={s.inboxItem}
                    onClick={() => { if (it.projectId) { setSel(it.projectId); setSelAgent(null); } setInboxOpen(false); }}
                  >
                    <span className={s.inboxItemLabel}>{it.label}</span>
                    <span className={s.inboxItemDetail}>{it.detail}</span>
                    <span className={s.inboxItemTime}>{relTime(it.time, now)}</span>
                  </button>
                ))}
            </details>
            <details className={s.inboxSection} open>
              <summary className={s.inboxSectionHead}>
                ✋ 승인함 <span className={s.inboxCount}>{approvalItems.length}</span>
              </summary>
              {approvalItems.length === 0
                ? <div className={s.inboxEmpty}>승인 대기 없음</div>
                : approvalItems.map((it) => (
                  <button
                    key={it.id} className={s.inboxItem}
                    onClick={() => { if (it.projectId) { setSel(it.projectId); setSelAgent(null); } setInboxOpen(false); }}
                  >
                    <span className={s.inboxItemLabel}>{it.label}</span>
                    <span className={s.inboxItemDetail}>{it.detail}</span>
                    <span className={s.inboxItemTime}>{relTime(it.time, now)}</span>
                  </button>
                ))}
            </details>
            <details className={s.inboxSection} open>
              <summary className={s.inboxSectionHead}>
                ⑂ 충돌 경고 <span className={s.inboxCount}>{conflictItems.length}</span>
              </summary>
              {conflictItems.length === 0
                ? <div className={s.inboxEmpty}>충돌 없음</div>
                : conflictItems.map((it) => (
                  <button
                    key={it.id} className={s.inboxItem}
                    onClick={() => { if (it.projectId) { setSel(it.projectId); setSelAgent(null); } setInboxOpen(false); }}
                  >
                    <span className={s.inboxItemLabel}>{it.label}</span>
                    <span className={s.inboxItemDetail}>{it.detail}</span>
                    <span className={s.inboxItemTime}>{relTime(it.time, now)}</span>
                  </button>
                ))}
            </details>
          </div>
        )}

        {!live && (
          <div className={s.banner}>
            <span className={s.bannerItem}>
              ⚠ Supabase 미설정 — 콕핏은 라이브 전용이라 데모 데이터가 없습니다. 데모는 <Link href="/console">/console</Link>에서, 실제 동작은 `.env.local`에 Supabase 값을 채운 뒤 확인하세요.
            </span>
          </div>
        )}

        {/* PO 지시(2026-07-13): 상단 배너에 개별 오류/감사지적/사용량 항목을 나열하던 걸 제거 —
            해당 워커의 카드 자체에 이미 같은 정보가 표시돼 두 군데 중복이었다. '이상' 개수도
            .fleet 스트립과 아래 필터 배지 두 군데였던 걸 필터 배지 하나로 통일(fleet.alert 제거). */}

        {/* 빠른 필터 + 검색 — 문제만 보기·작업중만 보기·이름 검색 */}
        <div className={s.controls}>
          <div className={s.filters}>
            <button className={filter === 'all' ? `${s.fbtn} ${s.fbtnActive}` : s.fbtn} onClick={() => setFilter('all')}>
              전체 <span className={s.fbtnCount}>{PROJECTS.length}</span>
            </button>
            <button className={filter === 'working' ? `${s.fbtn} ${s.fbtnActive}` : s.fbtn} onClick={() => setFilter('working')}>
              ▶ 작업중 <span className={s.fbtnCount}>{fleet.working}</span>
            </button>
            <button className={filter === 'alert' ? `${s.fbtn} ${s.fbtnActive}` : s.fbtn} onClick={() => setFilter('alert')}>
              ⚠ 이상 <span className={s.fbtnCount}>{new Set([...alerts.map((a) => a.label), ...auditAlerts.map((a) => a.label)]).size}</span>
            </button>
          </div>
          <div className={s.search}>
            <span className={s.searchIcon}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
              </svg>
            </span>
            <input className={s.searchInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="프로젝트 검색" />
          </div>
        </div>

        {/* 최초 프로젝트 로드 전 — 골격(skeleton) 카드로 레이아웃 점프 방지 */}
        {!projLoaded && (
          <div className={s.grid} aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div className={`${s.card} ${s.cardSkeleton}`} key={'sk-' + i}>
                <div className={s.skLine} style={{ width: '55%', height: 15 }} />
                <div className={s.skLine} style={{ width: '38%', marginTop: 14 }} />
                <div className={s.skLine} style={{ width: '30%', marginTop: 8 }} />
                <div className={s.skLine} style={{ width: '70%', height: 22, marginTop: 16 }} />
              </div>
            ))}
          </div>
        )}

        {projLoaded && (() => {
          // 카드 1장 렌더 — meta 고정 카드와 PC 그룹 안 카드가 동일 마크업을 공유하도록 함수로 추출.
          const renderCard = (p: Proj) => {
            const w = byName(p.worker);
            // 소대장 모드 — interactive는 leader_seen_at이 신선할 때만(세션 비정상 종료 방어).
            //   훅 미설치 PC·platoons 미적용 DB면 pl이 없어 배지 자체가 안 뜬다(무영향).
            const pl = w ? platoons.find((x) => x.leader_worker_id === w.id) : null;
            const seenFresh = pl?.leader_seen_at ? (now - new Date(pl.leader_seen_at).getTime()) / 1000 < LEADER_SEEN_STALE_SEC : false;
            const leaderMode = pl ? (pl.leader_mode === 'interactive' && seenFresh ? 'interactive' : 'daemon') : null;
            const aud = p.auditor ? byName(p.auditor) : null;
            const wst = w ? deriveStatus(w, now) : null;
            const wmeta = wst ? STATUS_META[wst] : null;
            const audSt = aud ? deriveStatus(aud, now) : null;
            const wtasks = tasks.filter((t) => t.assigned_agent === p.worker);
            const queued = wtasks.filter((t) => t.status === 'queued').length;
            const running = wtasks.filter((t) => t.status === 'in_progress').length;
            const last = wtasks[0];
            const lastAudit = p.auditor ? tasks.find((t) => t.assigned_agent === p.auditor) : undefined;
            const verdict = classifyAudit(lastAudit?.result || lastAudit?.command_text);
            const auditDiff = extractAuditDiff(lastAudit?.command_text);
            const diffIsOpen = diffOpen.has(p.id);
            const gauge = usageGauge(w, now);
            return (
              <div
                key={p.id}
                className={sel === p.id ? `${s.card} ${s.cardSel}` : s.card}
                style={{ '--accent': wmeta?.color || 'var(--line)' } as CSSProperties}
                onClick={() => { setSel(p.id); setSelAgent(null); setTimeout(() => inputRef.current?.focus(), 50); }}
              >
                <div className={s.cardHead}>
                  <span className={s.label}>{p.label}</span>
                  <span className={s.dot} style={{ background: wmeta?.color || NEUTRAL_DOT }} />
                </div>
                <div className={s.worker}>
                  <span className={s.wname}>{p.worker}</span>
                  {leaderMode && (
                    <span
                      title={leaderMode === 'interactive' ? '대화형 Claude Code 세션이 소대장으로 지휘 중' : '워커 데몬이 소대장'}
                      style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 8, marginLeft: 6, whiteSpace: 'nowrap',
                        color: leaderMode === 'interactive' ? '#7CC7FF' : 'var(--text-faint)',
                        border: `1px solid ${leaderMode === 'interactive' ? '#7CC7FF55' : 'var(--line)'}`,
                      }}
                    >
                      {leaderMode === 'interactive' ? '🎧 세션 지휘' : '⚙ 데몬'}
                    </span>
                  )}
                  <span className={s.wstate} style={{ color: wmeta?.color || 'var(--text-faint)' }}>
                    {wmeta?.label || '—'}
                  </span>
                </div>
                <div className={s.sub}>
                  {p.auditor ? (
                    <>감사관 <b style={{ color: audSt ? STATUS_META[audSt].color : 'var(--text-faint)' }}>
                      {audSt ? STATUS_META[audSt].label : '—'}</b></>
                  ) : <span style={{ color: 'var(--text-faint)' }}>감사관 없음</span>}
                </div>
                {p.team && p.team.length > 0 && (
                  <div className={s.chips} style={{ marginTop: 4, marginBottom: 2 }}>
                    {p.team.map((m) => {
                      const ta = byName(m.name);
                      const tst = ta ? deriveStatus(ta, now) : null;
                      const c = tst ? STATUS_META[tst].color : NEUTRAL_DOT;
                      const activeChip = sel === p.id && selAgent === m.name;
                      return (
                        <span
                          className={s.chip}
                          key={m.name}
                          style={{ borderColor: c, cursor: 'pointer', background: activeChip ? c + '33' : c + '16', outline: activeChip ? `1px solid ${c}` : undefined }}
                          title={`${m.name} — 탭하면 이 역할에게 지시`}
                          onClick={(e) => { e.stopPropagation(); setSel(p.id); setSelAgent(m.name); setTimeout(() => inputRef.current?.focus(), 50); }}
                        >
                          <span className={s.pip} style={{ background: c }} />{m.role}{m.model === 'opus' ? ' ⬥' : ''}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className={s.metrics}>
                  <span className={s.metric}>대기 <b>{queued}</b></span>
                  <span className={s.metric}>진행 <b>{running}</b></span>
                  <span className={s.metric}>♥ {w ? w.beats.toLocaleString() : 0}</span>
                </div>
                {gauge && (
                  <div className={s.usage} style={{ color: gauge.color, borderColor: gauge.color + '55' }}>
                    {gauge.text}
                  </div>
                )}
                <div className={s.ekg} data-state={wst || 'offline'}>
                  <svg viewBox="0 0 240 26" preserveAspectRatio="none">
                    <path className={s.trace} d={wst && wst !== 'offline' && wst !== 'error' ? EKG_TRACE : EKG_FLAT}
                      stroke={wmeta?.color || NEUTRAL_DOT} />
                  </svg>
                </div>
                {verdict && (
                  <div className={`${s.audit} ${verdict.warn ? s.auditWarn : verdict.label === '정상' ? s.auditOk : s.auditNeutral}`}>
                    🛡 감사 {verdict.warn ? '⚠ ' : ''}{verdict.label}
                  </div>
                )}
                {auditDiff && (
                  <>
                    <button
                      className={s.diffToggle}
                      onClick={(e) => {
                        e.stopPropagation(); // 카드 클릭(프로젝트 선택)과 분리
                        setDiffOpen((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                          return next;
                        });
                      }}
                    >
                      diff 보기 {diffIsOpen ? '▴' : '▾'}
                    </button>
                    {diffIsOpen && (
                      <div className={s.diffPanel} onClick={(e) => e.stopPropagation()}>
                        <div className={s.diffMeta}>
                          {auditDiff.commit && <>커밋 {auditDiff.commit}</>}
                          {auditDiff.truncated && <span className={s.diffTruncated}> · 일부</span>}
                          <span> · +{auditDiff.added}/-{auditDiff.removed}줄</span>
                        </div>
                        <div className={s.diffBody}>
                          {auditDiff.diff.split('\n').map((line, i) => {
                            const cls = line.startsWith('+') ? s.diffAdd
                              : line.startsWith('-') ? s.diffDel
                              : line.startsWith('@@') ? s.diffHunk
                              : s.diffCtx;
                            return <div key={i} className={cls}>{line || ' '}</div>;
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
                {last && (
                  <div className={s.last} style={{ borderLeftColor: TASK_COLORS[last.status] || 'var(--line)' }}>
                    <div className={s.lastHead}>
                      <span className={s.lt} style={{ color: TASK_COLORS[last.status] }}>{TASK_LABELS[last.status] || last.status}</span>
                      <span className={s.lastTime}>{relTime(last.updated_at, now)}</span>
                    </div>
                    {last.result || last.command_text}
                  </div>
                )}
              </div>
            );
          };

          return (
            <>
              {/* meta 카드(PCSS 본체·비서관)는 PC 그룹핑 밖 최상단 고정 */}
              {metaProjects.length > 0 && (
                <div className={s.grid} style={{ marginBottom: hostGroups.length > 0 ? 18 : 0 }}>
                  {metaProjects.map(renderCard)}
                </div>
              )}

              {/* PC(host)별 소대 그룹 — 접기/펼치기 가능, 그룹 헤더에 host 상태·소속 소대 수 표시 */}
              {hostGroups.map(({ key, host, projects }) => {
                const isUnassigned = key === UNASSIGNED_HOST_KEY;
                const hbFresh = host?.last_heartbeat_at
                  ? (now - new Date(host.last_heartbeat_at).getTime()) / 1000 < HEARTBEAT_TIMEOUT_SEC
                  : false;
                const hostOnline = !isUnassigned && hbFresh && host?.status !== 'offline';
                const collapsed = collapsedHosts.has(key);
                return (
                  <details
                    key={key}
                    className={s.hostGroup}
                    open={!collapsed}
                    onToggle={(e) => {
                      const open = (e.target as HTMLDetailsElement).open;
                      if (open === collapsed) toggleHostGroup(key); // 실제 변화가 있을 때만 상태 갱신
                    }}
                  >
                    <summary className={s.hostGroupHead}>
                      <span className={s.hostGroupTitle}>
                        {!isUnassigned && (
                          <span
                            className={s.hostDot}
                            style={{ background: hostOnline ? 'var(--s-working)' : 'var(--s-offline)' }}
                          />
                        )}
                        {isUnassigned ? '미지정 PC' : host!.label}
                      </span>
                      {!isUnassigned && (
                        <span className={s.hostGroupState} style={{ color: hostOnline ? 'var(--s-working)' : 'var(--s-offline)' }}>
                          {hostOnline ? 'ONLINE' : 'OFFLINE'}
                        </span>
                      )}
                      <span className={s.hostGroupCount}>소대 {projects.length}개</span>
                    </summary>
                    <div className={s.grid}>
                      {projects.map(renderCard)}
                    </div>
                  </details>
                );
              })}
            </>
          );
        })()}

        {projLoaded && visibleProjects.length === 0 && (
          <div className={s.empty}>
            {query ? `"${query}" 검색 결과 없음` : filter === 'working' ? '지금 작업 중인 프로젝트가 없습니다' : filter === 'alert' ? '✓ 이상 없음 — 전 에이전트 정상' : '표시할 프로젝트가 없습니다'}
          </div>
        )}

        {unmapped.length > 0 && (
          <div className={s.section}>
            <div className={s.sectionTitle}>미분류 legacy 워커 · {unmapped.length} <span className={s.sectionHint}>(projects.json 미등록 — 숨지 않음)</span></div>
            <div className={s.chips}>
              {unmapped.map((a) => {
                const st = deriveStatus(a, now);
                return (
                  <span className={s.chip} key={a.id} style={{ borderColor: STATUS_META[st].color + '55' }}>
                    <span className={s.pip} style={{ background: STATUS_META[st].color }} />{a.name} · {STATUS_META[st].label}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {selProj ? (
          // 텔레그램식 대화 — 명령=보낸 말풍선, 결과=받은 말풍선
          <div className={s.chat}>
            <div className={s.chatHead}>
              <button className={s.backBtn} onClick={() => { setSel(null); setSelAgent(null); }} aria-label="전체 프로젝트로 돌아가기">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className={s.chatTitle}>
                <span className={s.chatProj}>{selProj.label}</span>
                <span className={s.chatTarget}>
                  {(() => {
                    const ta = byName(activeAgent!);
                    const tst = ta ? deriveStatus(ta, now) : null;
                    const c = tst ? STATUS_META[tst].color : NEUTRAL_DOT;
                    return <>
                      <span className={s.pip} style={{ background: c }} />
                      {activeAgent} · <span style={{ color: c }}>{tst ? STATUS_META[tst].label : '—'}</span>
                    </>;
                  })()}
                </span>
              </div>
              {/* 급정지/재가동/종료 — 명령 입력(컴포저)과는 다른 성격의 '제어' 기능이라 채팅 헤더로 분리.
                  (예전엔 컴포저 ⚡에 있었으나, 컴포저는 입력창 폭 확보가 우선이라 이전함.) */}
              <div className={s.chatHeadRight}>
                <button
                  className={actionsOpen ? `${s.actionsToggle} ${s.actionsToggleOn}` : s.actionsToggle}
                  onClick={() => setActionsOpen((v) => !v)}
                  aria-label="제어 명령 (급정지·재가동·종료)"
                  aria-expanded={actionsOpen}
                  title="제어 명령"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                    <path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
                  </svg>
                </button>
                {actionsOpen && (
                  <>
                    <div className={s.sheetScrim} onClick={() => setActionsOpen(false)} aria-hidden="true" />
                    <div className={s.actionSheet} role="menu">
                      <div className={s.sheetTitle}>{activeAgent} 제어</div>
                      <button className={`${s.sheetBtn} ${s.danger}`} disabled={sending}
                        onClick={() => { post(activeAgent!, { control: 'stop' }, `${activeAgent} 급정지`); setActionsOpen(false); }}>
                        <span className={s.sheetIco}>⏸</span> 급정지
                      </button>
                      <button className={s.sheetBtn} disabled={sending}
                        onClick={() => { post(activeAgent!, { control: 'run' }, `${activeAgent} 재가동`); setActionsOpen(false); }}>
                        <span className={s.sheetIco}>▶</span> 재가동
                      </button>
                      <button className={`${s.sheetBtn} ${s.danger}`} disabled={sending}
                        onClick={() => { post(activeAgent!, { control: 'terminate' }, `${activeAgent} 작업 종료`); setActionsOpen(false); }}>
                        <span className={s.sheetIco}>⏹</span> 종료
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            {cmdTargets.length > 1 && (
              <div className={s.chips} style={{ padding: '4px 2px 8px' }}>
                {cmdTargets.map((name) => {
                  const ta = byName(name);
                  const tst = ta ? deriveStatus(ta, now) : null;
                  const c = tst ? STATUS_META[tst].color : NEUTRAL_DOT;
                  const active = activeAgent === name;
                  const isWorker = name === selProj.worker;
                  return (
                    <span
                      className={s.chip}
                      key={name}
                      style={{ borderColor: c + '55', cursor: 'pointer', background: active ? c + '22' : undefined, outline: active ? `1px solid ${c}` : undefined }}
                      onClick={() => { setSelAgent(isWorker ? null : name); setTimeout(() => inputRef.current?.focus(), 50); }}
                    >
                      <span className={s.pip} style={{ background: c }} />{name}
                    </span>
                  );
                })}
              </div>
            )}
            <div className={s.thread}>
              {shownTasks.length === 0 && pending.length === 0 && <div className={s.taskEmpty}>대화가 없습니다. 아래에서 첫 명령을 보내세요.</div>}
              {(() => {
                // 태스크 + 낙관적 pending을 하나의 시간축으로 병합해 날짜칩·그룹핑이 둘에 걸쳐 정확히 동작하게 한다.
                //   pending은 created_at이 없으므로 id에 실린 타임스탬프(opt-<ms>-)를 시각으로 쓴다.
                type Row =
                  | { kind: 'task'; at: number; task: Task }
                  | { kind: 'pending'; at: number; p: { id: string; text: string; agent: string; failed?: boolean; attachments?: Attachment[] } };
                const rows: Row[] = [
                  ...shownTasks.map((t): Row => ({ kind: 'task', at: new Date(t.created_at).getTime() || 0, task: t })),
                  ...pending
                    .filter((p) => p.agent === activeAgent)
                    .map((p): Row => ({ kind: 'pending', at: Number(p.id.split('-')[1]) || Date.now(), p })),
                ].sort((a, b) => a.at - b.at);

                const out: ReactNode[] = [];
                let prevDay = '';
                rows.forEach((row, idx) => {
                  const iso = row.kind === 'task' ? row.task.created_at : new Date(row.at).toISOString();
                  const dk = dayKey(iso);
                  // 날짜가 바뀌면 중앙 날짜칩을 끼운다(첫 메시지 포함).
                  if (dk && dk !== prevDay) {
                    out.push(
                      <div className={s.dateChipRow} key={'d-' + dk + '-' + idx}>
                        <span className={s.dateChip}>{dateChip(iso, now)}</span>
                      </div>,
                    );
                    prevDay = dk;
                  }
                  // 그룹핑: 다음 행이 같은 방향(보낸 쪽=sent)일 때는 꼬리를 달지 않고 간격을 좁힌다.
                  //   sent만 존재하는 대화라 방향 판정은 단순(전부 보낸 말풍선 + 그에 딸린 받은/진행 말풍선).
                  const next = rows[idx + 1];
                  const groupedWithNext = !!next; // 다음 행이 있으면 뒤로 이어짐 → 마지막 아닌 sent는 꼬리 생략
                  const tailCls = groupedWithNext ? s.noTail : '';

                  if (row.kind === 'pending') {
                    const p = row.p;
                    out.push(
                      <div className={`${s.msg} ${idx > 0 ? s.msgGrouped : ''}`} key={p.id}>
                        <div className={`${s.sent} ${tailCls}`}>
                          {renderAtts(p.attachments)}
                          {p.text}
                          <span className={s.bubbleMeta}>
                            <span className={s.bTime}>{clockTime(new Date(row.at).toISOString())}</span>
                            {p.failed
                              ? <span className={s.bStat} title="전송 실패">{ICONS.failed}</span>
                              : <span className={s.bStat} title="전송중">{ICONS.sending}</span>}
                          </span>
                        </div>
                        {p.failed && <div className={s.sendFail}>전송 실패 · 다시 입력해 주세요</div>}
                      </div>,
                    );
                    return;
                  }

                  const t = row.task;
                  const canCancel = t.status === 'queued' || t.status === 'in_progress';
                  const canRetry = t.status === 'done' || t.status === 'failed';
                  // 감사 의견 인용 커맨드(워커에게 자동 주입되는 '[감사 대응]' 태스크) — PO 지시(2026-07-17):
                  //   감사의견은 파란 바탕. 감사관 본인 글(.recvAuditor)과 같은 파랑으로 통일한다.
                  const isAuditOpinion = t.command_text?.startsWith('[감사 대응]');
                  out.push(
                    <div className={`${s.msg} ${idx > 0 ? s.msgGrouped : ''}`} key={t.id}>
                      <div className={`${s.sent} ${isAuditOpinion ? s.sentAudit : ''} ${tailCls}`}>
                        {renderAtts(t.attachments)}
                        {t.command_text}
                        <span className={s.bubbleMeta}>
                          <span className={s.bTime}>{clockTime(t.created_at)}</span>
                          <span className={s.bStat} title={TASK_LABELS[t.status] || t.status} style={{ color: TASK_COLORS[t.status] }}>
                            {t.status === 'in_progress'
                              ? <span className={s.bubbleTyping}><i /><i /><i /></span>
                              : statusIcon(t.status)}
                          </span>
                        </span>
                      </div>
                      {t.status === 'in_progress' && t.progress && (
                        <div className={s.progress}>
                          <span className={s.progressCursor}>●</span> 진행 중… {t.progress.slice(-500)}
                        </div>
                      )}
                      {t.result && (
                        <div className={`${s.recv} ${t.assigned_agent?.endsWith('감사관') ? s.recvAuditor : ''}`}>
                          {t.result}
                          <span className={s.bubbleMeta}>
                            <span className={s.bTime}>{clockTime(t.updated_at)}</span>
                          </span>
                        </div>
                      )}
                      {(canCancel || canRetry) && (
                        <div className={s.msgActs}>
                          {canCancel && <button className={s.msgAct} disabled={sending} onClick={() => taskAction('cancel', t)}>{t.status === 'in_progress' ? '중단' : '취소'}</button>}
                          {canRetry && <button className={s.msgAct} disabled={sending} onClick={() => taskAction('retry', t)}>재시도</button>}
                        </div>
                      )}
                    </div>,
                  );
                });
                return out;
              })()}
            </div>
          </div>
        ) : (
          <details className={s.section} open>
            <summary className={s.taskSummary}>
              <span>전체 태스크 <b>{shownTasks.length}</b> <span className={s.sectionHint}>(소대 탭하면 대화 모드)</span></span>
            </summary>
            <div className={s.taskList}>
              {shownTasks.length === 0 && <div className={s.taskEmpty}>— 태스크 없음 —</div>}
              {shownTasks.map((t) => (
                <div className={s.taskRow} key={t.id} style={{ borderLeftColor: TASK_COLORS[t.status] || NEUTRAL_DOT }}>
                  <div className={s.taskTop}>
                    <span className={s.taskAgent}>{t.assigned_agent ?? '미배정'}</span>
                    <span className={s.taskStatus} style={{ color: TASK_COLORS[t.status] }}>{TASK_LABELS[t.status] || t.status}</span>
                    <span className={s.taskTime}>{relTime(t.updated_at, now)}</span>
                    {/* 감사관 태스크는 읽기전용 — 취소/재시도 없음(감사는 자동 전용) */}
                    {!t.assigned_agent?.endsWith('감사관') && (t.status === 'queued' || t.status === 'in_progress') && (
                      <button className={s.taskBtn} disabled={sending} onClick={() => taskAction('cancel', t)}>{t.status === 'in_progress' ? '중단' : '취소'}</button>
                    )}
                    {!t.assigned_agent?.endsWith('감사관') && (t.status === 'done' || t.status === 'failed') && (
                      <button className={s.taskBtn} disabled={sending} onClick={() => taskAction('retry', t)}>재시도</button>
                    )}
                  </div>
                  <div className={`${s.taskCmd} ${t.command_text?.startsWith('[감사 대응]') ? s.taskCmdAudit : ''}`}>{t.command_text}</div>
                  {t.result && <div className={`${s.taskResult} ${t.assigned_agent?.endsWith('감사관') ? s.taskResultAuditor : ''}`}>{t.result}</div>}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* 텔레그램식 하단 입력 컴포저 */}
      <div className={s.dock} ref={dockRef}>
        <div className={s.dockInner}>
          {selProj ? (
            <>
              {/* 급정지/재가동/종료 제어 액션시트는 채팅 헤더(chatHeadRight)로 이전됨 — 여기 있던 중복 블록 제거. */}
              {/* 선택했지만 아직 안 보낸 첨부 — 컴포저 위 칩(썸네일/파일명·크기 + X 제거) */}
              {files.length > 0 && (
                <div className={s.pickRow}>
                  {files.map((f, i) => {
                    const isImg = f.type.startsWith('image/');
                    return (
                      <span className={s.pickChip} key={f.name + i}>
                        {isImg
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img className={s.pickThumb} src={URL.createObjectURL(f)} alt={f.name} />
                          : <span className={s.pickIco}>📄</span>}
                        <span className={s.pickInfo}>
                          <span className={s.pickName}>{f.name}</span>
                          <span className={s.pickSize}>{fmtSize(f.size)}</span>
                        </span>
                        <button className={s.pickX} onClick={() => removeFile(i)} aria-label={`${f.name} 제거`} title="제거">×</button>
                      </span>
                    );
                  })}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => addFiles(e.target.files)}
              />
              <div className={s.composer}>
                <div className={s.composerBar}>
                  <textarea
                    ref={inputRef}
                    className={s.composerInput}
                    value={text}
                    rows={1}
                    enterKeyHint="send"
                    placeholder={`${activeAgent} 소대장에게 메시지`}
                    onChange={(e) => {
                      setText(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
                    }}
                    onKeyDown={(e) => {
                      // Enter = 전송, Shift+Enter = 줄바꿈. 한글 조합중(IME)엔 무시.
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        sendCommand();
                      }
                    }}
                  />
                  <button
                    className={s.clipBtn}
                    onClick={() => fileRef.current?.click()}
                    disabled={files.length >= 5}
                    aria-label="파일 첨부"
                    title={files.length >= 5 ? '첨부는 최대 5개' : '파일 첨부'}
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                </div>
                <button
                  className={s.composerSend}
                  disabled={sending || uploading || (!text.trim() && files.length === 0)}
                  onClick={sendCommand}
                  aria-label={uploading ? '업로드 중' : '전송'}
                >
                  {uploading
                    ? <span className={s.sendSpin} aria-hidden="true" />
                    : <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 20.5v-6l8-2-8-2v-6l19 8z" /></svg>}
                </button>
              </div>
            </>
          ) : (
            <div className={s.hint}>위에서 소대를 탭하면 여기서 소대장에게 직접 명령할 수 있어요</div>
          )}
        </div>
      </div>

      {toast && <div className={toast.err ? `${s.toast} ${s.err}` : s.toast}>{toast.msg}</div>}
    </div>
  );
}
