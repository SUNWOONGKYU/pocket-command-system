// 콕핏 프로젝트 매핑 제공 API — config/projects.local.json(운영 실데이터, gitignore)이 있으면 그걸,
// 없으면 config/projects.json(공개본에 tracked된 일반화 예시)을 읽어 반환한다.
//   ★ 목적: 콕핏(app/cockpit/page.tsx)이 이 데이터를 정적 import 대신 이 API로 fetch해야,
//   운영 실데이터(프로젝트 실명·워커 편제·경로)가 클라이언트 번들(공개 JS)에 안 박힌다.
//   서버(Node fs)에서만 읽으므로 공개 clone에는 projects.local.json 자체가 없어 예시만 응답된다.

import { NextResponse } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const runtime = 'nodejs';
// 파일 존재 여부에 따라 응답이 달라지는 동적 엔드포인트 — 빌드 타임 프리렌더 방지(monitor 라우트와 동일 이유).
export const dynamic = 'force-dynamic';

export async function GET() {
  const dir = path.join(process.cwd(), 'config');
  const localPath = path.join(dir, 'projects.local.json');
  const examplePath = path.join(dir, 'projects.json');

  try {
    const raw = fs.existsSync(localPath)
      ? fs.readFileSync(localPath, 'utf8')
      : fs.readFileSync(examplePath, 'utf8');
    const json = JSON.parse(raw);
    return NextResponse.json({ ok: true, projects: json.projects ?? [] });
  } catch (e) {
    console.error('[api/projects] 로드 실패', e);
    return NextResponse.json({ ok: false, projects: [], error: '프로젝트 설정을 읽을 수 없습니다' }, { status: 500 });
  }
}
