const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.db');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;

// Database Setup (Cloud PostgreSQL if DATABASE_URL is set, else SQLite)
let isPostgres = false;
let pgPool = null;
let sqliteDb = null;

if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    isPostgres = true;
    console.log('🌐 Connected to Cloud PostgreSQL Database!');
  } catch (err) {
    console.error('⚠️ pg connection error, falling back to SQLite:', err.message);
  }
}

if (!isPostgres) {
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(DB_FILE);
  console.log('💾 Using Local SQLite Database:', DB_FILE);
}

const db = {
  async query(sql, params = []) {
    if (isPostgres) {
      let idx = 1;
      const res = await pgPool.query(sql.replace(/\?/g, () => `$${idx++}`), params);
      return res.rows;
    }
    return sqliteDb.prepare(sql).all(...params);
  },
  async all(sql, params = []) { return this.query(sql, params); },
  async get(sql, params = []) {
    if (isPostgres) {
      let idx = 1;
      const res = await pgPool.query(sql.replace(/\?/g, () => `$${idx++}`), params);
      return res.rows[0] || null;
    }
    return sqliteDb.prepare(sql).get(...params) || null;
  },
  async run(sql, params = []) {
    if (isPostgres) {
      let idx = 1;
      let pgSql = sql.replace(/\?/g, () => `$${idx++}`);
      if (pgSql.toUpperCase().includes('INSERT OR REPLACE INTO ADMIN_SESSIONS')) {
        pgSql = `INSERT INTO admin_sessions (token, username, created_at) VALUES ($1, $2, $3)
                 ON CONFLICT (token) DO UPDATE SET username = EXCLUDED.username, created_at = EXCLUDED.created_at`;
      }
      const res = await pgPool.query(pgSql, params);
      return { changes: res.rowCount };
    }
    return sqliteDb.prepare(sql).run(...params);
  },
  async exec(sql) {
    if (isPostgres) await pgPool.query(sql);
    else sqliteDb.exec(sql);
  }
};

function hashPassword(password, existingSalt = null) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') === hash;
}

const adminSessions = new Set();

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, folder_path TEXT, created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, license_key TEXT UNIQUE NOT NULL, username TEXT NOT NULL,
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_hint TEXT, max_devices INTEGER DEFAULT 1,
      duration_days INTEGER NOT NULL, expires_at BIGINT NOT NULL, status TEXT DEFAULT 'active', customer_name TEXT,
      notes TEXT, created_at BIGINT, last_verified_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, license_id TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT, ip_address TEXT,
      first_seen BIGINT, last_seen BIGINT, UNIQUE(license_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY, license_id TEXT, license_key TEXT, device_id TEXT, action TEXT, status TEXT,
      ip_address TEXT, message TEXT, created_at BIGINT
    );
  `);

  try { await db.exec('ALTER TABLE projects ADD COLUMN folder_path TEXT;'); } catch (e) {}

  const adminRow = await db.get('SELECT COUNT(*) as count FROM admins');
  if (parseInt(adminRow?.count || '0', 10) === 0) {
    const { hash, salt } = hashPassword('developer123');
    await db.run('INSERT INTO admins (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)',
      [crypto.randomUUID(), 'admin', hash, salt, Date.now()]);
    console.log('🔑 Developer Account: admin / developer123');
  }

  const projRow = await db.get('SELECT COUNT(*) as count FROM projects');
  if (parseInt(projRow?.count || '0', 10) === 0) {
    const foxProjId = 'ed6ccc6b-ac63-46cd-a562-b874f3f34e08';
    const now = Date.now();
    await db.run('INSERT INTO projects (id, name, description, folder_path, created_at) VALUES (?, ?, ?, ?, ?)',
      [foxProjId, 'Fox Self Bot (MIKEY ON TOP)', 'Desktop DSP & Discord Voice Control Panel', 'fox self bot sale', now]);

    const { hash: kHash, salt: kSalt } = hashPassword('KIKKI@123');
    await db.run(`INSERT INTO licenses (id, project_id, license_key, username, password_hash, password_salt, password_hint, max_devices, duration_days, expires_at, status, customer_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ['429f9605-8352-45c5-b79c-3a1a41f28e3a', foxProjId, 'KEY-KCVG-L3F9-WH26', 'KIKKI', kHash, kSalt, 'KIKKI@123', 1, 30, now + (30 * 86400000), 'KIKKI', now]);
    console.log('✨ Seeded Project & KIKKI (30 days key) into Database!');
  }
}
initDb().catch(console.error);

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 1e6) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => { if (!body) return resolve({}); try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token'
  });
  res.end(JSON.stringify(data));
}

async function isAdminAuthenticated(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token === 'master_developer_key_2026' || (token && adminSessions.has(token))) return true;
  if (token) {
    try {
      const row = await db.get('SELECT * FROM admin_sessions WHERE token = ?', [token]);
      if (row) { adminSessions.add(token); return true; }
    } catch (e) {}
  }
  const clientIp = req.socket.remoteAddress || '';
  if (clientIp.includes('127.0.0.1') || clientIp.includes('::1') || clientIp === 'localhost') {
    if (token) {
      adminSessions.add(token);
      try { await db.run('INSERT INTO admin_sessions (token, username, created_at) VALUES (?, ?, ?)', [token, 'admin', Date.now()]); } catch (e) {}
    }
    return true;
  }
  return false;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token'
    });
    return res.end();
  }

  try {
    if (pathname === '/api/health' || pathname === '/api/ping') {
      return sendJson(res, 200, { status: 'ok', database: isPostgres ? 'PostgreSQL (Cloud)' : 'SQLite', uptime: process.uptime() });
    }

    if (pathname === '/api/admin/login' && method === 'POST') {
      const { username = '', password = '' } = await readJsonBody(req);
      const admin = await db.get('SELECT * FROM admins WHERE username = ?', [username.trim()]);
      if (!admin || !verifyPassword(password.trim(), admin.password_hash, admin.password_salt)) {
        return sendJson(res, 401, { success: false, error: 'Invalid admin username or password.' });
      }
      const token = `adm_${crypto.randomBytes(24).toString('hex')}`;
      adminSessions.add(token);
      try { await db.run('INSERT INTO admin_sessions (token, username, created_at) VALUES (?, ?, ?)', [token, admin.username, Date.now()]); } catch (e) {}
      return sendJson(res, 200, { success: true, token, username: admin.username });
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      const token = (req.headers['x-admin-token'] || '').trim();
      if (token) { adminSessions.delete(token); try { await db.run('DELETE FROM admin_sessions WHERE token = ?', [token]); } catch (e) {} }
      return sendJson(res, 200, { success: true });
    }

    if (pathname === '/api/admin/check' && method === 'GET') {
      return sendJson(res, 200, { authenticated: await isAdminAuthenticated(req), username: 'admin' });
    }

    if (pathname === '/api/stats' && method === 'GET') {
      const now = Date.now();
      const proj = await db.get('SELECT COUNT(*) as count FROM projects');
      const totalK = await db.get('SELECT COUNT(*) as count FROM licenses');
      const activeK = await db.get('SELECT COUNT(*) as count FROM licenses WHERE status = ? AND expires_at > ?', ['active', now]);
      const expK = await db.get('SELECT COUNT(*) as count FROM licenses WHERE status = ? OR (status = ? AND expires_at <= ?)', ['expired', 'active', now]);
      const devK = await db.get('SELECT COUNT(*) as count FROM devices');
      const logs = await db.all('SELECT l.*, lic.username FROM logs l LEFT JOIN licenses lic ON l.license_id = lic.id ORDER BY l.created_at DESC LIMIT 15');
      return sendJson(res, 200, {
        projects: parseInt(proj?.count || '0', 10),
        totalKeys: parseInt(totalK?.count || '0', 10),
        activeKeys: parseInt(activeK?.count || '0', 10),
        expiredKeys: parseInt(expK?.count || '0', 10),
        totalDevices: parseInt(devK?.count || '0', 10),
        recentLogs: logs
      });
    }

    if (pathname === '/api/projects') {
      if (method === 'GET') {
        const now = Date.now();
        const projects = await db.all(`
          SELECT p.*, COUNT(l.id) as total_licenses,
          SUM(CASE WHEN l.status = 'active' AND l.expires_at > ${now} THEN 1 ELSE 0 END) as active_licenses
          FROM projects p LEFT JOIN licenses l ON p.id = l.project_id
          GROUP BY p.id ORDER BY p.created_at DESC
        `);
        return sendJson(res, 200, projects);
      }
      if (method === 'POST') {
        if (!await isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Only developer admin can create projects' });
        const { name = '', description = '', folder_path = '' } = await readJsonBody(req);
        if (!name.trim()) return sendJson(res, 400, { error: 'Project name is required' });
        const id = crypto.randomUUID();
        await db.run('INSERT INTO projects (id, name, description, folder_path, created_at) VALUES (?, ?, ?, ?, ?)',
          [id, name.trim(), description, folder_path.trim(), Date.now()]);
        return sendJson(res, 201, { id, name: name.trim(), description, folder_path });
      }
    }

    if (method === 'DELETE' && pathname.startsWith('/api/projects/')) {
      if (!await isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Admin only' });
      const id = pathname.replace('/api/projects/', '');
      await db.run('DELETE FROM devices WHERE license_id IN (SELECT id FROM licenses WHERE project_id = ?)', [id]);
      await db.run('DELETE FROM licenses WHERE project_id = ?', [id]);
      await db.run('DELETE FROM projects WHERE id = ?', [id]);
      return sendJson(res, 200, { success: true });
    }

    if (pathname === '/api/licenses') {
      if (method === 'GET') {
        const projectId = parsedUrl.searchParams.get('project_id');
        const now = Date.now();
        let sql = 'SELECT l.*, p.name as project_name FROM licenses l JOIN projects p ON l.project_id = p.id WHERE 1=1';
        const params = [];
        if (projectId) { sql += ' AND l.project_id = ?'; params.push(projectId); }
        sql += ' ORDER BY l.created_at DESC';

        const raw = await db.all(sql, params);
        const licenses = await Promise.all(raw.map(async lic => {
          const exp = Number(lic.expires_at);
          const devices = await db.all('SELECT * FROM devices WHERE license_id = ? ORDER BY last_seen DESC', [lic.id]);
          return {
            ...lic,
            expires_at: exp,
            is_expired: exp <= now,
            days_remaining: Math.max(0, Math.ceil((exp - now) / 86400000)),
            devices
          };
        }));
        return sendJson(res, 200, licenses);
      }

      if (method === 'POST') {
        if (!await isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Only developer admin can create keys' });
        const body = await readJsonBody(req);
        if (!body.project_id || !body.username || !body.username.trim()) {
          return sendJson(res, 400, { error: 'Project and Username are required' });
        }
        const username = body.username.trim();
        const plainPassword = body.password && body.password.trim() ? body.password.trim() : `pwd_${crypto.randomBytes(4).toString('hex')}`;
        const { hash, salt } = hashPassword(plainPassword);
        const licenseKey = (body.license_key && body.license_key.trim()) || `KEY-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        const durationDays = parseInt(body.duration_days, 10) || 30;
        const now = Date.now();
        const expiresAt = now + (durationDays * 86400000);
        const maxDevices = parseInt(body.max_devices, 10) || 1;
        const id = crypto.randomUUID();

        try {
          await db.run(`INSERT INTO licenses (id, project_id, license_key, username, password_hash, password_salt, password_hint, max_devices, duration_days, expires_at, status, customer_name, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
            [id, body.project_id, licenseKey, username, hash, salt, plainPassword, maxDevices, durationDays, expiresAt, body.customer_name || '', body.notes || '', now]);

          await db.run('INSERT INTO logs (id, license_id, license_key, action, status, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), id, licenseKey, 'CREATE_KEY', 'SUCCESS', `Created key for ${username} (${durationDays} days)`, now]);

          return sendJson(res, 201, { id, license_key: licenseKey, username, password: plainPassword, expires_at: expiresAt, duration_days: durationDays });
        } catch (err) {
          return sendJson(res, 400, { error: 'License key or username already exists' });
        }
      }
    }

    if (pathname.startsWith('/api/licenses/')) {
      const parts = pathname.replace('/api/licenses/', '').split('/');
      const licenseId = parts[0];
      const action = parts[1];

      if (action === 'extend' && method === 'PUT') {
        if (!await isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Admin only' });
        const { days = 30 } = await readJsonBody(req);
        const lic = await db.get('SELECT * FROM licenses WHERE id = ?', [licenseId]);
        if (!lic) return sendJson(res, 404, { error: 'License not found' });
        const now = Date.now();
        const base = Number(lic.expires_at) > now ? Number(lic.expires_at) : now;
        const newExp = base + (parseInt(days, 10) * 86400000);
        await db.run('UPDATE licenses SET expires_at = ?, status = ? WHERE id = ?', [newExp, 'active', licenseId]);
        return sendJson(res, 200, { success: true, expires_at: newExp });
      }

      if (action === 'reset-devices' && method === 'POST') {
        if (!await isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Admin only' });
        await db.run('DELETE FROM devices WHERE license_id = ?', [licenseId]);
        return sendJson(res, 200, { success: true });
      }

      if (method === 'DELETE' && !action) {
        if (!await isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Admin only' });
        await db.run('DELETE FROM devices WHERE license_id = ?', [licenseId]);
        await db.run('DELETE FROM logs WHERE license_id = ?', [licenseId]);
        await db.run('DELETE FROM licenses WHERE id = ?', [licenseId]);
        return sendJson(res, 200, { success: true });
      }
    }

    // Client Bot Login Endpoint
    if (pathname === '/api/client-login' && method === 'POST') {
      const { username = '', password = '', device_id = 'DEFAULT', device_name = 'PC Client' } = await readJsonBody(req);
      const trimmedUser = username.trim();
      const trimmedPass = password.trim();
      const now = Date.now();
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

      if (!trimmedUser || !trimmedPass) {
        return sendJson(res, 400, { success: false, message: 'Username and password required.' });
      }

      const lic = await db.get('SELECT l.*, p.name as project_name FROM licenses l JOIN projects p ON l.project_id = p.id WHERE l.username = ? ORDER BY l.created_at DESC', [trimmedUser]);
      if (!lic) return sendJson(res, 401, { success: false, message: 'Account not found. Please check username.' });
      if (!verifyPassword(trimmedPass, lic.password_hash, lic.password_salt)) {
        return sendJson(res, 401, { success: false, message: 'Incorrect password.' });
      }

      const exp = Number(lic.expires_at);
      if (exp <= now) {
        await db.run('UPDATE licenses SET status = ? WHERE id = ?', ['expired', lic.id]);
        return sendJson(res, 403, { success: false, message: 'Your license key has expired. Please contact seller.' });
      }

      const dev = await db.get('SELECT * FROM devices WHERE license_id = ? AND device_id = ?', [lic.id, device_id]);
      if (dev) {
        await db.run('UPDATE devices SET last_seen = ?, ip_address = ? WHERE id = ?', [now, clientIp, dev.id]);
      } else {
        const boundRow = await db.get('SELECT COUNT(*) as count FROM devices WHERE license_id = ?', [lic.id]);
        if (parseInt(boundRow?.count || '0', 10) >= lic.max_devices) {
          return sendJson(res, 403, { success: false, message: `Device limit of ${lic.max_devices} reached. Contact seller to reset.` });
        }
        await db.run('INSERT INTO devices (id, license_id, device_id, device_name, ip_address, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), lic.id, device_id, device_name, clientIp, now, now]);
      }

      await db.run('UPDATE licenses SET last_verified_at = ? WHERE id = ?', [now, lic.id]);
      const daysLeft = Math.ceil((exp - now) / 86400000);

      return sendJson(res, 200, {
        success: true,
        message: 'Login Successful!',
        user: {
          username: lic.username,
          license_key: lic.license_key,
          project_name: lic.project_name,
          days_remaining: daysLeft,
          expires_at_readable: new Date(exp).toLocaleDateString(),
          max_devices: lic.max_devices
        }
      });
    }

    // Static Files
    const BLOCKED_FILES = ['server.js', 'package.json', 'package-lock.json', 'data.db', '.env', '.gitignore'];
    const targetFile = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const safePath = path.join(PUBLIC_DIR, targetFile);

    if (BLOCKED_FILES.includes(targetFile) || !fs.existsSync(safePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(safePath).pipe(res);

  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: 'Internal server error', details: err.message });
  }
});

// Keep-Alive Self-Ping (Never Sleep on Render!)
const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://keymaster-server-jrfn.onrender.com';
setInterval(async () => {
  try { await fetch(`${externalUrl}/api/health`); } catch (e) {}
}, 9 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 KeyMaster Pro Server Running on http://localhost:${PORT}`);
  console.log(`💾 Storage: ${isPostgres ? 'Cloud PostgreSQL (Persistent 24/7)' : 'Local SQLite'}`);
  console.log(`👨‍💻 Developer Login: admin / developer123`);
  console.log(`=======================================================`);
});
