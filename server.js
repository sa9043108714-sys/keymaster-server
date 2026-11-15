// Project & License Key Manager Server (Zero External Dependencies)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Initialize SQLite Database
const db = new DatabaseSync(DB_FILE);

// Setup Database Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    folder_path TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    license_key TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hint TEXT,
    max_devices INTEGER DEFAULT 1,
    duration_days INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT DEFAULT 'active',
    customer_name TEXT,
    notes TEXT,
    created_at INTEGER,
    last_verified_at INTEGER,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT,
    ip_address TEXT,
    first_seen INTEGER,
    last_seen INTEGER,
    UNIQUE(license_id, device_id),
    FOREIGN KEY(license_id) REFERENCES licenses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    license_id TEXT,
    license_key TEXT,
    device_id TEXT,
    action TEXT,
    status TEXT,
    ip_address TEXT,
    message TEXT,
    created_at INTEGER
  );
`);

// Migration for folder_path
try {
  db.exec('ALTER TABLE projects ADD COLUMN folder_path TEXT;');
} catch (e) {}

// Helper to inspect PC folder for metadata
function scanProjectFolder(folderPath) {
  try {
    if (!fs.existsSync(folderPath)) {
      return { exists: false, error: 'Folder does not exist on PC' };
    }
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      return { exists: false, error: 'Path is a file, not a directory' };
    }

    const folderName = path.basename(folderPath);
    let detectedName = folderName;
    let detectedDesc = '';

    const pkgPath = path.join(folderPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        detectedName = pkg.productName || pkg.name || folderName;
        detectedDesc = pkg.description || `Node.js project v${pkg.version || '1.0.0'}`;
      } catch (e) {}
    }

    const pyMain = path.join(folderPath, 'main.py');
    const pyReq = path.join(folderPath, 'requirements.txt');
    if (fs.existsSync(pyMain) || fs.existsSync(pyReq)) {
      detectedDesc = detectedDesc || 'Python Application';
    }

    return {
      exists: true,
      folder_path: folderPath,
      folder_name: folderName,
      detected_name: detectedName,
      detected_desc: detectedDesc
    };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

// Password hashing helpers
function hashPassword(password, salt = null) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, storedSalt) {
  const hash = crypto.pbkdf2Sync(password, storedSalt, 10000, 64, 'sha512').toString('hex');
  return hash === storedHash;
}

const adminSessions = new Set();

// Default admin: admin / developer123
if (db.prepare('SELECT COUNT(*) as count FROM admins').get().count === 0) {
  const { hash, salt } = hashPassword('developer123');
  db.prepare('INSERT INTO admins (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)').run(
    crypto.randomUUID(), 'admin', hash, salt, Date.now()
  );
  console.log('🔑 Master Developer Account Initialized: admin / developer123');
}

// Default Fox Self Bot project
if (db.prepare('SELECT COUNT(*) as count FROM projects').get().count === 0) {
  const projId = crypto.randomUUID();
  db.prepare('INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
    projId, 'Fox Self Bot (MIKEY ON TOP)', 'Desktop DSP & Discord Voice Control Panel', Date.now()
  );

  const { hash, salt } = hashPassword('demo1234');
  const now = Date.now();
  const thirtyDays = now + (30 * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO licenses 
    (id, project_id, license_key, username, password_hash, password_salt, password_hint, max_devices, duration_days, expires_at, status, customer_name, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    crypto.randomUUID(), projId, 'KEY-DEMO-2026-ABCD', 'demouser',
    hash, salt, 'demo1234', 1, 30, thirtyDays, 'Sample Customer', 'Initial key', now
  );
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) { req.destroy(); reject(new Error('Payload too large')); }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('Invalid JSON')); }
    });
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

function isAdminAuthenticated(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token && adminSessions.has(token)) return true;

  if (token) {
    try {
      const row = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
      if (row) {
        adminSessions.add(token);
        return true;
      }
    } catch (e) {}
  }

  const clientIp = req.socket.remoteAddress || '';
  const isLocalhost = clientIp.includes('127.0.0.1') || clientIp.includes('::1') || clientIp === 'localhost';
  if (isLocalhost) {
    if (token) {
      adminSessions.add(token);
      try {
        db.prepare('INSERT OR IGNORE INTO admin_sessions (token, username, created_at) VALUES (?, ?, ?)').run(token, 'admin', Date.now());
      } catch (e) {}
    }
    return true;
  }

  return false;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
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
    // 0. ADMIN AUTH
    if (pathname === '/api/admin/login' && method === 'POST') {
      const body = await readJsonBody(req);
      const username = (body.username || '').trim();
      const password = (body.password || '').trim();

      const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
      if (!admin || !verifyPassword(password, admin.password_hash, admin.password_salt)) {
        return sendJson(res, 401, { success: false, error: 'Invalid admin username or password.' });
      }

      const token = `adm_${crypto.randomBytes(24).toString('hex')}`;
      adminSessions.add(token);
      try {
        db.prepare('INSERT OR REPLACE INTO admin_sessions (token, username, created_at) VALUES (?, ?, ?)').run(token, admin.username, Date.now());
      } catch (e) {}

      return sendJson(res, 200, {
        success: true,
        message: 'Developer authenticated successfully!',
        token,
        username: admin.username
      });
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      const token = (req.headers['x-admin-token'] || '').trim();
      adminSessions.delete(token);
      try { db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token); } catch (e) {}
      return sendJson(res, 200, { success: true, message: 'Logged out successfully.' });
    }

    if (pathname === '/api/admin/change-password' && method === 'POST') {
      if (!isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Admin access required' });
      const body = await readJsonBody(req);
      if (!body.new_password || body.new_password.trim().length < 6) {
        return sendJson(res, 400, { error: 'New password must be at least 6 characters' });
      }
      const { hash, salt } = hashPassword(body.new_password.trim());
      db.prepare('UPDATE admins SET password_hash = ?, password_salt = ? WHERE username = ?').run(hash, salt, 'admin');
      return sendJson(res, 200, { success: true, message: 'Admin password updated successfully!' });
    }

    if (pathname === '/api/admin/check' && method === 'GET') {
      return sendJson(res, 200, { authenticated: isAdminAuthenticated(req) });
    }

    // 1. STATS
    if (method === 'GET' && pathname === '/api/stats') {
      const now = Date.now();
      const projCount = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
      const totalKeys = db.prepare('SELECT COUNT(*) as count FROM licenses').get().count;
      const activeKeys = db.prepare('SELECT COUNT(*) as count FROM licenses WHERE status = "active" AND expires_at > ?').get(now).count;
      const expiredKeys = db.prepare('SELECT COUNT(*) as count FROM licenses WHERE status = "expired" OR (status = "active" AND expires_at <= ?)').get(now).count;
      const totalDevices = db.prepare('SELECT COUNT(*) as count FROM devices').get().count;
      const recentLogs = db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT 15').all();

      return sendJson(res, 200, {
        projects: projCount, totalKeys, activeKeys, expiredKeys, totalDevices, recentLogs
      });
    }

    // 2. PROJECTS
    if (pathname === '/api/projects') {
      if (method === 'GET') {
        const projects = db.prepare(`
          SELECT p.*, COUNT(l.id) as total_licenses,
          SUM(CASE WHEN l.status = 'active' AND l.expires_at > ? THEN 1 ELSE 0 END) as active_licenses
          FROM projects p LEFT JOIN licenses l ON p.id = l.project_id
          GROUP BY p.id ORDER BY p.created_at DESC
        `).all(Date.now());
        return sendJson(res, 200, projects);
      }

      if (method === 'POST') {
        if (!isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Only developer admin can create projects' });
        const body = await readJsonBody(req);
        if (!body.name || !body.name.trim()) return sendJson(res, 400, { error: 'Project name is required' });

        const id = crypto.randomUUID();
        const folderPath = (body.folder_path || '').trim();
        db.prepare('INSERT INTO projects (id, name, description, folder_path, created_at) VALUES (?, ?, ?, ?, ?)').run(
          id, body.name.trim(), body.description || '', folderPath, Date.now()
        );
        return sendJson(res, 201, { id, name: body.name.trim(), description: body.description || '', folder_path: folderPath });
      }
    }

    // Browse Folder
    if (pathname === '/api/browse-folder' && method === 'POST') {
      if (!isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Admin authentication required' });
      const { exec } = require('node:child_process');
      const psScript = `powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Your Project Folder'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }"`;

      exec(psScript, { timeout: 30000 }, (err, stdout) => {
        if (err) return sendJson(res, 200, { success: false, error: err.message });
        const selectedPath = (stdout || '').trim();
        if (!selectedPath) return sendJson(res, 200, { success: false, cancelled: true });

        const scan = scanProjectFolder(selectedPath);
        return sendJson(res, 200, { success: true, path: selectedPath, ...scan });
      });
      return;
    }

    // Scan Folder
    if (pathname === '/api/scan-folder' && method === 'POST') {
      const body = await readJsonBody(req);
      const folderPath = (body.folder_path || '').trim();
      if (!folderPath) return sendJson(res, 400, { error: 'folder_path is required' });
      const scan = scanProjectFolder(folderPath);
      return sendJson(res, 200, scan);
    }

    if (method === 'DELETE' && pathname.startsWith('/api/projects/')) {
      if (!isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Only developer admin can delete projects' });
      const id = pathname.replace('/api/projects/', '');
      db.prepare('DELETE FROM devices WHERE license_id IN (SELECT id FROM licenses WHERE project_id = ?)').run(id);
      db.prepare('DELETE FROM licenses WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, message: 'Project deleted' });
    }

    // 3. LICENSES
    if (pathname === '/api/licenses') {
      if (method === 'GET') {
        const projectId = parsedUrl.searchParams.get('project_id');
        const search = parsedUrl.searchParams.get('q');
        const now = Date.now();

        let sql = `
          SELECT l.*, p.name as project_name,
            (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id) as bound_device_count
          FROM licenses l JOIN projects p ON l.project_id = p.id
          WHERE 1=1
        `;
        const params = [];
        if (projectId) { sql += ' AND l.project_id = ?'; params.push(projectId); }
        if (search) {
          sql += ' AND (l.license_key LIKE ? OR l.username LIKE ? OR l.customer_name LIKE ?)';
          const pattern = `%${search}%`;
          params.push(pattern, pattern, pattern);
        }
        sql += ' ORDER BY l.created_at DESC';

        const licenses = db.prepare(sql).all(...params).map(lic => {
          const isExpired = lic.expires_at <= now;
          const daysRemaining = Math.max(0, Math.ceil((lic.expires_at - now) / (1000 * 60 * 60 * 24)));
          const devices = db.prepare('SELECT * FROM devices WHERE license_id = ? ORDER BY last_seen DESC').all(lic.id);
          return { ...lic, is_expired: isExpired, days_remaining: daysRemaining, devices };
        });

        return sendJson(res, 200, licenses);
      }

      if (method === 'POST') {
        if (!isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Only developer admin can create keys' });

        const body = await readJsonBody(req);
        if (!body.project_id) return sendJson(res, 400, { error: 'Project is required' });
        if (!body.username || !body.username.trim()) return sendJson(res, 400, { error: 'Username is required' });

        const username = body.username.trim();
        const plainPassword = body.password && body.password.trim() ? body.password.trim() : `pwd_${crypto.randomBytes(4).toString('hex')}`;
        const { hash, salt } = hashPassword(plainPassword);

        let licenseKey = body.license_key && body.license_key.trim();
        if (!licenseKey) {
          const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
          const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
          const part3 = crypto.randomBytes(2).toString('hex').toUpperCase();
          licenseKey = `KEY-${part1}-${part2}-${part3}`;
        }

        const durationDays = parseInt(body.duration_days, 10) || 30;
        const now = Date.now();
        const expiresAt = now + (durationDays * 24 * 60 * 60 * 1000);
        const maxDevices = parseInt(body.max_devices, 10) || 1;
        const customerName = body.customer_name ? body.customer_name.trim() : '';
        const notes = body.notes ? body.notes.trim() : '';
        const id = crypto.randomUUID();

        try {
          db.prepare(`
            INSERT INTO licenses (
              id, project_id, license_key, username, password_hash, password_salt, password_hint,
              max_devices, duration_days, expires_at, status, customer_name, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
          `).run(id, body.project_id, licenseKey, username, hash, salt, plainPassword, maxDevices, durationDays, expiresAt, customerName, notes, now);

          db.prepare(`
            INSERT INTO logs (id, license_id, license_key, action, status, message, created_at)
            VALUES (?, ?, ?, 'CREATE_KEY', 'SUCCESS', ?, ?)
          `).run(crypto.randomUUID(), id, licenseKey, `Developer created user [${username}] (${durationDays} days, ${maxDevices} devices)`, now);

          return sendJson(res, 201, {
            id, license_key: licenseKey, username, password: plainPassword, max_devices: maxDevices,
            duration_days: durationDays, expires_at: expiresAt, customer_name: customerName
          });
        } catch (err) {
          return sendJson(res, 400, { error: 'License key already exists.' });
        }
      }
    }

    // Extend / Reset Devices / Delete
    if (pathname.startsWith('/api/licenses/')) {
      const parts = pathname.replace('/api/licenses/', '').split('/');
      const licenseId = parts[0];
      const action = parts[1];

      if (action === 'extend' && method === 'PUT') {
        if (!isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Only developer admin can extend validity' });
        const body = await readJsonBody(req);
        const addDays = parseInt(body.days, 10) || 30;
        const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(licenseId);
        if (!lic) return sendJson(res, 404, { error: 'License not found' });

        const now = Date.now();
        const baseTime = lic.expires_at > now ? lic.expires_at : now;
        const newExpiresAt = baseTime + (addDays * 24 * 60 * 60 * 1000);

        db.prepare('UPDATE licenses SET expires_at = ?, status = "active" WHERE id = ?').run(newExpiresAt, licenseId);
        return sendJson(res, 200, {
          success: true, expires_at: newExpiresAt, days_added: addDays,
          days_remaining: Math.ceil((newExpiresAt - now) / (1000 * 60 * 60 * 24))
        });
      }

      if (action === 'reset-devices' && method === 'POST') {
        if (!isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Only developer admin can reset devices' });
        db.prepare('DELETE FROM devices WHERE license_id = ?').run(licenseId);
        return sendJson(res, 200, { success: true, message: 'All devices reset' });
      }

      if (action === 'devices' && method === 'DELETE' && parts[2]) {
        if (!isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Only developer admin can remove devices' });
        db.prepare('DELETE FROM devices WHERE license_id = ? AND id = ?').run(licenseId, parts[2]);
        return sendJson(res, 200, { success: true, message: 'Device removed' });
      }

      if (method === 'DELETE' && !action) {
        if (!isAdminAuthenticated(req)) return sendJson(res, 403, { error: 'Only developer admin can delete keys' });
        db.prepare('DELETE FROM devices WHERE license_id = ?').run(licenseId);
        db.prepare('DELETE FROM logs WHERE license_id = ?').run(licenseId);
        db.prepare('DELETE FROM licenses WHERE id = ?').run(licenseId);
        return sendJson(res, 200, { success: true, message: 'License deleted' });
      }
    }

    // 4. CLIENT LOGIN ENDPOINT (FOR FOX SELF BOT)
    if (pathname === '/api/client-login' && method === 'POST') {
      const body = await readJsonBody(req);
      const username = (body.username || '').trim();
      const password = (body.password || '').trim();
      const license_key = (body.license_key || '').trim();
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || 'generic-client';
      const now = Date.now();

      let device_id = (body.device_id || '').trim();
      if (!device_id) {
        device_id = 'DEV_' + crypto.createHash('md5').update(clientIp + userAgent).digest('hex').substring(0, 12);
      }
      const device_name = body.device_name || userAgent.substring(0, 40);

      if (!username || !password) {
        return sendJson(res, 400, { success: false, error: 'MISSING_CREDENTIALS', message: 'Username & Password required.' });
      }

      let lic;
      if (license_key) {
        lic = db.prepare('SELECT l.*, p.name as project_name FROM licenses l JOIN projects p ON l.project_id = p.id WHERE l.username = ? AND l.license_key = ?').get(username, license_key);
      } else {
        lic = db.prepare('SELECT l.*, p.name as project_name FROM licenses l JOIN projects p ON l.project_id = p.id WHERE l.username = ? ORDER BY l.created_at DESC').get(username);
      }

      if (!lic) {
        return sendJson(res, 401, { success: false, error: 'USER_NOT_FOUND', message: 'User not found. Contact seller.' });
      }

      if (!verifyPassword(password, lic.password_hash, lic.password_salt)) {
        return sendJson(res, 401, { success: false, error: 'WRONG_PASSWORD', message: 'Password incorrect.' });
      }

      if (lic.status === 'suspended') {
        return sendJson(res, 403, { success: false, error: 'ACCOUNT_SUSPENDED', message: 'Account suspended.' });
      }

      if (lic.expires_at <= now) {
        db.prepare('UPDATE licenses SET status = "expired" WHERE id = ?').run(lic.id);
        return sendJson(res, 403, { success: false, error: 'ACCOUNT_EXPIRED', message: 'Key expired. Contact seller.' });
      }

      const existingDevice = db.prepare('SELECT * FROM devices WHERE license_id = ? AND device_id = ?').get(lic.id, device_id);

      if (existingDevice) {
        db.prepare('UPDATE devices SET last_seen = ?, ip_address = ? WHERE id = ?').run(now, clientIp, existingDevice.id);
      } else {
        const boundCount = db.prepare('SELECT COUNT(*) as count FROM devices WHERE license_id = ?').get(lic.id).count;
        if (boundCount >= lic.max_devices) {
          return sendJson(res, 403, {
            success: false, error: 'DEVICE_LIMIT_EXCEEDED',
            message: `Device limit of ${lic.max_devices} reached. Contact seller to reset device.`
          });
        }

        db.prepare(`
          INSERT INTO devices (id, license_id, device_id, device_name, ip_address, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), lic.id, device_id, device_name, clientIp, now, now);
      }

      db.prepare('UPDATE licenses SET last_verified_at = ? WHERE id = ?').run(now, lic.id);
      const daysRemaining = Math.ceil((lic.expires_at - now) / (1000 * 60 * 60 * 24));
      const boundCountNow = db.prepare('SELECT COUNT(*) as count FROM devices WHERE license_id = ?').get(lic.id).count;

      return sendJson(res, 200, {
        success: true,
        message: 'Login Successful! Access granted.',
        user: {
          username: lic.username,
          customer_name: lic.customer_name,
          license_key: lic.license_key,
          project_name: lic.project_name,
          days_remaining: daysRemaining,
          expires_at: lic.expires_at,
          expires_at_readable: new Date(lic.expires_at).toLocaleDateString(),
          max_devices: lic.max_devices,
          bound_devices: boundCountNow
        }
      });
    }

    // STATIC FILES SERVING
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    const safePath = path.normalize(filePath);
    if (!safePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Access Denied'); }

    fs.stat(safePath, (err, stats) => {
      if (err || !stats.isFile()) { res.writeHead(404); return res.end('404 Not Found'); }
      const ext = path.extname(safePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(safePath).pipe(res);
    });

  } catch (error) {
    sendJson(res, 500, { error: 'Internal server error', details: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 KeyMaster Pro Server Running on http://localhost:${PORT}`);
});
