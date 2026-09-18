'use strict';
// 로컬 CLI 자격증명 읽기 (Claude Code, Codex CLI, Gemini CLI). 토큰 값은 절대 로그에 남기지 않는다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function home() { return os.homedir(); }

/** Claude Code: ~/.claude/.credentials.json 또는 macOS Keychain "Claude Code-credentials" */
function claudeCode() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
  const fromFile = readJson(path.join(configDir, '.credentials.json'));
  if (fromFile && fromFile.claudeAiOauth) return fromFile.claudeAiOauth;
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const j = JSON.parse(out);
      if (j && j.claudeAiOauth) return j.claudeAiOauth;
    } catch { /* keychain 항목 없음 */ }
  }
  return null;
}

/** Codex CLI: ~/.codex/auth.json */
function codex() {
  const dir = process.env.CODEX_HOME || path.join(home(), '.codex');
  const j = readJson(path.join(dir, 'auth.json'));
  if (!j || !j.tokens || !j.tokens.access_token) return null;
  return j.tokens; // { id_token, access_token, refresh_token, account_id }
}

/** Gemini CLI: ~/.gemini/oauth_creds.json */
function geminiCli() {
  const dir = process.env.GEMINI_CLI_HOME || path.join(home(), '.gemini');
  const j = readJson(path.join(dir, 'oauth_creds.json'));
  if (!j || !j.access_token) return null;
  return j; // { access_token, refresh_token, expiry_date(ms), id_token, scope }
}

function geminiProjectHint() {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || null;
}

/** Gemini CLI 의 OAuth client id/secret: env → 설치된 gemini-cli 의 oauth2.js 에서 추출 → 공개 기본값 */
function geminiOauthClient() {
  if (process.env.GEMINI_OAUTH_CLIENT_ID && process.env.GEMINI_OAUTH_CLIENT_SECRET) {
    return { id: process.env.GEMINI_OAUTH_CLIENT_ID, secret: process.env.GEMINI_OAUTH_CLIENT_SECRET };
  }
  const candidates = [];
  if (process.env.GEMINI_OAUTH2_JS_PATH) candidates.push(process.env.GEMINI_OAUTH2_JS_PATH);
  try {
    const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32',
    }).trim();
    candidates.push(path.join(root, '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'));
    candidates.push(path.join(root, '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'));
  } catch { /* npm 없음 */ }
  for (const c of candidates) {
    try {
      const src = fs.readFileSync(c, 'utf8');
      const id = src.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
      const secret = src.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/);
      if (id && secret) return { id: id[1], secret: secret[1] };
    } catch { /* 다음 후보 */ }
  }
  // 소스에 값을 넣지 않는다. 설치된 gemini-cli 가 없으면 이 출처는 건너뛴다.
  return null;
}

// ---------------- Antigravity (agy CLI / Antigravity IDE) ----------------

/** Antigravity OAuth 클라이언트 값이 들어 있는 로컬 실행파일 후보 (agy CLI, Antigravity IDE 언어 서버) */
function antigravityBinaryCandidates() {
  const c = [];
  if (process.env.AGY_BINARY) c.push(process.env.AGY_BINARY);
  const local = process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
  if (process.platform === 'win32') {
    c.push(path.join(local, 'agy', 'bin', 'agy.exe'));
    c.push(path.join(local, 'Programs', 'Antigravity IDE', 'resources', 'app', 'extensions', 'antigravity', 'bin'));
    c.push(path.join(local, 'Programs', 'Antigravity', 'resources', 'app', 'extensions', 'antigravity', 'bin'));
  } else if (process.platform === 'darwin') {
    c.push(path.join(home(), '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy', path.join(home(), '.agy', 'bin', 'agy'));
    c.push('/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin');
    c.push(path.join(home(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'extensions', 'antigravity', 'bin'));
  } else {
    c.push(path.join(home(), '.local', 'bin', 'agy'), '/usr/local/bin/agy', path.join(home(), '.agy', 'bin', 'agy'));
    c.push('/usr/share/antigravity/resources/app/extensions/antigravity/bin', '/opt/antigravity/resources/app/extensions/antigravity/bin');
  }
  const files = [];
  for (const p of c) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) files.push(p);
      else if (st.isDirectory()) for (const f of fs.readdirSync(p)) if (/^language_server/i.test(f)) files.push(path.join(p, f));
    } catch { /* 없음 */ }
  }
  return files;
}

/** 큰 실행파일을 청크 단위로 읽으며 정규식 매치를 수집 (문자열 전체 로드 방지) */
function scanBinary(file, patterns) {
  const found = patterns.map(() => new Set());
  const fd = fs.openSync(file, 'r');
  try {
    const CHUNK = 8 * 1024 * 1024, OVERLAP = 256;
    const buf = Buffer.alloc(CHUNK + OVERLAP);
    let pos = 0, carry = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, carry, CHUNK, pos);
      if (n <= 0) break;
      const text = buf.toString('latin1', 0, carry + n);
      patterns.forEach((re, i) => { for (const m of text.match(re) || []) found[i].add(m); });
      pos += n;
      buf.copy(buf, 0, carry + n - OVERLAP < 0 ? 0 : carry + n - OVERLAP, carry + n);
      carry = Math.min(OVERLAP, carry + n);
      if (n < CHUNK) break;
    }
  } finally { fs.closeSync(fd); }
  return found.map((s) => [...s]);
}

/**
 * Antigravity 의 공개 OAuth 클라이언트(설치형 앱용) 후보. 소스에 값을 넣지 않고
 * env → 로컬에 설치된 agy / Antigravity IDE 실행파일에서 런타임 추출.
 * 반환: { ids: [...], secrets: [...], paired? }
 */
function antigravityOauthCandidates() {
  if (process.env.ANTIGRAVITY_OAUTH_CLIENT_ID && process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET) {
    return { ids: [process.env.ANTIGRAVITY_OAUTH_CLIENT_ID], secrets: [process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET], paired: true };
  }
  const ids = new Set(), secrets = new Set();
  for (const bin of antigravityBinaryCandidates()) {
    try {
      const [i, s] = scanBinary(bin, [/\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/g, /GOCSPX-[A-Za-z0-9_-]{28}/g]);
      i.forEach((x) => ids.add(x));
      s.forEach((x) => secrets.add(x));
      if (ids.size && secrets.size) break;
    } catch { /* 다음 후보 */ }
  }
  return { ids: [...ids], secrets: [...secrets], paired: false };
}

/** VS Code/Cursor state.vscdb 바이너리에서 key 근처 JWT 를 찾는다 (sqlite 의존성 없이) */
function scanVscdbJwt(file, keyHint) {
  try {
    const data = fs.readFileSync(file);
    const keyBuf = Buffer.from(keyHint, 'utf8');
    let pos = 0;
    while ((pos = data.indexOf(keyBuf, pos)) !== -1) {
      const slice = data.slice(pos, Math.min(data.length, pos + 8000)).toString('utf8');
      const m = slice.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
      if (m) return m[0];
      pos += keyBuf.length;
    }
    // 키 근처 실패 시 파일 전체에서 session 타입 JWT 후보를 느슨하게 탐색
    const text = data.toString('latin1');
    const re = /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
    let match;
    while ((match = re.exec(text))) {
      const payload = decodeJwt(match[0]);
      if (payload && (payload.type === 'session' || payload.aud === 'https://cursor.com')) return match[0];
    }
  } catch { /* 없음 */ }
  return null;
}

function cursorStateDbPaths() {
  const appData = process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
  const paths = [];
  if (process.platform === 'win32') {
    paths.push(path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else if (process.platform === 'darwin') {
    paths.push(path.join(home(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else {
    paths.push(path.join(home(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  }
  return paths;
}

function normalizeGoogleTokens(j) {
  if (!j || typeof j !== 'object') return null;
  const access = j.access_token || j.accessToken;
  if (!access) return null;
  let expiry = j.expiry_date ?? j.expiryDate ?? j.expires_at ?? j.expiresAt ?? null;
  if (typeof expiry === 'string') expiry = Date.parse(expiry) || null;
  if (typeof expiry === 'number' && expiry < 1e12) expiry *= 1000;
  return {
    access_token: access,
    refresh_token: j.refresh_token || j.refreshToken || null,
    expiry_date: expiry,
    id_token: j.id_token || j.idToken || null,
  };
}

/** Windows 자격 증명 관리자의 일반 자격 증명(target) 을 UTF-8 문자열로 읽는다 */
function readWindowsCredential(target) {
  if (process.platform !== 'win32') return null;
  const ps = `
$sig = @'
using System; using System.Runtime.InteropServices;
public class CredRd {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop
[IntPtr]$p = [IntPtr]::Zero
if ([CredRd]::CredRead(${JSON.stringify(target)}, 1, 0, [ref]$p)) {
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][CredRd+CREDENTIAL])
  $b = New-Object byte[] $c.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize)
  [CredRd]::CredFree($p)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))
}`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15000,
    });
    return out && out.trim() ? out.trim() : null;
  } catch { return null; }
}

function readMacKeychain(service) {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    }).trim() || null;
  } catch { return null; }
}

/**
 * agy CLI / Antigravity 가 저장한 Google OAuth 토큰.
 * 순서: 환경변수 파일 → 토큰 파일들 → Windows 자격 증명 관리자 / macOS Keychain ("gemini:antigravity")
 */
function antigravity() {
  const dir = process.env.GEMINI_CLI_HOME || path.join(home(), '.gemini');
  const files = [
    process.env.AGY_OAUTH_TOKEN_FILE,
    path.join(dir, 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(dir, 'jetski-standalone-oauth-token'),
  ].filter(Boolean);
  for (const f of files) {
    const j = readJson(f);
    const t = normalizeGoogleTokens(j);
    if (t) return { tokens: t, sourceKey: 'gemini.srcAgyFile' };
  }
  for (const raw of [readWindowsCredential('gemini:antigravity'), readMacKeychain('gemini:antigravity')]) {
    if (!raw) continue;
    let j = null;
    try { j = JSON.parse(raw); } catch { /* JSON 아님 */ }
    const t = normalizeGoogleTokens(j);
    if (t) return { tokens: t, sourceKey: process.platform === 'win32' ? 'gemini.srcAgyWin' : 'gemini.srcAgyMac' };
  }
  return null;
}

function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

/** WorkOS JWT sub → 쿠키용 user id (google-oauth2|user_… → user_…) */
function cursorUserIdFromSub(sub) {
  if (sub == null) return null;
  const s = String(sub);
  const pipe = s.lastIndexOf('|');
  if (pipe >= 0 && s.slice(pipe + 1)) return s.slice(pipe + 1);
  return s;
}

function cursorAuthJsonPaths() {
  const paths = [];
  if (process.platform === 'win32') {
    paths.push(path.join(process.env.USERPROFILE || home(), '.cursor', 'auth.json'));
    paths.push(path.join(process.env.APPDATA || path.join(home(), 'AppData', 'Roaming'), 'Cursor', 'auth.json'));
  } else if (process.platform === 'darwin') {
    paths.push(path.join(home(), '.cursor', 'auth.json'));
    paths.push(path.join(home(), 'Library', 'Application Support', 'Cursor', 'auth.json'));
  } else {
    paths.push(path.join(home(), '.cursor', 'auth.json'));
    paths.push(path.join(home(), '.config', 'cursor', 'auth.json'));
  }
  return paths;
}

function tokenFromAccessJwt(jwt, sourceKey) {
  const payload = decodeJwt(jwt);
  if (!jwt || !payload || !payload.sub) return null;
  const sub = cursorUserIdFromSub(payload.sub);
  return { jwt, sub, cookie: `${sub}::${jwt}`, sourceKey };
}

/**
 * Cursor IDE 가 저장한 세션 JWT (state.vscdb 의 cursorAuth/accessToken).
 * 웹 쿠키 WorkosCursorSessionToken = `${userId}::${jwt}` 형태로 쓴다.
 */
function cursorIdeToken() {
  if (process.env.CURSOR_SESSION_TOKEN) {
    const raw = process.env.CURSOR_SESSION_TOKEN.trim();
    if (raw.includes('::') || raw.includes('%3A%3A')) {
      const cookie = raw.includes('%3A%3A') ? decodeURIComponent(raw) : raw;
      const jwt = cookie.split('::').pop();
      const payload = decodeJwt(jwt);
      const sub = cursorUserIdFromSub((payload && payload.sub) || cookie.split('::')[0]);
      return { jwt, sub, cookie: `${sub}::${jwt}`, sourceKey: 'cursor.srcEnv' };
    }
    const fromEnv = tokenFromAccessJwt(raw, 'cursor.srcEnv');
    if (fromEnv) return fromEnv;
  }
  for (const p of cursorAuthJsonPaths()) {
    const j = readJson(p);
    const jwt = j && (j.accessToken || j.access_token);
    const fromFile = tokenFromAccessJwt(jwt, 'cursor.srcAgent');
    if (fromFile) return fromFile;
  }
  const keyHints = ['cursorAuth/accessToken', 'cursorAuth/cachedAccessToken', 'WorkosCursorSessionToken'];
  for (const db of cursorStateDbPaths()) {
    // Cursor IDE 가 DB 를 잠그면 복사본으로 읽는다
    let target = db;
    let tmp = null;
    try {
      if (fs.existsSync(db)) {
        tmp = path.join(os.tmpdir(), `cursor-state-${process.pid}-${Date.now()}.vscdb`);
        fs.copyFileSync(db, tmp);
        target = tmp;
      }
    } catch { target = db; tmp = null; }
    try {
      for (const hint of keyHints) {
        const jwt = scanVscdbJwt(target, hint);
        const fromDb = tokenFromAccessJwt(jwt, 'cursor.srcIde');
        if (fromDb) return fromDb;
      }
    } finally {
      if (tmp) try { fs.unlinkSync(tmp); } catch { /* */ }
    }
  }
  if (process.platform === 'darwin') {
    try {
      const jwt = execFileSync('security', ['find-generic-password', '-s', 'cursor-access-token', '-w'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
      }).trim();
      const fromKc = tokenFromAccessJwt(jwt, 'cursor.srcKeychain');
      if (fromKc) return fromKc;
    } catch { /* 없음 */ }
  }
  return null;
}

module.exports = {
  claudeCode, codex, geminiCli, geminiProjectHint, geminiOauthClient, decodeJwt,
  antigravity, antigravityOauthCandidates, normalizeGoogleTokens,
  cursorIdeToken,
};
