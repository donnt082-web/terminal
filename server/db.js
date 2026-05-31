/**
 * 数据库模块 
 * 传感器数据持久化存储与查询
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'sensor_data.db');

let db = null;

/**
 * 初始化数据库：创建目录、建表
 */
function init() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);

  // 启用 WAL 模式提升并发性能
  db.pragma('journal_mode = WAL');

  // 创建传感器数据表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   TEXT,
      spO2        INTEGER,
      heart_rate  INTEGER,
      density     REAL,
      temperature INTEGER,
      humidity    INTEGER,
      longitude   REAL,
      latitude    REAL,
      fall_flag   INTEGER DEFAULT 0,
      collision_flag INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_created_at ON sensor_data(created_at);
    CREATE INDEX IF NOT EXISTS idx_client_id ON sensor_data(client_id);
  `);

  const count = db.prepare('SELECT COUNT(*) as total FROM sensor_data').get();
  console.log(`  数据库已就绪: ${count.total} 条历史记录`);
}

/**
 * 插入一条传感器数据
 */
function insert(data) {
  if (!db) return null;
  const stmt = db.prepare(`
    INSERT INTO sensor_data (client_id, spO2, heart_rate, density, temperature, humidity, longitude, latitude, fall_flag, collision_flag)
    VALUES (@client_id, @spO2, @heart_rate, @density, @temperature, @humidity, @longitude, @latitude, @fall_flag, @collision_flag)
  `);
  const result = stmt.run(data);
  return result.lastInsertRowid;
}

/**
 * 获取最新 N 条记录
 */
function getLatest(limit = 50) {
  if (!db) return [];
  const stmt = db.prepare('SELECT * FROM sensor_data ORDER BY id DESC LIMIT ?');
  return stmt.all(limit);
}

/**
 * 获取最近一条记录
 */
function getRecent() {
  if (!db) return null;
  return db.prepare('SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1').get();
}

/**
 * 按时间范围查询
 */
function getByTimeRange(start, end, limit = 200) {
  if (!db) return [];
  const stmt = db.prepare(
    'SELECT * FROM sensor_data WHERE created_at >= ? AND created_at <= ? ORDER BY id DESC LIMIT ?'
  );
  return stmt.all(start, end, limit);
}

/**
 * 获取统计信息
 */
function getStats() {
  if (!db) {
    return { total: 0, today: 0, lastRecord: null };
  }
  const total = db.prepare('SELECT COUNT(*) as count FROM sensor_data').get().count;
  const today = db.prepare(
    "SELECT COUNT(*) as count FROM sensor_data WHERE date(created_at) = date('now', 'localtime')"
  ).get().count;
  const lastRecord = db.prepare('SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1').get();

  return { total, today, lastRecord };
}

/**
 * 关闭数据库连接
 */
function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { init, insert, getLatest, getRecent, getByTimeRange, getStats, close, _getDb: () => db };
