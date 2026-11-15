// Project & License Key Manager Server
// Multi-Database Support: Cloud PostgreSQL (24/7 Persistent) OR Local SQLite
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.db');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
// -------------------------------------------------------------
// DATABASE INITIALIZATION (PostgreSQL with DATABASE_URL or SQLite fallback)
// -------------------------------------------------------------
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
    console.log('🌐 Connected to Cloud PostgreSQL Database (Permanent 24/7 Storage)!');
  } catch (err) {
    console.error('⚠️ Could not initialize pg, falling back to SQLite:', err.message);
  }
}
if (!isPostgres) {
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(DB_FILE);
  console.log('💾 Using Local SQLite Database:', DB_FILE);
}
// Universal Database Adapter
const db = {
  async query(sql, params = []) {
    if (isPostgres) {
      let idx = 1;
      const pgSql = sql.replace(/\?/g, () => `$${idx++}`);
      const res = await pgPool.query(pgSql, params);
      return res.rows;
    } else {
      const stmt = sqliteDb.prepare(sql);
      return stmt.all(...params);
    }
