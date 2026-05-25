const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const stream = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══ MULTER (temp upload) ═══
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de arquivo não permitido. Use PDF, JPG, PNG ou WebP.'));
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
function studentKey(unit, turma, name) {
  return [unit, turma, name].map(v => String(v || '').trim().toLowerCase()).join('|');
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

// ═══ STATIC FILES ═══
app.use(express.static(path.join(__dirname, 'public')));
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
