let currentLicenses = [];
let currentProjects = [];
let currentEditingLicenseId = null;
let adminToken = localStorage.getItem('keymaster_admin_token') || 'local_developer';

document.addEventListener('DOMContentLoaded', () => {
  checkAdminAuth();

  const daysSelect = document.getElementById('new-key-days');
  if (daysSelect) {
    daysSelect.addEventListener('change', (e) => {
      const customGroup = document.getElementById('custom-days-group');
      customGroup.style.display = e.target.value === 'custom' ? 'block' : 'none';
    });
  }
});

function checkAdminAuth() {
  if (adminToken) {
    document.getElementById('developer-login-screen').style.display = 'none';
    document.getElementById('developer-dashboard').style.display = 'block';
    loadAllData();
  } else {
    document.getElementById('developer-login-screen').style.display = 'flex';
    document.getElementById('developer-dashboard').style.display = 'none';
  }
}

async function handleAdminLogin(event) {
  event.preventDefault();
  const username = document.getElementById('admin-username').value.trim();
  const password = document.getElementById('admin-password').value.trim();

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok || !data.success) return showToast(data.error || 'Login Failed');

    adminToken = data.token;
    localStorage.setItem('keymaster_admin_token', adminToken);
    document.getElementById('admin-user-display').textContent = data.username || 'admin';
    showToast('🔓 Dashboard Unlocked!');
    checkAdminAuth();
  } catch (err) {
    showToast('Failed to connect to server');
  }
}

function handleAdminLogout() {
  fetch('/api/admin/logout', {
    method: 'POST',
    headers: { 'X-Admin-Token': adminToken }
  }).catch(() => {});
  adminToken = '';
  localStorage.removeItem('keymaster_admin_token');
  showToast('Logged out');
  checkAdminAuth();
}

function authFetch(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['X-Admin-Token'] = adminToken;
  return fetch(url, options);
}

async function loadAllData() {
  try {
    await Promise.all([loadStats(), loadProjects(), loadLicenses(), loadLogs()]);
  } catch (err) {}
}

async function loadStats() {
  try {
    const res = await authFetch('/api/stats');
    const data = await res.json();
    document.getElementById('stat-projects').textContent = data.projects || 0;
    document.getElementById('stat-active').textContent = data.activeKeys || 0;
    document.getElementById('stat-devices').textContent = data.totalDevices || 0;
    document.getElementById('stat-expired').textContent = data.expiredKeys || 0;
  } catch (err) {}
}

async function loadProjects() {
  try {
    const res = await authFetch('/api/projects');
    currentProjects = await res.json();

    const filterSelect = document.getElementById('project-filter');
    const newKeyProjectSelect = document.getElementById('new-key-project');

    filterSelect.innerHTML = '<option value="">All Projects</option>';
    newKeyProjectSelect.innerHTML = '<option value="" disabled selected>-- Select a Project --</option>';

    currentProjects.forEach(proj => {
      filterSelect.innerHTML += `<option value="${proj.id}">${escapeHtml(proj.name)}</option>`;
      newKeyProjectSelect.innerHTML += `<option value="${proj.id}">${escapeHtml(proj.name)}</option>`;
    });

    renderProjectsList(currentProjects);
  } catch (err) {}
}

function renderProjectsList(projects) {
  const container = document.getElementById('projects-list');
  if (!projects.length) {
    container.innerHTML = '<p class="loading-state">No projects found.</p>';
    return;
  }

  container.innerHTML = projects.map(p => `
    <div class="project-card">
      <div>
        <h3>📁 ${escapeHtml(p.name)}</h3>
        <p>${escapeHtml(p.description || '')}</p>
        ${p.folder_path ? `<div class="project-folder-chip"><span>📂 Path:</span> <code>${escapeHtml(p.folder_path)}</code></div>` : ''}
      </div>
      <div>
        <div class="project-stats">
          <span>Keys: <b>${p.total_licenses || 0}</b></span>
          <span>Active: <b style="color:#10b981">${p.active_licenses || 0}</b></span>
        </div>
        <div style="margin-top:10px; display:flex; gap:6px;">
          <button class="btn btn-primary btn-sm" onclick="openNewKeyForProject('${p.id}')">+ New Key</button>
          <button class="btn btn-danger btn-sm" onclick="deleteProject('${p.id}', '${escapeHtml(p.name)}')">Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

async function loadLicenses() {
  try {
    const res = await authFetch('/api/licenses');
    currentLicenses = await res.json();
    renderLicenses(currentLicenses);
  } catch (err) {}
}

function renderLicenses(licenses) {
  const tbody = document.getElementById('licenses-tbody');
  if (!licenses.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading-state">No licenses found.</td></tr>';
    return;
  }

  tbody.innerHTML = licenses.map(lic => {
    const boundCount = lic.bound_device_count || (lic.devices ? lic.devices.length : 0);
    const maxDev = lic.max_devices >= 999 ? '∞' : lic.max_devices;
    const isDeviceFull = lic.max_devices < 999 && boundCount >= lic.max_devices;

    let expiryClass = lic.is_expired ? 'danger' : (lic.days_remaining <= 5 ? 'warning' : 'good');
    let expiryText = lic.is_expired ? 'EXPIRED' : `${lic.days_remaining} days left`;

    return `
      <tr>
        <td>
          <div class="key-badge"><span>${escapeHtml(lic.license_key)}</span><button class="copy-mini-btn" onclick="copyText('${lic.license_key}')">📋</button></div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">👤 ${escapeHtml(lic.customer_name || 'No name')}</div>
        </td>
        <td>
          <div><b>${escapeHtml(lic.username)}</b></div>
          <div style="font-size:11px; color:var(--text-muted);">PWD: <code style="color:#38bdf8;">${escapeHtml(lic.password_hint || '********')}</code></div>
          <div style="font-size:11px; color:var(--text-dim);">📁 ${escapeHtml(lic.project_name)}</div>
        </td>
        <td>
          <div class="device-badge ${isDeviceFull ? 'device-full' : 'device-ok'}" onclick="openManageDevicesModal('${lic.id}')">
            💻 ${boundCount} / ${maxDev} Devices ${isDeviceFull ? '🔒' : '🔓'}
          </div>
        </td>
        <td>
          <div class="expiry-days ${expiryClass}">${expiryText}</div>
          <div style="font-size:11px; color:var(--text-dim);">${new Date(lic.expires_at).toLocaleDateString()}</div>
        </td>
        <td><span class="badge badge-${lic.status}">${lic.status}</span></td>
        <td style="text-align:right;">
          <button class="btn btn-secondary btn-sm" onclick="openManageDevicesModal('${lic.id}')">💻 Devices</button>
          <button class="btn btn-secondary btn-sm" onclick="openExtendModal('${lic.id}', '${lic.license_key}')">⌛ Extend</button>
          <button class="btn btn-danger btn-sm" onclick="deleteLicense('${lic.id}', '${lic.license_key}')">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function loadLogs() {
  try {
    const res = await authFetch('/api/stats');
    const data = await res.json();
    const tbody = document.getElementById('logs-tbody');
    const logs = data.recentLogs || [];
    if (!logs.length) { tbody.innerHTML = '<tr><td colspan="6" class="loading-state">No logs yet.</td></tr>'; return; }

    tbody.innerHTML = logs.map(l => `
      <tr>
        <td style="font-size:12px;">${new Date(l.created_at).toLocaleTimeString()}</td>
        <td><code>${escapeHtml(l.license_key || 'N/A')}</code></td>
        <td><b>${escapeHtml(l.action)}</b></td>
        <td><span style="color:${l.status === 'SUCCESS' ? '#10b981' : '#ef4444'}; font-weight:600;">${escapeHtml(l.status)}</span></td>
        <td><code>${escapeHtml(l.device_id || 'N/A')}</code></td>
        <td style="font-size:12px;">${escapeHtml(l.message || '')}</td>
      </tr>
    `).join('');
  } catch (err) {}
}

function filterLicenses() {
  const query = document.getElementById('search-input').value.toLowerCase().trim();
  const projectId = document.getElementById('project-filter').value;
  const status = document.getElementById('status-filter').value;

  const filtered = currentLicenses.filter(lic => {
    return (!projectId || lic.project_id === projectId) &&
      (!status || lic.status === status) &&
      (!query || lic.license_key.toLowerCase().includes(query) || lic.username.toLowerCase().includes(query));
  });
  renderLicenses(filtered);
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const btn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick')?.includes(tabId));
  if (btn) btn.classList.add('active');
  document.getElementById(tabId)?.classList.add('active');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function openNewKeyModal() {
  generateRandomKeyCode();
  generateRandomPass();
  openModal('new-key-modal');
}

function openNewKeyForProject(projectId) {
  openNewKeyModal();
  document.getElementById('new-key-project').value = projectId;
}

function openNewProjectModal() {
  document.getElementById('new-proj-folder').value = '';
  document.getElementById('new-proj-name').value = '';
  document.getElementById('new-proj-desc').value = '';
  const scanBox = document.getElementById('folder-scan-info');
  if (scanBox) scanBox.style.display = 'none';
  openModal('new-project-modal');
}

async function browseFolderFromPc() {
  const btn = document.getElementById('btn-browse-pc');
  btn.disabled = true;
  btn.innerHTML = '⏳ Opening...';

  try {
    const res = await authFetch('/api/browse-folder', { method: 'POST' });
    const data = await res.json();
    if (data.success && data.path) {
      applyScannedFolder(data);
      showToast('✅ Folder Selected!');
    } else {
      document.getElementById('browser-folder-input').click();
    }
  } catch (err) {
    document.getElementById('browser-folder-input').click();
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📂 Browse PC';
  }
}

function handleHtml5FolderPicked(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  const firstPath = files[0].webkitRelativePath || '';
  const folderName = firstPath.split('/')[0] || 'Selected Project';

  let displayPath = folderName;
  if (folderName.toLowerCase().includes('fox') || folderName.toLowerCase().includes('top')) {
    displayPath = 'C:\\Users\\gg031\\Downloads\\fox self bot sale';
  }
  document.getElementById('new-proj-folder').value = displayPath;
  document.getElementById('new-proj-name').value = folderName;
  document.getElementById('new-proj-desc').value = `Folder with ${files.length} files`;

  const scanBox = document.getElementById('folder-scan-info');
  scanBox.style.display = 'block';
  scanBox.innerHTML = `✅ Selected Folder: <b>${escapeHtml(folderName)}</b> (${files.length} files)`;
}

function quickSelectFolder(folderPath) {
  document.getElementById('new-proj-folder').value = folderPath;
  scanFolderPath(folderPath);
}

let scanDebounceTimer = null;
function handleFolderPathInput() {
  clearTimeout(scanDebounceTimer);
  scanDebounceTimer = setTimeout(() => {
    const path = document.getElementById('new-proj-folder').value.trim();
    if (path.length > 2) scanFolderPath(path);
  }, 400);
}

async function scanFolderPath(folderPath) {
  const scanBox = document.getElementById('folder-scan-info');
  scanBox.style.display = 'block';
  scanBox.innerHTML = '🔍 Scanning folder...';

  try {
    const res = await authFetch('/api/scan-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath })
    });
    const data = await res.json();
    if (data.exists) {
      applyScannedFolder(data);
    } else {
      scanBox.innerHTML = `⚠️ <span style="color:#ef4444;">${escapeHtml(data.error || 'Folder not found')}</span>`;
    }
  } catch (err) {}
}

function applyScannedFolder(data) {
  const folderPath = data.folder_path || data.path || '';
  document.getElementById('new-proj-folder').value = folderPath;
  document.getElementById('new-proj-name').value = data.detected_name || data.folder_name;
  if (data.detected_desc) document.getElementById('new-proj-desc').value = data.detected_desc;

  const scanBox = document.getElementById('folder-scan-info');
  scanBox.style.display = 'block';
  scanBox.innerHTML = `✅ Folder Detected: <b>${escapeHtml(data.detected_name || data.folder_name)}</b>`;
}

function generateRandomKeyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const genPart = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  document.getElementById('new-key-code').value = `KEY-${genPart()}-${genPart()}-${genPart()}`;
}

function generateRandomPass() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$';
  document.getElementById('new-key-pass').value = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function submitCreateKey() {
  const project_id = document.getElementById('new-key-project').value;
  const username = document.getElementById('new-key-user').value.trim();
  const password = document.getElementById('new-key-pass').value.trim();
  const license_key = document.getElementById('new-key-code').value.trim();
  const max_devices = parseInt(document.getElementById('new-key-devices').value, 10);
  const daysVal = document.getElementById('new-key-days').value;
  const customDays = parseInt(document.getElementById('new-key-custom-days').value, 10);
  const customer_name = document.getElementById('new-key-customer').value.trim();
  const notes = document.getElementById('new-key-notes').value.trim();

  if (!project_id || !username || !password) return showToast('Please enter all required fields!');
  const duration_days = daysVal === 'custom' ? (customDays || 30) : parseInt(daysVal, 10);

  try {
    const res = await authFetch('/api/licenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id, username, password, license_key, max_devices, duration_days, customer_name, notes })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Failed to create key');

    closeModal('new-key-modal');
    showToast(`Key Created: ${data.license_key}`);
    loadAllData();
  } catch (err) {
    showToast('Failed to create key');
  }
}

async function submitCreateProject() {
  const name = document.getElementById('new-proj-name').value.trim();
  const description = document.getElementById('new-proj-desc').value.trim();
  const folder_path = document.getElementById('new-proj-folder').value.trim();

  if (!name) return showToast('Please enter a project name!');

  try {
    const res = await authFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, folder_path })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Failed to create project');

    closeModal('new-project-modal');
    showToast(`Project Created: ${data.name}`);
    loadAllData();
  } catch (err) {
    showToast('Failed to create project');
  }
}

function openManageDevicesModal(licenseId) {
  const lic = currentLicenses.find(l => l.id === licenseId);
  if (!lic) return;
  currentEditingLicenseId = licenseId;
  document.getElementById('devices-modal-title').textContent = `💻 Bound Devices (${lic.license_key})`;
  document.getElementById('devices-modal-desc').innerHTML = `User: <b>${escapeHtml(lic.username)}</b> | Limit: <b>${lic.max_devices}</b>`;

  const tbody = document.getElementById('devices-modal-tbody');
  tbody.innerHTML = (lic.devices || []).map(d => `
    <tr>
      <td><code>${escapeHtml(d.device_id)}</code></td>
      <td>${escapeHtml(d.device_name || 'Generic')}</td>
      <td style="font-size:12px;">${new Date(d.last_seen).toLocaleString()}</td>
      <td><button class="btn btn-danger btn-sm" onclick="removeSingleDevice('${lic.id}', '${d.id}')">Remove</button></td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="loading-state">No devices bound yet.</td></tr>';

  openModal('devices-modal');
}

async function resetAllDevicesForCurrentKey() {
  if (!currentEditingLicenseId || !confirm('Reset all devices?')) return;
  try {
    const res = await authFetch(`/api/licenses/${currentEditingLicenseId}/reset-devices`, { method: 'POST' });
    if (!res.ok) return showToast('Failed to reset');
    showToast('All devices cleared!');
    closeModal('devices-modal');
    loadAllData();
  } catch (err) {}
}

async function removeSingleDevice(licenseId, deviceRecordId) {
  try {
    await authFetch(`/api/licenses/${licenseId}/devices/${deviceRecordId}`, { method: 'DELETE' });
    showToast('Device removed');
    await loadLicenses();
    openManageDevicesModal(licenseId);
  } catch (err) {}
}

function openExtendModal(licenseId, licenseKey) {
  currentEditingLicenseId = licenseId;
  document.getElementById('extend-modal-key-name').innerHTML = `Key: <code>${escapeHtml(licenseKey)}</code>`;
  openModal('extend-modal');
}

async function submitExtendKey() {
  if (!currentEditingLicenseId) return;
  const days = parseInt(document.getElementById('extend-days-select').value, 10);
  try {
    const res = await authFetch(`/api/licenses/${currentEditingLicenseId}/extend`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days })
    });
    const data = await res.json();
    showToast(`Extended by ${days} days!`);
    closeModal('extend-modal');
    loadAllData();
  } catch (err) {}
}

async function deleteLicense(licenseId, licenseKey) {
  if (!confirm(`Delete key ${licenseKey}?`)) return;
  try {
    await authFetch(`/api/licenses/${licenseId}`, { method: 'DELETE' });
    showToast('License deleted');
    loadAllData();
  } catch (err) {}
}

async function deleteProject(projectId, projectName) {
  if (!confirm(`Delete project "${projectName}"?`)) return;
  try {
    await authFetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    showToast('Project deleted');
    loadAllData();
  } catch (err) {}
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied! 📋'));
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
