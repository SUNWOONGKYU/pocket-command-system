'use client';

// 포트폴리오 지휘 콕핏 — PCS의 오너 뷰. 18에이전트를 9프로젝트 카드로 묶어 한 화면에 보고,
// 카드를 탭해 대상을 고른 뒤 하단 독에서 바로 명령한다(텔레그램 없이). PCS를 완성하는 조각.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createBrowserClient } from '@/lib/supabase';
import { Agent, Task, deriveStatus, STATUS_META } from '@/lib/types';
import cfg from '@/config/projects.json';
import s from './cockpit.module.css';

type Proj = { id: string; label: string; worker: string; auditor: string; git: string };
const PROJECTS: Proj[] = (cfg as { projects: Proj[] }).projects;

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

export default function Cockpit() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [now, setNow] = useState(Date.now());
  const [sel, setSel] = useState<string | null>(null); // 선택된 프로젝트 id
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [pending, setPending] = useState<{ id: string; text: string; agent: string; failed?: boolean }[]>([]);
  const [live, setLive] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
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

  async function sendCommand() {
    if (!selProj || !text.trim()) return;
    const body = text.trim();
    const worker = selProj.worker;
    // 낙관적 표시: 보내는 즉시 내 말풍선을 대화에 띄우고 유지 (서버 반영 전까지 '전송중')
    const optId = 'opt-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    setPending((prev) => [...prev, { id: optId, text: body, agent: worker }]);
    setText('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    inputRef.current?.focus();
    // 전송 실패 시 낙관적 말풍선을 '전송 실패'로 마킹(무기한 '전송중' 잔존 방지). 성공 시 태스크 도착 dedup가 제거.
    const ok = await post(worker, { text: body }, `▶ ${selProj.label}에게 전송`);
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
  const mappedNames = new Set(PROJECTS.flatMap((p) => [p.worker, p.auditor].filter(Boolean)));
  const unmapped = agents.filter((a) => !mappedNames.has(a.name));
  // 태스크 섹션: 프로젝트 선택 시 그 워커 것만(감사관 제외 — 채팅은 워커와만, 감사는 자동 전용),
  //   미선택 시 전체(콘솔 흡수)
  const shownTasks = selProj
    ? tasks.filter((t) => t.assigned_agent === selProj.worker)
    : tasks.slice(0, 30);

  // 대화 열기·전송·새 메시지 도착 시 맨 아래(최신)로 스크롤 — 방금 보낸 글이 항상 보이게
  const chatSig = `${sel}|${pending.length}|${shownTasks.length}`;
  useEffect(() => {
    if (!sel) return;
    const id = setTimeout(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' }), 70);
    return () => clearTimeout(id);
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

      <div className={selProj ? `${s.cockpit} ${s.chatMode}` : s.cockpit}>
        <div className={s.head}>
          <h2>내 프로젝트</h2>
          <span className="count">{PROJECTS.length}개 · 워커+감사관 · 카드 탭 → 명령·태스크</span>
        </div>

        {!live && (
          <div className={s.banner}>
            <span className={s.bannerItem}>
              ⚠ Supabase 미설정 — 콕핏은 라이브 전용이라 데모 데이터가 없습니다. 데모는 <Link href="/console">/console</Link>에서, 실제 동작은 `.env.local`에 Supabase 값을 채운 뒤 확인하세요.
            </span>
          </div>
        )}

        {(alerts.length > 0 || auditAlerts.length > 0) && (
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
            return (
              <div
                key={p.id}
                className={sel === p.id ? `${s.card} ${s.cardSel}` : s.card}
                onClick={() => { setSel(p.id); setTimeout(() => inputRef.current?.focus(), 50); }}
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
                <div className={s.metrics}>
                  <span className={s.metric}>대기 <b>{queued}</b></span>
                  <span className={s.metric}>진행 <b>{running}</b></span>
                  <span className={s.metric}>♥ {w ? w.beats.toLocaleString() : 0}</span>
                </div>
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
              <span>💬 <b>{selProj.label}</b> · {selProj.worker}</span>
              <button className={s.linkBtn} onClick={() => setSel(null)}>← 전체</button>
            </div>
            <div className={s.thread}>
              {shownTasks.length === 0 && pending.length === 0 && <div className={s.taskEmpty}>대화가 없습니다. 아래에서 첫 명령을 보내세요.</div>}
              {[...shownTasks].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()).map((t) => (
                <div className={s.msg} key={t.id}>
                  <div className={s.sent}>{t.command_text}</div>
                  {t.result && <div className={s.recv}>{t.result}</div>}
                  <div className={s.msgMeta}>
                    <span style={{ color: TASK_COLORS[t.status] }}>{TASK_LABELS[t.status] || t.status}</span>
                    <span>· {new Date(t.updated_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
                    {(t.status === 'queued' || t.status === 'in_progress') && <button className={s.msgAct} disabled={sending} onClick={() => taskAction('cancel', t)}>{t.status === 'in_progress' ? '중단' : '취소'}</button>}
                    {(t.status === 'done' || t.status === 'failed') && <button className={s.msgAct} disabled={sending} onClick={() => taskAction('retry', t)}>재시도</button>}
                  </div>
                </div>
              ))}
              {pending.filter((p) => p.agent === selProj.worker).map((p) => (
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
                  onClick={() => post(selProj.worker, { control: 'stop' }, `${selProj.label} 급정지`)}>급정지</button>
                <button className={s.qbtn} disabled={sending}
                  onClick={() => post(selProj.worker, { control: 'run' }, `${selProj.label} 재가동`)}>재가동</button>
                <button className={`${s.qbtn} ${s.danger}`} disabled={sending}
                  onClick={() => post(selProj.worker, { control: 'terminate' }, `${selProj.label} 작업 종료`)}>종료</button>
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
