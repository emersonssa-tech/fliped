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

// Gerar ID curto único
function genId() {
  return Math.random().toString(36).substring(2, 10);
}

// ═══ STATIC FILES ═══
app.use(express.static(path.join(__dirname, 'public')));
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

// ═══ UPLOAD INDIVIDUAL ═══
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!drive) return res.status(503).json({ error: 'Google Drive não configurado' });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const { studentName, studentId, turma, unitName, storyText } = req.body;
    if (!studentName || !turma || !unitName) {
      return res.status(400).json({ error: 'Dados do aluno incompletos' });
    }

    const folderId = await getStudentFolder(unitName, turma);
    const safeName = studentName.replace(/[^a-zA-Z0-9À-ÿ\s]/g, '').replace(/\s+/g, '_');
    const ext = path.extname(req.file.originalname) || '.pdf';
    const fileName = `${safeName}_${studentId}${ext}`;

    const driveFile = await uploadToDrive(req.file.buffer, fileName, req.file.mimetype, folderId);

    res.json({
      success: true,
      file: {
        id: driveFile.id,
        name: driveFile.name,
        link: driveFile.webViewLink,
        downloadLink: driveFile.webContentLink,
        size: driveFile.size
      },
      studentId,
      storyText: storyText || ''
    });
  } catch (e) {
    console.error('Erro no upload:', e.message);
    res.status(500).json({ error: 'Falha no upload: ' + e.message });
  }
});

// ═══ UPLOAD EM LOTE ═══
app.post('/api/upload-batch', upload.array('files', 50), async (req, res) => {
  try {
    if (!drive) return res.status(503).json({ error: 'Google Drive não configurado' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const { turma, unitName, studentIds } = req.body;
    if (!turma || !unitName) {
      return res.status(400).json({ error: 'Dados da turma incompletos' });
    }

    const ids = JSON.parse(studentIds || '[]');
    const folderId = await getStudentFolder(unitName, turma);

    const results = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const studentId = ids[i] || `batch_${i}`;
      const ext = path.extname(file.originalname) || '.pdf';
      const fileName = `${turma}_${String(i + 1).padStart(3, '0')}_${studentId}${ext}`;

      const driveFile = await uploadToDrive(file.buffer, fileName, file.mimetype, folderId);
      results.push({
        index: i,
        studentId,
        fileId: driveFile.id,
        link: driveFile.webViewLink,
        name: driveFile.name
      });
    }

    res.json({ success: true, uploaded: results.length, files: results });
  } catch (e) {
    console.error('Erro no upload em lote:', e.message);
    res.status(500).json({ error: 'Falha no upload em lote: ' + e.message });
  }
});

// ═══ LISTAR ARQUIVOS DE UMA PASTA (turma) ═══
app.get('/api/files/:unitName/:turma', async (req, res) => {
  try {
    if (!drive) return res.status(503).json({ error: 'Google Drive não configurado' });

    const { unitName, turma } = req.params;
    const folderId = await getStudentFolder(unitName, turma);

    const list = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, webViewLink, size, createdTime, mimeType)',
      orderBy: 'name',
      pageSize: 200
    });

    res.json({ success: true, files: list.data.files });
  } catch (e) {
    console.error('Erro ao listar arquivos:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══ DELETAR ARQUIVO DO DRIVE ═══
app.delete('/api/files/:fileId', async (req, res) => {
  try {
    if (!drive) return res.status(503).json({ error: 'Google Drive não configurado' });
    await drive.files.delete({ fileId: req.params.fileId });
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
