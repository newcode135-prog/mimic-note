// 미믹노트 공통: 팀원 명부와 미션 데이터베이스(data/missions.json).
// Node 18 이상, 외부 패키지 없음. 데이터는 git 으로 공유되므로 바꾼 뒤 commit·push 해야 다른 사람에게 보인다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function loadMembers(dir = NOTE_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'members.json'), 'utf8')).members;
}

// ---- 환경변수(.env)와 텔레그램 ----

// 저장소 루트의 .env(git 에 안 올라감) + 실제 환경변수. 환경변수가 우선.
export function readEnv(rootDir = path.resolve(NOTE_DIR, '..'), env = process.env) {
  const out = {};
  const file = path.join(rootDir, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return { ...out, ...env };
}

// ---- 대전제: 모든 체크인에서 가장 먼저 보여 주는 규칙 ----

export function loadPremise(dir = NOTE_DIR) {
  return fs.readFileSync(path.join(dir, 'premise.md'), 'utf8').trim();
}

// ---- 미션 데이터베이스 ----

export function dbPath(dir = NOTE_DIR) {
  return path.join(dir, 'data', 'missions.json');
}

export function loadDb(dir = NOTE_DIR) {
  const file = dbPath(dir);
  if (!fs.existsSync(file)) return { nextId: 1, missions: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 임시 파일에 쓴 뒤 바꿔치기해서, 쓰다가 끊겨도 파일이 깨지지 않게 한다.
export function saveDb(db, dir = NOTE_DIR) {
  const file = dbPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// 순수 로직(명부·미션 규칙·텔레그램 API·메시지)은 core.mjs — Node 없이 클라우드플레어 워커에서도 쓴다.
export * from './core.mjs';
