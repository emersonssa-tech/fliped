const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══ MULTER (temp upload) ═══
// Limite ampliado para 50MB para preservar resolução original dos desenhos
// (fotos modernas de celular ficam entre 5-15MB; scans 300dpi A4 podem passar de 20MB).
// O arquivo é salvo no Volume sem recompressão para manter máxima qualidade.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/tiff'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de arquivo não permitido. Use PDF, JPG, PNG, WebP, HEIC ou TIFF.'));
  }
});

// (Integração Google Drive removida — os uploads vão direto ao volume local.)

// ═══ PROFESSORES (persistência em JSON) ═══
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFESSORS_FILE = path.join(DATA_DIR, 'professors.json');
// ═══ ALUNOS / TEXTOS (persistência em JSON, compartilhado entre todos) ═══
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
// ═══ PROFESSOR(A) RESPONSÁVEL POR TURMA (mapa unit|turma → nome, compartilhado) ═══
const TEACHERS_FILE = path.join(DATA_DIR, 'teachers.json');

// ═══ UPLOADS LOCAIS (Volume persistente) ═══
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
function slug(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sem_nome';
}
// Salva um buffer no Volume de forma ATÔMICA (.tmp + rename) e retorna o link público
async function saveToVolume(fileBuffer, fileName, unitName, turma) {
  const dir = path.join(UPLOADS_DIR, slug(unitName), slug(turma));
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, fileBuffer);
  await fsp.rename(tmp, dest);
  return {
    name: fileName,
    link: `/uploads/${slug(unitName)}/${slug(turma)}/${encodeURIComponent(fileName)}`,
    size: fileBuffer.length
  };
}

// ═══ PERSISTÊNCIA — cache em memória + escrita atômica serializada ═══
// Os dados ficam em memória (carregados 1x no boot) e são servidos de lá: zero
// I/O de disco por request (antes lia 1,3MB a cada chamada). Cada escrita
// atualiza a memória e persiste de forma ATÔMICA (.tmp + rename) e SERIALIZADA
// (fila por arquivo) — evita corrupção em queda/reinício e perda de updates
// concorrentes.
let professorsData = [];   // array
let studentsData = {};     // dicionário por studentKey
let teachersData = {};     // dicionário unit|turma → nome da professora responsável

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

// Fila de escrita por arquivo (mutex via Promise-chain) com escrita atômica.
const _writeQueues = new Map();
function atomicWriteJson(file, value) {
  const content = JSON.stringify(value, null, 2);
  const prev = _writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();              // flush no disco antes do rename
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);    // rename é atômico no mesmo filesystem
  });
  _writeQueues.set(file, next);
  return next;
}

// Lê um JSON no boot. Se o arquivo EXISTE mas está corrompido, ABORTA o boot em
// vez de assumir vazio (evita a "cascata de corrupção" que apagaria os textos).
async function readJsonOrAbort(file, fallback, label) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;   // primeira execução
    console.error(`✗ FATAL: não consegui LER ${label} (${file}): ${e.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`✗ FATAL: ${label} (${file}) está CORROMPIDO: ${e.message}`);
    console.error('  Abortei o boot para NÃO sobrescrever dados. Restaure de um backup.');
    process.exit(1);
  }
}

async function initData() {
  await ensureDataDir();
  professorsData = await readJsonOrAbort(PROFESSORS_FILE, [], 'professors.json');
  studentsData = await readJsonOrAbort(STUDENTS_FILE, {}, 'students.json');
  teachersData = await readJsonOrAbort(TEACHERS_FILE, {}, 'teachers.json');
  console.log(`Dados carregados: ${professorsData.length} professores, ${Object.keys(studentsData).length} alunos, ${Object.keys(teachersData).length} turmas com professor(a)`);
}

function loadProfessors() { return professorsData; }
async function saveProfessors(profs) {
  professorsData = profs;
  await atomicWriteJson(PROFESSORS_FILE, professorsData);
}

// ── Professor(a) responsável por turma: mapa compartilhado unit|turma → nome ──
function loadTeachers() { return teachersData; }
async function saveTeachers(data) {
  teachersData = data;
  await atomicWriteJson(TEACHERS_FILE, teachersData);
}

// ── Alunos: dados compartilhados de texto/status, indexados por chave estável ──
// A chave é unit|turma|name (o id muda por navegador, então não serve de chave).
// Normaliza removendo acentos, espaços duplicados e caixa, pra que diferenças
// sutis (ex.: "FB1 MAT" vs "FB1  MAT", "1º" vs "1°") não quebrem o merge.
function studentKey(unit, turma, name) {
  return [unit, turma, name].map(v =>
    String(v || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u00ba\u00b0]/g, 'o').replace(/\u00aa/g, 'a')
      .trim().toLowerCase().replace(/\s+/g, ' ')
  ).join('|');
}

function loadStudentData() { return studentsData; }
async function saveStudentData(data) {
  studentsData = data;
  await atomicWriteJson(STUDENTS_FILE, studentsData);
}

// Gerar ID curto único
function genId() {
  return Math.random().toString(36).substring(2, 10);
}

// ═══ APP VERSION (cache busting automático) ═══
// O buildId é um hash SHA-1 do conteúdo dos arquivos críticos do front + server.
// Toda vez que QUALQUER um deles muda (push no GitHub → redeploy Railway),
// o hash muda → o front (que checa a cada 60s) recarrega sozinho.
// Resolve o problema de "Ctrl+Shift+R" em toda alteração de HTML/JS/CSS.
const crypto = require('crypto');
function computeBuildId() {
  const filesToHash = [
    'index.html',
    'professor.html',
    'server.js',
    'version.json',
    'public/version.json',
    'public/alunos_seed.json',
    'public/seed-version.json',
  ];
  const h = crypto.createHash('sha1');
  for (const rel of filesToHash) {
    const p = path.join(__dirname, rel);
    try {
      h.update(rel + '\0');
      h.update(fs.readFileSync(p));
      h.update('\0');
    } catch (_e) { /* arquivo opcional ausente — ignora */ }
  }
  return h.digest('hex').slice(0, 12);
}
// Permite override por env var (deploy hash do Railway/GH Actions) caso queira.
// Senão, calcula a partir do conteúdo. Recalculado no boot do servidor.
const APP_BUILD_ID = process.env.RAILWAY_GIT_COMMIT_SHA
  || process.env.GIT_COMMIT
  || computeBuildId();
const APP_BUILD_TIME = new Date().toISOString();

// Versão legível (exibida ao usuário no aviso de atualização). Lida do version.json.
// O buildId continua sendo o detector real de mudança (muda a cada deploy);
// o version.json fornece um número amigável para mostrar na tela.
function readAppVersion() {
  for (const rel of ['version.json', 'public/version.json']) {
    try {
      const raw = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      const v = JSON.parse(raw).version;
      if (v) return String(v);
    } catch (_e) { /* ausente — tenta o próximo */ }
  }
  return null;
}
const APP_VERSION = readAppVersion();
console.log(`FLIPED build id: ${APP_BUILD_ID} (v${APP_VERSION || '?'}) @ ${APP_BUILD_TIME}`);

app.get('/api/app-version', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({ buildId: APP_BUILD_ID, version: APP_VERSION, buildTime: APP_BUILD_TIME });
});

// ═══ STATIC FILES com política de cache correta ═══
// Regra: HTML, JSON de dados, seed-version → SEMPRE no-cache (revalidar a cada request).
//        JS/CSS bundled, imagens → pode cachear (mas sem hash no nome, usamos no-cache também por segurança).
//
// Isso resolve o problema do "Ctrl+Shift+R": o browser SEMPRE pede o HTML novo,
// e o HTML tem dentro o build id atual, que é comparado com o do servidor a cada minuto.
function setCacheHeaders(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();

  // HTML, seed-version e dados dinâmicos: NUNCA cachear
  if (ext === '.html' || name === 'seed-version.json' || name === 'alunos_seed.json') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return;
  }
  // JS/CSS/JSON estáticos: cache curto + revalidação
  if (['.js', '.css', '.json'].includes(ext)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return;
  }
  // Imagens, fontes: pode cachear mais tempo (uma semana)
  res.set('Cache-Control', 'public, max-age=604800');
}

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: setCacheHeaders
}));
// Também servir da raiz (compatibilidade com setup atual)
app.use(express.static(__dirname, {
  etag: true,
  lastModified: true,
  setHeaders: setCacheHeaders
}));
ensureUploadsDir();

// ═══ AUTENTICAÇÃO — sessão por cookie assinado (HMAC) + senhas com scrypt ═══
// Sem dependências externas. O cookie 'em_session' viaja automaticamente em
// fetch E em <img src="/uploads/...">, protegendo a API e os desenhos.
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.ADMIN_TOKEN || 'dev-inseguro-trocar';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function signToken(data) {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}
function parseCookies(req) {
  const out = {}; const h = req.headers.cookie;
  if (h) for (const part of h.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isSecureReq(req) {
  return !!(req.secure || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}
function setSessionCookie(req, res, token) {
  const sec = isSecureReq(req) ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `em_session=${token}; Path=/; HttpOnly;${sec} SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}
function clearSessionCookie(req, res) {
  const sec = isSecureReq(req) ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `em_session=; Path=/; HttpOnly;${sec} SameSite=Lax; Max-Age=0`);
}
function getUser(req) { return verifyToken(parseCookies(req)['em_session']); }
function requireAuth(role) {
  return (req, res, next) => {
    const u = getUser(req);
    if (!u) return res.status(401).json({ error: 'Não autenticado' });
    if (role === 'admin' && u.role !== 'admin') return res.status(403).json({ error: 'Requer administrador' });
    req.user = u;
    next();
  };
}
// Senhas com scrypt (nativo). Formato: scrypt$<saltHex>$<hashHex>.
// Aceita legado em texto puro e sinaliza upgrade no login.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (typeof stored !== 'string' || !stored) return { ok: false, legacy: false };
  if (stored.startsWith('scrypt$')) {
    const [, saltHex, hashHex] = stored.split('$');
    try {
      const h = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32);
      const exp = Buffer.from(hashHex, 'hex');
      return { ok: h.length === exp.length && crypto.timingSafeEqual(h, exp), legacy: false };
    } catch { return { ok: false, legacy: false }; }
  }
  return { ok: stored === String(pw), legacy: true };
}

app.use(express.json());

// Desenhos protegidos: exigem sessão (cookie). Antes eram públicos (risco LGPD).
app.use('/uploads', requireAuth(), express.static(UPLOADS_DIR));

// ═══ HEALTH CHECK ═══
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ═══ SESSÃO (admin / me / logout) ═══
// Login do admin = senha igual ao ADMIN_TOKEN. Emite cookie de sessão 'admin'.
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  // Senha do painel = ADMIN_PASSWORD (amigável). O ADMIN_TOKEN continua sendo o
  // segredo FORTE que assina os cookies (SESSION_SECRET) — não deve ser a senha.
  const admin = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN;
  if (!admin) return res.status(500).json({ error: 'Senha de admin não configurada no servidor' });
  const ok = typeof password === 'string'
    && Buffer.byteLength(password) === Buffer.byteLength(admin)
    && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(admin));
  if (!ok) return res.status(401).json({ error: 'Senha de administrador incorreta' });
  setSessionCookie(req, res, signToken({ role: 'admin', name: 'admin' }));
  res.json({ success: true, role: 'admin' });
});

app.post('/api/logout', (req, res) => { clearSessionCookie(req, res); res.json({ success: true }); });

app.get('/api/me', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'Não autenticado' });
  res.json({ role: u.role, name: u.name, unit: u.unit, turmas: u.turmas });
});

// ═══ UPLOAD INDIVIDUAL (salva no Volume persistente) ═══
app.post('/api/upload', requireAuth(), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const { studentName, studentId, turma, unitName, storyText } = req.body;
    if (!studentName || !turma || !unitName) {
      return res.status(400).json({ error: 'Dados do aluno incompletos' });
    }

    const safeName = slug(studentName);
    const ext = path.extname(req.file.originalname) || '.pdf';
    const fileName = `${safeName}_${studentId || genId()}${ext}`;

    const saved = await saveToVolume(req.file.buffer, fileName, unitName, turma);

    res.json({
      success: true,
      file: {
        id: saved.name,
        name: saved.name,
        link: saved.link,
        downloadLink: saved.link,
        size: saved.size
      },
      studentId,
      storyText: storyText || ''
    });
  } catch (e) {
    console.error('Erro no upload:', e.message);
    res.status(500).json({ error: 'Falha no upload: ' + e.message });
  }
});

// ═══ UPLOAD EM LOTE (salva no Volume persistente) ═══
app.post('/api/upload-batch', requireAuth(), upload.array('files', 50), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const { turma, unitName, studentIds } = req.body;
    if (!turma || !unitName) {
      return res.status(400).json({ error: 'Dados da turma incompletos' });
    }

    const ids = JSON.parse(studentIds || '[]');
    // Cada arquivo PRECISA estar pareado a um aluno (mesma ordem). Se as
    // contagens divergem, recusa: melhor falhar do que associar ao aluno errado.
    if (ids.length !== req.files.length) {
      return res.status(400).json({
        error: `Nº de arquivos (${req.files.length}) difere do nº de alunos selecionados (${ids.length}). Reenvie pareando 1 arquivo por aluno.`
      });
    }

    const results = [];
    const usados = new Set();
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const studentId = ids[i] || `batch_${genId()}`;
      if (usados.has(studentId)) {
        return res.status(400).json({ error: `studentId repetido no lote: ${studentId}` });
      }
      usados.add(studentId);
      const ext = path.extname(file.originalname) || '.pdf';
      // Nome derivado do studentId (único) — evita colisão/sobrescrita por
      // posição. Cada aluno tem seu próprio arquivo, identificável pelo id.
      const fileName = `${slug(turma)}_${slug(String(studentId))}${ext}`;

      const saved = await saveToVolume(file.buffer, fileName, unitName, turma);
      results.push({
        index: i,
        studentId,
        originalName: file.originalname,
        fileId: saved.name,
        link: saved.link,
        name: saved.name
      });
    }

    res.json({ success: true, uploaded: results.length, files: results });
  } catch (e) {
    console.error('Erro no upload em lote:', e.message);
    res.status(500).json({ error: 'Falha no upload em lote: ' + e.message });
  }
});

// ═══ LISTAR ARQUIVOS DE UMA TURMA (do Volume) ═══
app.get('/api/files/:unitName/:turma', requireAuth(), async (req, res) => {
  try {
    const { unitName, turma } = req.params;
    const dir = path.join(UPLOADS_DIR, slug(unitName), slug(turma));
    let names;
    try { names = await fsp.readdir(dir); }
    catch (e) { if (e.code === 'ENOENT') return res.json({ success: true, files: [] }); throw e; }

    const files = [];
    for (const name of names.filter(n => !n.startsWith('.')).sort()) {
      const st = await fsp.stat(path.join(dir, name));
      files.push({
        id: name,
        name,
        webViewLink: `/uploads/${slug(unitName)}/${slug(turma)}/${encodeURIComponent(name)}`,
        link: `/uploads/${slug(unitName)}/${slug(turma)}/${encodeURIComponent(name)}`,
        size: st.size,
        createdTime: st.mtime.toISOString()
      });
    }

    res.json({ success: true, files });
  } catch (e) {
    console.error('Erro ao listar arquivos:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ LISTAR TODOS OS ARQUIVOS (varre todo o Volume — usado pelo Painel Marketing) ═══
app.get('/api/files-all', requireAuth('admin'), async (req, res) => {
  try {
    let unitDirs;
    try { unitDirs = await fsp.readdir(UPLOADS_DIR, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return res.json({ success: true, files: [] }); throw e; }

    const out = [];
    for (const u of unitDirs) {
      if (!u.isDirectory() || u.name.startsWith('.')) continue;
      const unitPath = path.join(UPLOADS_DIR, u.name);
      const turmaDirs = await fsp.readdir(unitPath, { withFileTypes: true });
      for (const t of turmaDirs) {
        if (!t.isDirectory() || t.name.startsWith('.')) continue;
        const turmaPath = path.join(unitPath, t.name);
        const files = await fsp.readdir(turmaPath, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile() || f.name.startsWith('.')) continue;
          const st = await fsp.stat(path.join(turmaPath, f.name));
          out.push({
            unitSlug: u.name,
            turmaSlug: t.name,
            id: f.name,
            name: f.name,
            link: `/uploads/${u.name}/${t.name}/${encodeURIComponent(f.name)}`,
            size: st.size,
            mtime: st.mtime.toISOString()
          });
        }
      }
    }
    res.json({ success: true, files: out });
  } catch (e) {
    console.error('Erro ao listar todos os arquivos:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ DOWNLOAD EM MASSA (ZIP) ═══
// Modos:
//   POST /api/zip  body: { mode: 'unit', unitName }
//   POST /api/zip  body: { mode: 'turma', unitName, turma }
//   POST /api/zip  body: { mode: 'selection', files: [{ unitSlug, turmaSlug, name }] }
app.post('/api/zip', requireAuth(), async (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!mode) return res.status(400).json({ error: 'mode é obrigatório (unit, turma ou selection)' });

    // Resolve lista de arquivos absolutos
    const collected = []; // { abs, rel } — rel é o caminho dentro do ZIP
    const statOrNull = async (p) => { try { return await fsp.stat(p); } catch { return null; } };
    if (mode === 'unit') {
      const { unitName } = req.body;
      if (!unitName) return res.status(400).json({ error: 'unitName é obrigatório' });
      const unitDir = path.join(UPLOADS_DIR, slug(unitName));
      let turmas;
      try { turmas = await fsp.readdir(unitDir, { withFileTypes: true }); }
      catch (e) { if (e.code === 'ENOENT') return res.status(404).json({ error: 'Unidade sem desenhos enviados' }); throw e; }
      for (const t of turmas) {
        if (!t.isDirectory() || t.name.startsWith('.')) continue;
        const tDir = path.join(unitDir, t.name);
        for (const f of await fsp.readdir(tDir, { withFileTypes: true })) {
          if (!f.isFile() || f.name.startsWith('.')) continue;
          collected.push({ abs: path.join(tDir, f.name), rel: path.join(t.name, f.name) });
        }
      }
    } else if (mode === 'turma') {
      const { unitName, turma } = req.body;
      if (!unitName || !turma) return res.status(400).json({ error: 'unitName e turma são obrigatórios' });
      const tDir = path.join(UPLOADS_DIR, slug(unitName), slug(turma));
      let entries;
      try { entries = await fsp.readdir(tDir, { withFileTypes: true }); }
      catch (e) { if (e.code === 'ENOENT') return res.status(404).json({ error: 'Turma sem desenhos enviados' }); throw e; }
      for (const f of entries) {
        if (!f.isFile() || f.name.startsWith('.')) continue;
        collected.push({ abs: path.join(tDir, f.name), rel: f.name });
      }
    } else if (mode === 'selection') {
      const { files } = req.body;
      if (!Array.isArray(files) || !files.length) {
        return res.status(400).json({ error: 'files[] é obrigatório para mode=selection' });
      }
      for (const item of files) {
        if (!item || !item.unitSlug || !item.turmaSlug || !item.name) continue;
        const abs = path.join(UPLOADS_DIR, item.unitSlug, item.turmaSlug, path.basename(item.name));
        if (!abs.startsWith(UPLOADS_DIR)) continue; // segurança
        const st = await statOrNull(abs);
        if (st && st.isFile()) {
          collected.push({ abs, rel: path.join(item.unitSlug, item.turmaSlug, item.name) });
        }
      }
    } else {
      return res.status(400).json({ error: 'mode inválido' });
    }

    if (!collected.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado para o filtro selecionado' });

    // Nome do ZIP
    const stamp = new Date().toISOString().slice(0, 10);
    let zipName = `fliped_${mode}_${stamp}.zip`;
    if (mode === 'unit') zipName = `fliped_${slug(req.body.unitName)}_${stamp}.zip`;
    if (mode === 'turma') zipName = `fliped_${slug(req.body.unitName)}_${slug(req.body.turma)}_${stamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('Erro no archiver:', err.message);
      try { res.status(500).end(); } catch {}
    });
    archive.pipe(res);
    for (const f of collected) {
      archive.file(f.abs, { name: f.rel });
    }
    archive.finalize();
  } catch (e) {
    console.error('Erro no ZIP:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ DELETAR ARQUIVO (do Volume) ═══
app.delete('/api/files/:unitName/:turma/:fileName', requireAuth('admin'), async (req, res) => {
  try {
    const { unitName, turma, fileName } = req.params;
    const target = path.join(UPLOADS_DIR, slug(unitName), slug(turma), path.basename(fileName));
    if (!target.startsWith(UPLOADS_DIR)) return res.status(400).json({ error: 'Caminho inválido' });
    try { await fsp.unlink(target); }
    catch (e) { if (e.code === 'ENOENT') return res.status(404).json({ error: 'Arquivo não encontrado' }); throw e; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══ PROFESSORES — CRUD ═══

// Listar todos (para o painel admin)
app.get('/api/professors', requireAuth('admin'), (req, res) => {
  const profs = loadProfessors();
  // Não expor senha no listing
  res.json(profs.map(p => ({ ...p, password: '***' })));
});

// Criar professor
app.post('/api/professors', requireAuth('admin'), async (req, res) => {
  const { name, password, unit, turmas } = req.body;
  if (!name || !password || !unit || !turmas || !turmas.length) {
    return res.status(400).json({ error: 'Campos obrigatórios: name, password, unit, turmas[]' });
  }
  const profs = loadProfessors();
  const prof = {
    id: genId(),
    name,
    password: hashPassword(password),
    unit,
    turmas, // array de turmas: ["Grupo 2", "Grupo 3"]
    createdAt: new Date().toISOString()
  };
  profs.push(prof);
  await saveProfessors(profs);
  res.json({ success: true, professor: { ...prof, password: '***' } });
});

// Atualizar professor
app.put('/api/professors/:id', requireAuth('admin'), async (req, res) => {
  const profs = loadProfessors();
  const idx = profs.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Professor não encontrado' });

  const { name, password, unit, turmas } = req.body;
  if (name) profs[idx].name = name;
  if (password) profs[idx].password = hashPassword(password);
  if (unit) profs[idx].unit = unit;
  if (turmas) profs[idx].turmas = turmas;

  await saveProfessors(profs);
  res.json({ success: true, professor: { ...profs[idx], password: '***' } });
});

// Deletar professor
app.delete('/api/professors/:id', requireAuth('admin'), async (req, res) => {
  let profs = loadProfessors();
  profs = profs.filter(p => p.id !== req.params.id);
  await saveProfessors(profs);
  res.json({ success: true });
});

// ═══ PROFESSOR(A) RESPONSÁVEL POR TURMA — mapa compartilhado ═══
// Antes esse mapa vivia só no localStorage do navegador do coordenador, então
// sumia ao trocar de máquina/navegador. Agora é persistido no servidor e vale
// para qualquer dispositivo.

// Retorna o mapa completo { "unit|turma": "Nome da Professora" }
app.get('/api/teachers', requireAuth('admin'), (req, res) => {
  res.json(loadTeachers());
});

// Define/remove o professor(a) de UMA turma (upsert por chave — seguro para
// edições concorrentes, não sobrescreve o mapa inteiro).
// Body: { key: "unit|turma", name: "Nome" }  — name vazio remove a chave.
app.post('/api/teachers', requireAuth('admin'), async (req, res) => {
  const { key, name } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Campo obrigatório: key ("unit|turma")' });
  }
  const teachers = { ...loadTeachers() };
  const clean = String(name || '').trim();
  if (clean) teachers[key] = clean;
  else delete teachers[key];
  await saveTeachers(teachers);
  res.json({ success: true, teachers });
});

// Mescla vários de uma vez (usado na migração das entradas que só existiam no
// localStorage). Body: { teachers: { "unit|turma": "Nome", ... } }.
// Só ADICIONA chaves que ainda não existem no servidor — nunca sobrescreve o
// que já foi salvo por outra pessoa.
app.post('/api/teachers/merge', requireAuth('admin'), async (req, res) => {
  const incoming = (req.body && req.body.teachers) || {};
  if (typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Campo obrigatório: teachers (objeto)' });
  }
  const teachers = { ...loadTeachers() };
  let added = 0;
  for (const [key, name] of Object.entries(incoming)) {
    const clean = String(name || '').trim();
    if (clean && !teachers[key]) { teachers[key] = clean; added++; }
  }
  if (added) await saveTeachers(teachers);
  res.json({ success: true, added, teachers });
});

// ═══ ALUNOS — TEXTOS E STATUS (compartilhado entre todos os usuários) ═══

// Retorna todos os dados de alunos salvos no servidor
app.get('/api/students', requireAuth(), (req, res) => {
  const all = loadStudentData();
  if (req.user.role === 'professor') {
    // Professor só enxerga os alunos da própria unidade.
    const out = {};
    for (const k of Object.keys(all)) if (all[k] && all[k].unit === req.user.unit) out[k] = all[k];
    return res.json({ success: true, students: out });
  }
  res.json({ success: true, students: all });
});

// Salva/atualiza o texto e status de um aluno.
// Body: { unit, turma, name, storyText?, status?, hasDrawing?, textReviewed?, pdfGenerated? }
app.post('/api/students/save', requireAuth(), async (req, res) => {
  try {
    const { unit, turma, name } = req.body;
    if (!unit || !turma || !name) {
      return res.status(400).json({ error: 'unit, turma e name são obrigatórios' });
    }
    if (req.user.role === 'professor' && unit !== req.user.unit) {
      return res.status(403).json({ error: 'Você só pode editar alunos da sua unidade' });
    }
    const data = loadStudentData();
    const key = studentKey(unit, turma, name);
    const prev = data[key] || {};
    const next = { ...prev, unit, turma, name };
    // só sobrescreve campos que vieram no body (undefined não sobrescreve)
    ['storyText', 'status', 'hasDrawing', 'textReviewed', 'pdfGenerated', 'driveLink', 'driveFileId'].forEach(f => {
      if (req.body[f] !== undefined) next[f] = req.body[f];
    });
    next.updatedAt = new Date().toISOString();
    data[key] = next;
    await saveStudentData(data);
    res.json({ success: true, student: next });
  } catch (e) {
    console.error('Erro ao salvar aluno:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ MIGRAÇÃO DE CHAVES (admin) ═══
// Quando o nome da turma muda no alunos_seed.json (ex.: renomeação SISED de
// Cajazeiras em 2026-05-28), os textos já gravados ficam órfãos: a chave
// unit|turma|name no servidor não bate mais com a do front. Este endpoint lê
// o seed atual, e para cada (unit, name) no servidor cuja turma não existe
// mais, reescreve a chave usando a turma atual. Match por nome normalizado.
// Protegido por token via header X-Admin-Token (env var ADMIN_TOKEN).
function loadSeed() {
  const candidates = [
    path.join(__dirname, 'public', 'alunos_seed.json'),
    path.join(__dirname, 'alunos_seed.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(_) {}
    }
  }
  return [];
}
function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

app.post('/api/admin/migrate-student-keys', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'token inválido' });
  }
  const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;

  const seed = loadSeed();
  // Index seed: unit + nome_normalizado -> turma atual
  const seedIndex = new Map();
  for (const s of seed) {
    if (!s.unit || !s.name || !s.turma) continue;
    const k = `${s.unit}|${normName(s.name)}`;
    // Se houver dois alunos com mesmo nome na mesma unidade, ignora (não dá pra escolher).
    if (seedIndex.has(k)) seedIndex.set(k, '__AMBIGUOUS__');
    else seedIndex.set(k, s.turma);
  }

  const data = loadStudentData();
  const oldKeys = Object.keys(data);
  const result = {
    total: oldKeys.length,
    remapped: 0,
    unchanged: 0,
    notFoundInSeed: 0,
    ambiguous: 0,
    collisions: 0,
    samples: { remapped: [], notFound: [], ambiguous: [] },
  };
  const next = {};
  for (const k of oldKeys) {
    const rec = data[k];
    if (!rec || !rec.unit || !rec.name) { next[k] = rec; continue; }
    const lookup = `${rec.unit}|${normName(rec.name)}`;
    const seedTurma = seedIndex.get(lookup);
    if (!seedTurma) {
      result.notFoundInSeed++;
      if (result.samples.notFound.length < 5) result.samples.notFound.push({ unit: rec.unit, turma: rec.turma, name: rec.name });
      next[k] = rec; // mantém como está
      continue;
    }
    if (seedTurma === '__AMBIGUOUS__') {
      result.ambiguous++;
      if (result.samples.ambiguous.length < 5) result.samples.ambiguous.push({ unit: rec.unit, name: rec.name });
      next[k] = rec;
      continue;
    }
    if (seedTurma === rec.turma) {
      result.unchanged++;
      next[k] = rec;
      continue;
    }
    // Remapeia para a turma atual
    const updated = { ...rec, turma: seedTurma, _migratedFrom: rec.turma, _migratedAt: new Date().toISOString() };
    const newKey = studentKey(updated.unit, updated.turma, updated.name);
    if (next[newKey]) {
      // colisão: já existe registro novo com essa chave (raro). Mantém o mais
      // recente (por updatedAt). Para não perder texto da professora, prefere
      // o que tem storyText preenchido.
      const a = next[newKey], b = updated;
      const pick = (b.storyText && !a.storyText) ? b
                 : (a.storyText && !b.storyText) ? a
                 : (new Date(b.updatedAt || 0) > new Date(a.updatedAt || 0) ? b : a);
      next[newKey] = pick;
      result.collisions++;
    } else {
      next[newKey] = updated;
    }
    result.remapped++;
    if (result.samples.remapped.length < 5) {
      result.samples.remapped.push({ unit: rec.unit, name: rec.name, from: rec.turma, to: seedTurma });
    }
  }

  if (!dryRun) {
    // Backup antes de gravar
    try {
      const bak = STUDENTS_FILE + '.bak-' + Date.now();
      await fsp.copyFile(STUDENTS_FILE, bak);
      result.backup = path.basename(bak);
    } catch(e) { result.backupError = e.message; }
    await saveStudentData(next);
    result.applied = true;
  } else {
    result.applied = false;
  }
  res.json(result);
});

// ═══ LOGIN DO PROFESSOR ═══
app.post('/api/professor/login', async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: 'Informe nome e senha' });
  }
  const profs = loadProfessors();
  const prof = profs.find(p => p.name.toLowerCase() === String(name).toLowerCase());
  const v = prof ? verifyPassword(password, prof.password) : { ok: false };
  if (!prof || !v.ok) {
    return res.status(401).json({ error: 'Nome ou senha incorretos' });
  }
  // Upgrade transparente: senha legada em texto puro -> hash scrypt
  if (v.legacy) { prof.password = hashPassword(password); await saveProfessors(profs); }
  setSessionCookie(req, res, signToken({ role: 'professor', id: prof.id, name: prof.name, unit: prof.unit, turmas: prof.turmas }));
  // Retorna dados do professor (sem senha)
  res.json({
    success: true,
    professor: {
      id: prof.id,
      name: prof.name,
      unit: prof.unit,
      turmas: prof.turmas
    }
  });
});

// ═══ START ═══
let server;
initData().then(() => {
  server = app.listen(PORT, () => {
    console.log(`FLIPED server rodando na porta ${PORT}`);
  });
}).catch((e) => {
  console.error('Falha ao iniciar:', e);
  process.exit(1);
});

// Graceful shutdown: ao receber SIGTERM/SIGINT (deploy, docker stop), para de
// aceitar conexões e ESPERA as escritas pendentes terminarem antes de sair —
// evita interromper uma gravação no meio e corromper os dados.
let _encerrando = false;
async function shutdown(sig) {
  if (_encerrando) return;
  _encerrando = true;
  console.log(`Recebido ${sig}, encerrando com segurança...`);
  try { if (server) await new Promise((resolve) => server.close(resolve)); } catch {}
  try { await Promise.allSettled(Array.from(_writeQueues.values())); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
