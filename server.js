const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const stream = require('stream');
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

// ═══ GOOGLE DRIVE AUTH ═══
let drive = null;
let DRIVE_ROOT_FOLDER = process.env.DRIVE_FOLDER_ID || null;

function initDrive() {
  try {
    const credsEnv = process.env.GOOGLE_CREDENTIALS;
    if (!credsEnv) {
      console.warn('⚠ GOOGLE_CREDENTIALS não configurado — uploads desabilitados');
      return;
    }
    const creds = JSON.parse(credsEnv);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    drive = google.drive({ version: 'v3', auth });
    console.log('✓ Google Drive API conectada');
  } catch (e) {
    console.error('✗ Erro ao inicializar Google Drive:', e.message);
  }
}

// ═══ HELPERS DRIVE ═══

// Busca ou cria subpasta dentro de um parent
async function findOrCreateFolder(name, parentId) {
  // Buscar existente
  const res = await drive.files.list({
    q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });
  if (res.data.files.length > 0) return res.data.files[0].id;

  // Criar nova
  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id'
  });
  return folder.data.id;
}

// Estrutura: FLIPED > Unidade > Turma
async function getStudentFolder(unitName, turma) {
  const unitFolderId = await findOrCreateFolder(unitName, DRIVE_ROOT_FOLDER);
  const turmaFolderId = await findOrCreateFolder(turma, unitFolderId);
  return turmaFolderId;
}

// Upload de arquivo para o Drive
async function uploadToDrive(fileBuffer, fileName, mimeType, folderId) {
  const bufferStream = new stream.PassThrough();
  bufferStream.end(fileBuffer);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: bufferStream
    },
    fields: 'id, name, webViewLink, webContentLink, size'
  });

  // Tornar acessível via link (anyone with link can view)
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone'
    }
  });

  return res.data;
}

// ═══ PROFESSORES (persistência em JSON) ═══
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFESSORS_FILE = path.join(DATA_DIR, 'professors.json');
// ═══ ALUNOS / TEXTOS (persistência em JSON, compartilhado entre todos) ═══
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');

// ═══ UPLOADS LOCAIS (Volume persistente) ═══
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
function slug(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sem_nome';
}
// Salva um buffer no Volume e retorna o link publico
function saveToVolume(fileBuffer, fileName, unitName, turma) {
  const dir = path.join(UPLOADS_DIR, slug(unitName), slug(turma));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), fileBuffer);
  return {
    name: fileName,
    link: `/uploads/${slug(unitName)}/${slug(turma)}/${encodeURIComponent(fileName)}`,
    size: fileBuffer.length
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadProfessors() {
  ensureDataDir();
  if (fs.existsSync(PROFESSORS_FILE)) {
    return JSON.parse(fs.readFileSync(PROFESSORS_FILE, 'utf8'));
  }
  return [];
}

function saveProfessors(profs) {
  ensureDataDir();
  fs.writeFileSync(PROFESSORS_FILE, JSON.stringify(profs, null, 2), 'utf8');
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

function loadStudentData() {
  ensureDataDir();
  if (fs.existsSync(STUDENTS_FILE)) {
    try { return JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8')); }
    catch (e) { console.error('students.json corrompido:', e.message); return {}; }
  }
  return {};
}

function saveStudentData(data) {
  ensureDataDir();
  fs.writeFileSync(STUDENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
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
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json());

// ═══ HEALTH CHECK ═══
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    drive: !!drive,
    driveFolder: !!DRIVE_ROOT_FOLDER,
    timestamp: new Date().toISOString()
  });
});

// ═══ UPLOAD INDIVIDUAL (salva no Volume persistente) ═══
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const { studentName, studentId, turma, unitName, storyText } = req.body;
    if (!studentName || !turma || !unitName) {
      return res.status(400).json({ error: 'Dados do aluno incompletos' });
    }

    const safeName = slug(studentName);
    const ext = path.extname(req.file.originalname) || '.pdf';
    const fileName = `${safeName}_${studentId || genId()}${ext}`;

    const saved = saveToVolume(req.file.buffer, fileName, unitName, turma);

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
app.post('/api/upload-batch', upload.array('files', 50), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const { turma, unitName, studentIds } = req.body;
    if (!turma || !unitName) {
      return res.status(400).json({ error: 'Dados da turma incompletos' });
    }

    const ids = JSON.parse(studentIds || '[]');

    const results = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const studentId = ids[i] || `batch_${i}`;
      const ext = path.extname(file.originalname) || '.pdf';
      const fileName = `${slug(turma)}_${String(i + 1).padStart(3, '0')}_${studentId}${ext}`;

      const saved = saveToVolume(file.buffer, fileName, unitName, turma);
      results.push({
        index: i,
        studentId,
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
app.get('/api/files/:unitName/:turma', async (req, res) => {
  try {
    const { unitName, turma } = req.params;
    const dir = path.join(UPLOADS_DIR, slug(unitName), slug(turma));
    if (!fs.existsSync(dir)) return res.json({ success: true, files: [] });

    const files = fs.readdirSync(dir).filter(n => !n.startsWith('.')).sort().map(name => {
      const st = fs.statSync(path.join(dir, name));
      return {
        id: name,
        name,
        webViewLink: `/uploads/${slug(unitName)}/${slug(turma)}/${encodeURIComponent(name)}`,
        link: `/uploads/${slug(unitName)}/${slug(turma)}/${encodeURIComponent(name)}`,
        size: st.size,
        createdTime: st.mtime.toISOString()
      };
    });

    res.json({ success: true, files });
  } catch (e) {
    console.error('Erro ao listar arquivos:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ LISTAR TODOS OS ARQUIVOS (varre todo o Volume — usado pelo Painel Marketing) ═══
app.get('/api/files-all', (req, res) => {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return res.json({ success: true, files: [] });

    const out = [];
    const unitDirs = fs.readdirSync(UPLOADS_DIR).filter(n => !n.startsWith('.'));
    for (const uDir of unitDirs) {
      const unitPath = path.join(UPLOADS_DIR, uDir);
      if (!fs.statSync(unitPath).isDirectory()) continue;
      const turmaDirs = fs.readdirSync(unitPath).filter(n => !n.startsWith('.'));
      for (const tDir of turmaDirs) {
        const turmaPath = path.join(unitPath, tDir);
        if (!fs.statSync(turmaPath).isDirectory()) continue;
        const files = fs.readdirSync(turmaPath).filter(n => !n.startsWith('.'));
        for (const name of files) {
          const full = path.join(turmaPath, name);
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          out.push({
            unitSlug: uDir,
            turmaSlug: tDir,
            id: name,
            name,
            link: `/uploads/${uDir}/${tDir}/${encodeURIComponent(name)}`,
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
app.post('/api/zip', (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!mode) return res.status(400).json({ error: 'mode é obrigatório (unit, turma ou selection)' });

    // Resolve lista de arquivos absolutos
    const collected = []; // { abs, rel } — rel é o caminho dentro do ZIP
    if (mode === 'unit') {
      const { unitName } = req.body;
      if (!unitName) return res.status(400).json({ error: 'unitName é obrigatório' });
      const unitDir = path.join(UPLOADS_DIR, slug(unitName));
      if (!fs.existsSync(unitDir)) return res.status(404).json({ error: 'Unidade sem desenhos enviados' });
      const turmas = fs.readdirSync(unitDir).filter(n => !n.startsWith('.'));
      for (const t of turmas) {
        const tDir = path.join(unitDir, t);
        if (!fs.statSync(tDir).isDirectory()) continue;
        for (const f of fs.readdirSync(tDir).filter(n => !n.startsWith('.'))) {
          const abs = path.join(tDir, f);
          if (fs.statSync(abs).isFile()) collected.push({ abs, rel: path.join(t, f) });
        }
      }
    } else if (mode === 'turma') {
      const { unitName, turma } = req.body;
      if (!unitName || !turma) return res.status(400).json({ error: 'unitName e turma são obrigatórios' });
      const tDir = path.join(UPLOADS_DIR, slug(unitName), slug(turma));
      if (!fs.existsSync(tDir)) return res.status(404).json({ error: 'Turma sem desenhos enviados' });
      for (const f of fs.readdirSync(tDir).filter(n => !n.startsWith('.'))) {
        const abs = path.join(tDir, f);
        if (fs.statSync(abs).isFile()) collected.push({ abs, rel: f });
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
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
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
app.delete('/api/files/:unitName/:turma/:fileName', (req, res) => {
  try {
    const { unitName, turma, fileName } = req.params;
    const target = path.join(UPLOADS_DIR, slug(unitName), slug(turma), path.basename(fileName));
    if (!target.startsWith(UPLOADS_DIR)) return res.status(400).json({ error: 'Caminho inválido' });
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Arquivo não encontrado' });
    fs.unlinkSync(target);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══ PROFESSORES — CRUD ═══

// Listar todos (para o painel admin)
app.get('/api/professors', (req, res) => {
  const profs = loadProfessors();
  // Não expor senha no listing
  res.json(profs.map(p => ({ ...p, password: '***' })));
});

// Criar professor
app.post('/api/professors', (req, res) => {
  const { name, password, unit, turmas } = req.body;
  if (!name || !password || !unit || !turmas || !turmas.length) {
    return res.status(400).json({ error: 'Campos obrigatórios: name, password, unit, turmas[]' });
  }
  const profs = loadProfessors();
  const prof = {
    id: genId(),
    name,
    password,
    unit,
    turmas, // array de turmas: ["Grupo 2", "Grupo 3"]
    createdAt: new Date().toISOString()
  };
  profs.push(prof);
  saveProfessors(profs);
  res.json({ success: true, professor: { ...prof, password: '***' } });
});

// Atualizar professor
app.put('/api/professors/:id', (req, res) => {
  const profs = loadProfessors();
  const idx = profs.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Professor não encontrado' });

  const { name, password, unit, turmas } = req.body;
  if (name) profs[idx].name = name;
  if (password) profs[idx].password = password;
  if (unit) profs[idx].unit = unit;
  if (turmas) profs[idx].turmas = turmas;

  saveProfessors(profs);
  res.json({ success: true, professor: { ...profs[idx], password: '***' } });
});

// Deletar professor
app.delete('/api/professors/:id', (req, res) => {
  let profs = loadProfessors();
  profs = profs.filter(p => p.id !== req.params.id);
  saveProfessors(profs);
  res.json({ success: true });
});

// ═══ ALUNOS — TEXTOS E STATUS (compartilhado entre todos os usuários) ═══

// Retorna todos os dados de alunos salvos no servidor
app.get('/api/students', (req, res) => {
  res.json({ success: true, students: loadStudentData() });
});

// Salva/atualiza o texto e status de um aluno.
// Body: { unit, turma, name, storyText?, status?, hasDrawing?, textReviewed?, pdfGenerated? }
app.post('/api/students/save', (req, res) => {
  try {
    const { unit, turma, name } = req.body;
    if (!unit || !turma || !name) {
      return res.status(400).json({ error: 'unit, turma e name são obrigatórios' });
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
    saveStudentData(data);
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

app.post('/api/admin/migrate-student-keys', (req, res) => {
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
      if (fs.existsSync(STUDENTS_FILE)) fs.copyFileSync(STUDENTS_FILE, bak);
      result.backup = path.basename(bak);
    } catch(e) { result.backupError = e.message; }
    saveStudentData(next);
    result.applied = true;
  } else {
    result.applied = false;
  }
  res.json(result);
});

// ═══ LOGIN DO PROFESSOR ═══
app.post('/api/professor/login', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: 'Informe nome e senha' });
  }
  const profs = loadProfessors();
  const prof = profs.find(p =>
    p.name.toLowerCase() === name.toLowerCase() && p.password === password
  );
  if (!prof) {
    return res.status(401).json({ error: 'Nome ou senha incorretos' });
  }
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
initDrive();
app.listen(PORT, () => {
  console.log(`FLIPED server rodando na porta ${PORT}`);
  console.log(`Google Drive: ${drive ? '✓ Conectado' : '✗ Não configurado'}`);
  if (DRIVE_ROOT_FOLDER) console.log(`Pasta raiz: ${DRIVE_ROOT_FOLDER}`);
});
