'use client';

// 포트폴리오 지휘 콕핏 — PCS의 오너 뷰. 18에이전트를 9프로젝트 카드로 묶어 한 화면에 보고,
// 카드를 탭해 대상을 고른 뒤 하단 독에서 바로 명령한다(텔레그램 없이). PCS를 완성하는 조각.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createBrowserClient } from '@/lib/supabase';
import { Agent, Task, deriveStatus, STATUS_META, USAGE_STALE_SEC } from '@/lib/types';
import s from './cockpit.module.css';

type TeamMember = { name: string; role: string; model?: string };
type Proj = { id: string; label: string; worker: string; auditor: string; git: string; team?: TeamMember[] };
// ★ 운영 실데이터(프로젝트 실명·워커 편제)를 클라이언트 번들에 안 박기 위해 정적 import 대신
//   /api/projects에서 서버(Node fs)로만 읽어 fetch한다 — config/projects.json 직접 import 금지.
//   공개 clone엔 projects.local.json 자체가 없어 서버가 예시(config/projects.json)로 자동 폴백한다.

const TASK_LABELS: Record<string, string> = { queued: '대기', in_progress: '진행', done: '완료', failed: '실패' };
const TASK_COLORS: Record<string, string> = { queued: '#4a8f6b', in_progress: '#00e5ff', done: '#00ff9c', failed: '#ff3b6b' };

// 관제 보드에서 통합한 하트비트(EKG) 파형 — 살아있으면 심전도, offline이면 평평
const EKG_TRACE = 'M0 13 L34 13 L40 13 L44 4 L49 22 L54 13 L72 13 L78 13 L82 9 L86 13 L120 13 L154 13 L160 13 L164 4 L169 22 L174 13 L192 13 L198 13 L202 9 L206 13 L240 13';
const EKG_FLAT = 'M0 13 L240 13';

// 감사관이 자동으로 낸 최근 판정을 텍스트에서 추출 (감사관 태스크의 결과/명령문 기준)
// ★ PCS 감사관의 top-line verdict는 '[정상]' 마커 — 이게 있으면 본문에 '권고/지적' 언급이 있어도 정상.
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
  const color = u.severity === 'critical' ? '#ff3b6b' : u.severity === 'warning' ? '#f5a524' : 'var(--text-dim)';
  const resetTime = u.five_hour?.resets_at
    ? new Date(u.five_hour.resets_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '—';
  return { text: `5h ${u.five_hour?.pct ?? 0}% · 리셋 ${resetTime} · 주 ${u.seven_day?.pct ?? 0}%`, color };
}

export default function Cockpit() {
  const [PROJECTS, setProjects] = useState<Proj[]>([]); // /api/projects에서 로드(정적 import 아님 — 번들 분리 목적)
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [now, setNow] = useState(Date.now());
  const [sel, setSel] = useState<string | null>(null); // 선택된 프로젝트 id
  const [selAgent, setSelAgent] = useState<string | null>(null); // 프로젝트 내 명령 대상(팀원 선택 시 override, null=워커)
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [pending, setPending] = useState<{ id: string; text: string; agent: string; failed?: boolean }[]>([]);
  const [diffOpen, setDiffOpen] = useState<Set<string>>(new Set()); // "diff 보기" 펼침 상태 — 카드(프로젝트 id)별 로컬
  const [live, setLive] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockH, setDockH] = useState(168); // 하단 독의 실제 높이 — 본문 여백으로 예약(최신 글이 독 뒤에 가리지 않게)

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

  // 프로젝트 매핑(운영 실데이터 or 공개본 예시) — 서버 API로만 로드, 클라이언트 번들엔 안 실림.
  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((j) => { if (j.ok && Array.isArray(j.projects)) setProjects(j.projects); })
      .catch(() => {}); // 실패해도 조용히 — 아래 목록 렌더가 빈 배열로 자연스럽게 처리
  }, []);

  useEffect(() => {
    const sb = createBrowserClient();
    if (!sb) { setLive(false); return; } // 콕핏은 라이브 전용 (데모 시드 없음) — 미설정 시 안내 배너로 알림
    const load = async () => {
      const [{ data: a }, { data: tk }] = await Promise.all([
        sb.from('agents').select('*'),
        sb.from('tasks').select('*').order('updated_at', { ascending: false }).limit(120),
      ]);
      if (a) setAgents(a as Agent[]);
      if (tk) setTasks(tk as Task[]);
    };
    load();
    const poll = setInterval(load, 15000);
    const ch = sb
      .channel('cockpit')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => load())
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
    if (!selProj || !activeAgent || !text.trim()) return;
    const body = text.trim();
    const worker = activeAgent;
    // 낙관적 표시: 보내는 즉시 내 말풍선을 대화에 띄우고 유지 (서버 반영 전까지 '전송중')
    const optId = 'opt-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    setPending((prev) => [...prev, { id: optId, text: body, agent: worker }]);
    setText('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    inputRef.current?.focus();
    // 전송 실패 시 낙관적 말풍선을 '전송 실패'로 마킹(무기한 '전송중' 잔존 방지). 성공 시 태스크 도착 dedup가 제거.
    const ok = await post(worker, { text: body }, `▶ ${worker}에게 전송`);
    if (!ok) setPending((prev) => prev.map((p) => (p.id === optId ? { ...p, failed: true } : p)));
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

  // 구독 사용량 경고 배너 — 80% 이상인 호스트(같은 계정 = 같은 사용량이라 host당 1번만)
  const usageAlerts = (() => {
    const seenHost = new Set<string>();
    const out: { host: string; pct: number; resetTime: string }[] = [];
    for (const a of agents) {
      const u = a.usage_state;
      if (!u?.fetched_at || !a.host) continue;
      const ageSec = (now - new Date(u.fetched_at).getTime()) / 1000;
      if (ageSec > USAGE_STALE_SEC) continue;
      const pct = u.five_hour?.pct ?? 0;
      if (pct < 80 || seenHost.has(a.host)) continue;
      seenHost.add(a.host);
      const resetTime = u.five_hour?.resets_at
        ? new Date(u.five_hour.resets_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        : '—';
      out.push({ host: a.host, pct, resetTime });
    }
    return out;
  })();

  return (
    <div className="console-shell">
      <header className="bar">
        <div className="wordmark">
          POCKET COMMAND <span className="accent">COCKPIT</span>
          <span className="sub">오너 지휘 콕핏 · 명령·취소·재시도 (결과 알림은 텔레그램)</span>
        </div>
        <nav className="nav">
          <Link href="/cockpit" className="active">콕핏</Link>
          <Link href="/console">콘솔</Link>
        </nav>
      </header>

      <div className={selProj ? `${s.cockpit} ${s.chatMode}` : s.cockpit} style={{ paddingBottom: dockH + 24 }}>
        <div className={s.head}>
          <span className={s.count}>내 프로젝트 {PROJECTS.length}개</span>
        </div>

        {!live && (
          <div className={s.banner}>
            <span className={s.bannerItem}>
              ⚠ Supabase 미설정 — 콕핏은 라이브 전용이라 데모 데이터가 없습니다. 데모는 <Link href="/console">/console</Link>에서, 실제 동작은 `.env.local`에 Supabase 값을 채운 뒤 확인하세요.
            </span>
          </div>
        )}

        {(alerts.length > 0 || auditAlerts.length > 0 || usageAlerts.length > 0) && (
          <div className={s.banner}>
            {alerts.map((a) => (
              <span className={s.bannerItem} key={'w-' + a.label}>
                <span className={s.pip} style={{ background: STATUS_META[a.st].color }} />
                {a.label} — {STATUS_META[a.st].label}
              </span>
            ))}
            {auditAlerts.map((a) => (
              <span className={`${s.bannerItem} ${s.auditPill}`} key={'a-' + a.label}>
                🛡 {a.label} — 감사 지적
              </span>
            ))}
            {usageAlerts.map((a) => (
              <span className={`${s.bannerItem} ${s.usagePill}`} key={'u-' + a.host}>
                ⚠ {a.host} 구독 사용량 {a.pct}% — {a.resetTime} 리셋
              </span>
            ))}
          </div>
        )}

        <div className={s.grid}>
          {PROJECTS.map((p) => {
            const w = byName(p.worker);
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
                onClick={() => { setSel(p.id); setSelAgent(null); setTimeout(() => inputRef.current?.focus(), 50); }}
              >
                <div className={s.cardHead}>
                  <span className={s.label}>{p.label}</span>
                  <span className={s.dot} style={{ background: wmeta?.color || '#3a3a3a', boxShadow: wmeta ? `0 0 8px ${wmeta.glow}` : 'none' }} />
                </div>
                <div className={s.worker}>
                  <span className={s.wname}>{p.worker}</span>
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
                      const c = tst ? STATUS_META[tst].color : '#3a3a3a';
                      const activeChip = sel === p.id && selAgent === m.name;
                      return (
                        <span
                          className={s.chip}
                          key={m.name}
                          style={{ borderColor: c + '55', cursor: 'pointer', background: activeChip ? c + '22' : undefined, outline: activeChip ? `1px solid ${c}` : undefined }}
                          title={`${m.name} · ${m.role} — 탭하면 이 역할에게 지시`}
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
                      stroke={wmeta?.color || '#3a3a3a'} style={{ filter: wmeta ? `drop-shadow(0 0 3px ${wmeta.glow})` : 'none' }} />
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
                  <div className={s.last}>
                    <span className={s.lt}>[{last.status}]</span> {last.result || last.command_text}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {unmapped.length > 0 && (
          <div className={s.section}>
            <div className={s.sectionTitle}>미분류 에이전트 · {unmapped.length} <span className={s.sectionHint}>(projects.json 미등록 — 숨지 않음)</span></div>
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
              <span>💬 <b>{selProj.label}</b> · {activeAgent}</span>
              <button className={s.linkBtn} onClick={() => { setSel(null); setSelAgent(null); }}>← 전체</button>
            </div>
            {cmdTargets.length > 1 && (
              <div className={s.chips} style={{ padding: '4px 2px 8px' }}>
                {cmdTargets.map((name) => {
                  const ta = byName(name);
                  const tst = ta ? deriveStatus(ta, now) : null;
                  const c = tst ? STATUS_META[tst].color : '#3a3a3a';
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
              {[...shownTasks].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()).map((t) => (
                <div className={s.msg} key={t.id}>
                  <div className={s.sent}>{t.command_text}</div>
                  {t.status === 'in_progress' && t.progress && (
                    <div className={s.progress}>
                      <span className={s.progressCursor}>●</span> 진행 중… {t.progress.slice(-500)}
                    </div>
                  )}
                  {t.result && <div className={s.recv}>{t.result}</div>}
                  <div className={s.msgMeta}>
                    <span style={{ color: TASK_COLORS[t.status] }}>{TASK_LABELS[t.status] || t.status}</span>
                    <span>· {new Date(t.updated_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
                    {(t.status === 'queued' || t.status === 'in_progress') && <button className={s.msgAct} disabled={sending} onClick={() => taskAction('cancel', t)}>{t.status === 'in_progress' ? '중단' : '취소'}</button>}
                    {(t.status === 'done' || t.status === 'failed') && <button className={s.msgAct} disabled={sending} onClick={() => taskAction('retry', t)}>재시도</button>}
                  </div>
                </div>
              ))}
              {pending.filter((p) => p.agent === activeAgent).map((p) => (
                <div className={s.msg} key={p.id}>
                  <div className={s.sent}>{p.text}</div>
                  <div className={s.msgMeta}>{p.failed
                    ? <span style={{ color: 'var(--danger, #ff3b6b)' }}>전송 실패 · 다시 입력해 주세요</span>
                    : <span style={{ color: 'var(--text-faint)' }}>전송중…</span>}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <details className={s.section} open>
            <summary className={s.taskSummary}>
              <span>전체 태스크 <b>{shownTasks.length}</b> <span className={s.sectionHint}>(프로젝트 탭하면 대화 모드)</span></span>
            </summary>
            <div className={s.taskList}>
              {shownTasks.length === 0 && <div className={s.taskEmpty}>— 태스크 없음 —</div>}
              {shownTasks.map((t) => (
                <div className={s.taskRow} key={t.id} style={{ borderLeftColor: TASK_COLORS[t.status] || '#4a8f6b' }}>
                  <div className={s.taskTop}>
                    <span className={s.taskAgent}>{t.assigned_agent ?? '미배정'}</span>
                    <span className={s.taskStatus} style={{ color: TASK_COLORS[t.status] }}>{TASK_LABELS[t.status] || t.status}</span>
                    {/* 감사관 태스크는 읽기전용 — 취소/재시도 없음(감사는 자동 전용) */}
                    {!t.assigned_agent?.endsWith('감사관') && (t.status === 'queued' || t.status === 'in_progress') && (
                      <button className={s.taskBtn} disabled={sending} onClick={() => taskAction('cancel', t)}>{t.status === 'in_progress' ? '중단' : '취소'}</button>
                    )}
                    {!t.assigned_agent?.endsWith('감사관') && (t.status === 'done' || t.status === 'failed') && (
                      <button className={s.taskBtn} disabled={sending} onClick={() => taskAction('retry', t)}>재시도</button>
                    )}
                  </div>
                  <div className={s.taskCmd}>{t.command_text}</div>
                  {t.result && <div className={s.taskResult}>{t.result}</div>}
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
              <div className={s.quick}>
                <button className={`${s.qbtn} ${s.danger}`} disabled={sending}
                  onClick={() => post(activeAgent!, { control: 'stop' }, `${activeAgent} 급정지`)}>급정지</button>
                <button className={s.qbtn} disabled={sending}
                  onClick={() => post(activeAgent!, { control: 'run' }, `${activeAgent} 재가동`)}>재가동</button>
                <button className={`${s.qbtn} ${s.danger}`} disabled={sending}
                  onClick={() => post(activeAgent!, { control: 'terminate' }, `${activeAgent} 작업 종료`)}>종료</button>
              </div>
              <div className={s.composer}>
                <textarea
                  ref={inputRef}
                  className={s.composerInput}
                  value={text}
                  rows={1}
                  enterKeyHint="send"
                  placeholder="메시지"
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
                <button className={s.composerSend} disabled={sending || !text.trim()} onClick={sendCommand} aria-label="전송">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3 20.5v-6l8-2-8-2v-6l19 8z" /></svg>
                </button>
              </div>
            </>
          ) : (
            <div className={s.hint}>위에서 프로젝트를 탭하면 여기서 대화하듯 명령할 수 있어요</div>
          )}
        </div>
      </div>

      {toast && <div className={toast.err ? `${s.toast} ${s.err}` : s.toast}>{toast.msg}</div>}
    </div>
  );
}
