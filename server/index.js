const WebSocket = require('ws');
const http = require('http');
const db = require('./db');

const DEFAULT_PORT = 3000;
const port = parseInt(process.argv[2], 10) || process.env.PORT || DEFAULT_PORT;

// HTTP server for health check, REST API & static files
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const path = parsed.pathname;

  // ── Health ──
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      clients: clients.size,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // ── WS Client Stats ──
  if (path === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const list = [...clients.values()].map(c => ({
      id: c.id, type: c.type,
      connectedAt: c.connectedAt, msgCount: c.msgCount
    }));
    res.end(JSON.stringify({ clients: list }));
    return;
  }

  // ── DB Stats ──
  if (path === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(db.getStats()));
    return;
  }

  // ── Latest Records ──
  if (path === '/api/data') {
    const limit = Math.min(parseInt(parsed.searchParams.get('limit'), 10) || 50, 500);
    const data = db.getLatest(limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data, total: data.length }));
    return;
  }

  // ── Most Recent Record ──
  if (path === '/api/data/recent') {
    const record = db.getRecent();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: record }));
    return;
  }

  // ── Time Range Query ──
  if (path === '/api/data/range') {
    const start = parsed.searchParams.get('start') || '1970-01-01';
    const end = parsed.searchParams.get('end') || '2099-12-31';
    const limit = Math.min(parseInt(parsed.searchParams.get('limit'), 10) || 200, 1000);
    const data = db.getByTimeRange(start, end, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data, total: data.length }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});

const wss = new WebSocket.Server({ server: httpServer });

// ── Client Store ──────────────────────────────────────────────
const clients = new Map();

// ── Connection Handler ────────────────────────────────────────
wss.on('connection', (ws) => {
  const id = generateId();
  const client = {
    id,
    ws,
    type: 'unknown',
    connectedAt: new Date().toISOString(),
    msgCount: 0
  };
  clients.set(id, client);
  log(`客户端连接 [${id}]  当前在线: ${clients.size}`);

  // ── Welcome Message ──
  send(ws, {
    type: 'welcome',
    clientId: id,
    message: '已连接到智能终端管理服务器',
    onlineCount: clients.size,
    timestamp: new Date().toISOString()
  });

  // ── Handle Incoming Messages ──
  ws.on('message', (raw) => {
    const text = raw.toString();
    client.msgCount++;

    // Try parse JSON
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    // ── Client type auto-detection ──
    if (client.type === 'unknown') {
      if (parsed.type === 'register') {
        client.type = parsed.clientType || 'browser';
        log(`客户端注册 [${id}] 类型=${client.type}`);
      } else if (isEspData(parsed)) {
        client.type = 'esp01s';
        log(`自动识别 [${id}] => ESP01S 数据源`);
      } else {
        client.type = 'browser';
        log(`自动识别 [${id}] => 浏览器客户端`);
      }

      // Notify all viewing clients about the new joiner
      broadcast({
        type: 'clientJoined',
        clientId: id,
        clientType: client.type,
        onlineCount: clients.size,
        timestamp: new Date().toISOString()
      }, id, ['browser', 'unknown']);
    }

    // ── Forward ESP01S data to browser clients ──
    if (client.type === 'esp01s') {
      log(`📡 ESP01S 数据 [${id}]: ${JSON.stringify(parsed).slice(0, 200)}`);

      broadcast({
        type: 'espData',
        from: id,
        data: parsed,
        msgCount: client.msgCount,
        timestamp: new Date().toISOString()
      }, id, ['browser', 'unknown']);

      // ── Persist to database ──
      persistEspData(id, parsed);
    }

    // ── Forward browser messages to other browsers ──
    if (client.type === 'browser') {
      broadcast({
        type: 'message',
        from: id,
        data: parsed,
        timestamp: new Date().toISOString()
      }, id, ['browser']);
    }
  });

  // ── Client Disconnect ──
  ws.on('close', () => {
    log(`客户端断开 [${id}] 类型=${client.type}`);
    clients.delete(id);
    broadcast({
      type: 'clientLeft',
      clientId: id,
      onlineCount: clients.size,
      timestamp: new Date().toISOString()
    }, null, ['browser', 'unknown']);
  });

  ws.on('error', (err) => {
    log(`连接错误 [${id}]: ${err.message}`);
  });
});

// ── Database Persistence ──────────────────────────────────────

function persistEspData(clientId, parsed) {
  try {
    // Extract properties from either format
    let props = null;
    if (parsed.services && Array.isArray(parsed.services)) {
      const s = parsed.services[0];
      if (s && s.properties) props = s.properties;
    } else if (parsed.properties) {
      props = parsed.properties;
    } else {
      // Check if this IS a flat properties object
      const espKeys = ['spO2', 'heart_rate', 'density', 'temperature', 'humidity', 'longitude', 'latitude', 'fall_flag', 'collision_flag'];
      const hasEspKey = espKeys.some(k => parsed[k] !== undefined);
      if (hasEspKey) props = parsed;
    }

    if (!props) return;

    const record = {
      client_id: clientId,
      spO2: props.spO2 ?? props.dis_spo2 ?? null,
      heart_rate: props.heart_rate ?? props.dis_hr ?? null,
      density: props.density ?? props.ppm ?? null,
      temperature: props.temperature ?? null,
      humidity: props.humidity ?? null,
      longitude: props.longitude ?? null,
      latitude: props.latitude ?? null,
      fall_flag: props.fall_flag ? 1 : 0,
      collision_flag: props.collision_flag ? 1 : 0
    };

    // Only insert if there's at least one meaningful value
    const hasData = record.spO2 !== null || record.heart_rate !== null || record.density !== null ||
                    record.temperature !== null || record.humidity !== null ||
                    record.longitude !== null || record.latitude !== null;
    if (hasData) {
      db.insert(record);
    }
  } catch (err) {
    log(`数据库写入错误: ${err.message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data, excludeId, targetTypes) {
  const payload = JSON.stringify(data);
  for (const [cid, c] of clients) {
    if (cid === excludeId) continue;
    if (targetTypes && !targetTypes.includes(c.type)) continue;
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(payload);
    }
  }
}

function isEspData(obj) {
  // Check if the JSON matches ESP01S data pattern
  const check = (o) => {
    const keys = Object.keys(o);
    const espKeys = ['spO2', 'heart_rate', 'density', 'ppm', 'fall_flag',
      'collision_flag', 'longitude', 'latitude', 'temperature', 'humidity',
      'dis_spo2', 'dis_hr'];
    return keys.some(k => espKeys.includes(k));
  };

  // Handle wrapped format: { data: {...} }
  if (obj.data && typeof obj.data === 'object') return check(obj.data);
  // Handle services format: { services: [{ properties: {...} }] }
  if (obj.services && Array.isArray(obj.services)) {
    return obj.services.some(s => s.properties && check(s.properties));
  }
  return check(obj);
}

function generateId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return 'dev_' + ts + rand;
}

function log(msg) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${time}] ${msg}`);
}

// ── Start Server ─────────────────────────────────────────────
httpServer.listen(port, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║       智能终端管理 WebSocket 服务器           ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  监听端口 : ${port}                            `);
  console.log(`║  WS 地址  : ws://localhost:${port}             `);
  console.log(`║  API 接口 : http://localhost:${port}/api/*     `);
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');

  // 初始化数据库
  db.init();
});

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
  log('正在关闭服务器...');
  wss.clients.forEach(c => c.close());
  httpServer.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
