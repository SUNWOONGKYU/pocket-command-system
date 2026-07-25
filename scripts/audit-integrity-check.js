// 감사 원본(vault) 무결성 검증기 + 결정론적 기록기.
//   검증만: node scripts/audit-integrity-check.js            (인자 없음 — SessionStart 등에서 호출)
//   기록:   node scripts/audit-integrity-check.js --record   (감사관이 append 직후 1회 호출)
//   대상 지정: --repo <저장소경로> (그 저장소의 감사관 전용 vault) 또는 --vault <vault경로> 직접 지정.
//   인자가 없으면 이 스크립트가 속한 저장소(pocket-commander)를 대상으로 한다.
//
// ★설계 원칙(PO 결정 2026-07-25, B안): 해시 계산을 감사관 LLM에서 완전히 떼어낸다.
//   LLM(감사관)은 원본을 vault에 append하고 사본을 작업자 폴더에 append하는 것까지만 하고,
//   그 뒤 이 스크립트를 --record로 1회 트리거하기만 한다. 파일 바이트를 읽고 SHA-256을 계산하고
//   로그에 무엇을 쓸지는 전부 이 스크립트(결정론적 코드)가 정한다 — "여우(LLM)가 자물쇠(해시)를
//   만들지 못하게" 하는 것이 핵심. 감사관이 값을 잘못 계산하거나 지어낼 여지 자체를 제거한다.
//
// 설계(프리픽스 체인): integrity.log 각 줄은 "그 시점까지의 vault 원본 파일 내용"을 증언한다.
//   형식: <ISO8601 시각>|<byteLen>|<prefixSHA256>|<chainSHA256>
//     - byteLen        : 기록 시점 vault 원본 파일의 전체 바이트 길이.
//     - prefixSHA256   : 그 시점 파일의 처음 byteLen바이트(=파일 전체) 내용의 SHA-256.
//     - chainSHA256    : sha256(직전 줄 원문 전체 문자열 + '\n' + 이번 줄의 앞 3필드 "시각|byteLen|prefixSHA256").
//       첫 줄은 "직전 줄"을 빈 문자열("")로 취급한다.
//   과거 줄이 하나라도 바뀌면(값 변경·순서 변경·줄 삭제) 그 지점부터 체인이 깨져 탐지된다.
//   기록이 "그 시점까지의 프리픽스"를 증언하므로, 나중에 새 내용이 append 되어도 과거 기록분(현재 파일의
//   앞부분)이 그대로 보존돼 있는지를 항상 재검증할 수 있다(뒤에 더 붙는 것은 정상 append로 허용, 과거
//   구간의 내용이 달라지는 것만 위변조로 탐지).
//
// 판정 3분기 (양성 vs 진짜 알람을 구분 — 둘 다 stdout, 사람이 SessionStart 주입 메시지로 볼 수 있게):
//   1. vault 원본 파일 자체가 없음 → exit 0. 검증할 대상이 아직 없는 정상 상태(첫 감사 전).
//   2. vault 원본은 있는데 integrity.log가 없거나 비어있음:
//      - 검증 모드: exit 0 + 안내. 원본 append 직후·아직 --record 전인 과도기일 수 있어 알람 아님.
//      - 기록 모드(--record): 첫 줄을 새로 만들어 기록하고 exit 0.
//   3. integrity.log가 존재 — 여기서부터 진짜 검증:
//      ① 체인 재계산 대조(끊긴 최초 지점 보고).
//      ② 체인이 온전하면, 마지막 줄의 byteLen만큼 현재 원본 파일의 "앞부분"을 잘라 SHA-256 재계산 →
//         마지막 prefixSHA256과 대조. 다르면 "기록된 과거 구간 자체가 사후 변조"된 것 → exit 1.
//      둘 다 통과해야 exit 0(검증 모드는 여기서 끝). 하나라도 실패하면 exit 1 — stdout에 사유 출력.
//   --record 모드는 위 검증을 먼저 통과해야 하고(기존 기록이 이미 변조돼 있으면 기록 자체를 거부, exit 1),
//   통과 시 현재 파일의 byteLen이 마지막 기록보다 "더 커졌을 때"(=새 내용이 실제로 append됨)만 새 줄을
//   추가한다. 커지지 않았으면(중복 호출 등) 그냥 "변경 없음" 안내 후 exit 0 — 같은 스냅샷을 중복 기록하지 않는다.
//
// ★잔여 리스크(범위 밖, 명시적으로 수용):
//   - "로그 전면 재생성 공격": 공격자가 vault 원본과 integrity.log를 "동시에" 통째로 새로 만들어
//     처음부터 끝까지 서로 앞뒤가 맞게 재작성하면, 이 스크립트만으로는 원리적으로 탐지 불가능하다
//     (레포 내부에 있는 것과 대조할 뿐, git 커밋 서명·외부 타임스탬프 등 레포 "바깥"의 앵커가 없어서다).
//     이 문제를 근본적으로 막으려면 외부 앵커(별도 서버에 해시 전송, 블록체인 타임스탬프 등)가 필요하며
//     현재는 그 비용을 지지 않기로 한 결정(파일 기반 vault, PO 결정 2026-07-25)의 자연스러운 한계다.
//   - "최초 신뢰 창(trust window)": 감사관이 원본을 append한 시점부터 최초 --record가 실행되기 전까지는
//     로그가 아직 없어 검증 불가 상태다(위 판정 2번). 이 찰나의 원본 내용은 "감사관이 그렇게 썼다"는
//     사실 자체를 신뢰 가정으로 둔다 — 그 신뢰가 깨졌는지는 이후 --record가 찍히는 순간부터 추적된다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ★감사관 전용 폴더 분리(PO 지시 2026-07-25): vault(원본)는 작업자 저장소 안이 아니라 저장소 "밖"에 둔다.
//   경로 규칙: <repo의 부모>/_audit_vault/<repo 이름>/   예) C:/Dev/pocket-commander → C:/Dev/_audit_vault/pocket-commander
//   저장소 밖이라 gitignore와 무관하게 커밋 대상이 아니고, 작업자가 자기 저장소만 다뤄서는 원본에 닿지 않는다.
//   (사본 감사이력.md·대응이력.md는 종전대로 <repo>/_audit/ 에 남는다 — 작업자가 읽고 대응하는 곳.)
// 대상 저장소는 --repo <경로>, vault를 직접 지정하려면 --vault <경로>. 둘 다 없으면 이 스크립트가 속한 저장소.
function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
function vaultDirFor(repoRoot) {
  const abs = path.resolve(repoRoot);
  return path.join(path.dirname(abs), '_audit_vault', path.basename(abs));
}
const REPO_ROOT = path.resolve(argOf('--repo') || path.join(__dirname, '..'));
const VAULT_DIR = path.resolve(argOf('--vault') || vaultDirFor(REPO_ROOT));
const INTEGRITY_LOG = path.join(VAULT_DIR, 'integrity.log');
const VAULT_FILE = path.join(VAULT_DIR, '감사이력_원본.md');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function loadLogLines() {
  if (!fs.existsSync(INTEGRITY_LOG)) return [];
  return fs.readFileSync(INTEGRITY_LOG, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

// 형식: ts|byteLen|prefixHash|chainHash (정확히 4필드)
function parseLine(line) {
  const parts = line.split('|');
  if (parts.length !== 4) return null;
  const [ts, byteLenStr, prefixHash, chainHash] = parts;
  const byteLen = Number(byteLenStr);
  if (!ts || !Number.isInteger(byteLen) || byteLen < 0) return null;
  if (!/^[0-9a-f]{64}$/i.test(prefixHash) || !/^[0-9a-f]{64}$/i.test(chainHash)) return null;
  return { ts, byteLen, prefixHash, chainHash, raw: line };
}

// 로그 전체를 처음부터 순회하며 체인을 검증한다.
// 반환: { ok: boolean, parsed: [...], problems: [string] } — ok=false면 problems에 첫 실패 사유가 담긴다.
function verifyChain(lines) {
  const problems = [];
  let prevRaw = '';
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const p = parseLine(line);
    if (!p) {
      problems.push(`integrity.log ${i + 1}번째 줄 형식 오류(파싱 불가, 4필드 아님): "${line}"`);
      return { ok: false, parsed, problems };
    }
    const expectedChain = sha256(prevRaw + '\n' + `${p.ts}|${p.byteLen}|${p.prefixHash}`);
    if (expectedChain !== p.chainHash) {
      problems.push(
        `무결성 불일치! integrity.log ${i + 1}번째 줄(${p.ts})부터 해시 체인이 끊겼다. ` +
        `기록된 체인해시=${p.chainHash}, 재계산 체인해시=${expectedChain}. → 이 줄 또는 이전 줄이 기록 이후 변조된 것으로 판단.`
      );
      return { ok: false, parsed, problems };
    }
    parsed.push(p);
    prevRaw = line;
  }
  return { ok: true, parsed, problems };
}

// 체인이 온전할 때, 마지막 기록의 프리픽스가 "현재 원본 파일의 같은 구간"과 여전히 일치하는지 확인.
function verifyPrefix(parsed, fileBuf) {
  if (parsed.length === 0) return { ok: true, problems: [] };
  const last = parsed[parsed.length - 1];
  if (fileBuf.length < last.byteLen) {
    return {
      ok: false,
      problems: [
        `무결성 불일치! integrity.log 마지막 기록(${last.ts})은 파일이 최소 ${last.byteLen}바이트였다고 증언하는데, ` +
        `현재 vault 파일은 ${fileBuf.length}바이트뿐이다 → 기록 이후 원본 내용이 삭제/축소(위변조)된 것으로 판단.`,
      ],
    };
  }
  const currentPrefix = sha256(fileBuf.subarray(0, last.byteLen));
  if (currentPrefix !== last.prefixHash) {
    return {
      ok: false,
      problems: [
        `무결성 불일치! integrity.log 마지막 기록(${last.ts})의 프리픽스해시는 ${last.prefixHash} 이지만, ` +
        `현재 vault 파일의 처음 ${last.byteLen}바이트를 다시 해시하면 ${currentPrefix} 이다. → 기록된 과거 구간 자체가 기록 이후 변조된 것으로 판단.`,
      ],
    };
  }
  return { ok: true, problems: [] };
}

function runVerify() {
  if (!fs.existsSync(VAULT_FILE)) {
    console.log('[integrity] vault 원본 파일 없음(아직 감사 미기록) — 스킵:', VAULT_FILE);
    process.exit(0);
  }

  const lines = loadLogLines();
  if (lines.length === 0) {
    console.log('[integrity] vault 파일은 있는데 integrity.log가 비어있거나 없음 — 아직 첫 기록(--record) 전(과도기)일 수 있음. 위변조 아님, 검증 보류.');
    process.exit(0);
  }

  const chain = verifyChain(lines);
  if (!chain.ok) {
    console.log('\n[integrity] 무결성 검증 실패:\n');
    chain.problems.forEach((p) => console.log(' - ' + p));
    process.exitCode = 1;
    return;
  }

  const fileBuf = fs.readFileSync(VAULT_FILE);
  const prefix = verifyPrefix(chain.parsed, fileBuf);
  if (!prefix.ok) {
    console.log('\n[integrity] 무결성 검증 실패:\n');
    prefix.problems.forEach((p) => console.log(' - ' + p));
    process.exitCode = 1;
    return;
  }

  console.log(`[integrity] 검증 통과 — 해시 체인 ${chain.parsed.length}건 전부 정합, 과거 기록 구간 위변조 흔적 없음.`);
}

function runRecord() {
  if (!fs.existsSync(VAULT_FILE)) {
    console.log('[integrity] vault 원본 파일이 없어 기록할 것이 없음 — 스킵:', VAULT_FILE);
    process.exit(0);
  }

  const lines = loadLogLines();
  const fileBuf = fs.readFileSync(VAULT_FILE);

  // 기존 기록이 있다면 먼저 검증 — 이미 깨진 로그 위에 새 줄을 얹지 않는다(위변조 은폐 방지).
  if (lines.length > 0) {
    const chain = verifyChain(lines);
    if (!chain.ok) {
      console.log('\n[integrity] 기록 거부 — 기존 로그가 이미 무결성 검증에 실패했다:\n');
      chain.problems.forEach((p) => console.log(' - ' + p));
      process.exitCode = 1;
      return;
    }
    const prefix = verifyPrefix(chain.parsed, fileBuf);
    if (!prefix.ok) {
      console.log('\n[integrity] 기록 거부 — 과거 기록 구간이 이미 위변조된 상태다:\n');
      prefix.problems.forEach((p) => console.log(' - ' + p));
      process.exitCode = 1;
      return;
    }
    const last = chain.parsed[chain.parsed.length - 1];
    if (fileBuf.length <= last.byteLen) {
      console.log(`[integrity] 변경 없음 — vault 파일(${fileBuf.length}바이트)이 마지막 기록(${last.byteLen}바이트) 이후 커지지 않음. 중복 기록 생략.`);
      return;
    }
  }

  const prevRaw = lines.length > 0 ? lines[lines.length - 1] : '';
  const ts = new Date().toISOString();
  const byteLen = fileBuf.length;
  const prefixHash = sha256(fileBuf); // 지금 시점엔 파일 전체 = 프리픽스(byteLen 전체)
  const chainHash = sha256(prevRaw + '\n' + `${ts}|${byteLen}|${prefixHash}`);
  const newLine = `${ts}|${byteLen}|${prefixHash}|${chainHash}`;

  fs.mkdirSync(VAULT_DIR, { recursive: true });
  fs.appendFileSync(INTEGRITY_LOG, newLine + '\n');
  console.log(`[integrity] 기록 완료 — ${ts} | ${byteLen}바이트 | prefix=${prefixHash.slice(0, 16)}... | chain=${chainHash.slice(0, 16)}...`);
}

function main() {
  // --repo/--vault 인자가 앞에 오면 argv[2]가 '--record'가 아니게 되므로 위치가 아니라 존재로 판정한다.
  // (에코 감사관 t-aa2e6d2d 감사 지적 — 위치 기반 판정이면 `--repo <경로> --record`가 검증 모드로 빠진다.)
  if (process.argv.includes('--record')) runRecord();
  else runVerify();
}

main();
