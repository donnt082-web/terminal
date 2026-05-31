const WebSocket = require('ws');
const http = require('http');
const net = require('net');
const Aedes = require('aedes').Aedes;
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
      // 处理控制命令（风扇/LED）
      if (parsed.type === 'control') {
        log(`🎮 控制命令 [${id}]: ${JSON.stringify(parsed)}`);
        const cmd = JSON.stringify({ cmd: parsed.action, target: parsed.target, value: parsed.value });
        if (aedes) aedes.publish({ topic: 'device/control', payload: cmd, qos: 0, retain: false }, () => {});

        // 通过 TCP 透传给 STM32（开 = 1 高电平，关 = 0 低电平）
        const v = (parsed.value === 'on' || parsed.value === 1) ? 1 : 0;
        if (parsed.target === 'led' || parsed.target === 'fan') {
          tcpBroadcastCmd({ [parsed.target]: v });
        }
      }
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

// 每个设备的最新合并状态：因固件分两次上报（report1=血氧/心率/浓度/告警，
// report2=温湿度/经纬度），用此缓存把多次上报累积成一条完整记录再存库。
const latestState = new Map();
const MERGE_WINDOW_MS = 8000; // 合并窗口：8 秒内的上报视为同一组

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

    // 本次上报解析出的字段（缺失为 null）
    const incoming = {
      spO2: props.spO2 ?? props.dis_spo2 ?? null,
      heart_rate: props.heart_rate ?? props.dis_hr ?? null,
      density: props.density ?? props.ppm ?? null,
      temperature: props.temperature ?? null,
      humidity: props.humidity ?? null,
      longitude: props.longitude ?? null,
      latitude: props.latitude ?? null,
      fall_flag: props.fall_flag != null ? (props.fall_flag ? 1 : 0) : null,
      collision_flag: props.collision_flag != null ? (props.collision_flag ? 1 : 0) : null
    };

    const now = Date.now();
    let st = latestState.get(clientId);
    // 超出合并窗口则重新开一组（避免把很久以前的数据并进来）
    if (!st || now - st.ts > MERGE_WINDOW_MS) {
      st = { ts: now, data: {}, rowId: null };
      latestState.set(clientId, st);
    }
    st.ts = now;

    // 用本次非空字段更新合并状态
    let changed = false;
    for (const k of Object.keys(incoming)) {
      if (incoming[k] !== null && incoming[k] !== undefined) {
        st.data[k] = incoming[k];
        changed = true;
      }
    }
    if (!changed) return;

    // 合并后的完整记录（缺失字段补 null / 0）
    const record = {
      client_id: clientId,
      spO2: st.data.spO2 ?? null,
      heart_rate: st.data.heart_rate ?? null,
      density: st.data.density ?? null,
      temperature: st.data.temperature ?? null,
      humidity: st.data.humidity ?? null,
      longitude: st.data.longitude ?? null,
      latitude: st.data.latitude ?? null,
      fall_flag: st.data.fall_flag ?? 0,
      collision_flag: st.data.collision_flag ?? 0
    };

    if (st.rowId == null) {
      // 本组第一条上报：插入新行，记住行号
      st.rowId = db.insert(record);
    } else {
      // 本组后续上报：更新同一行，把新字段补进去（合并成一条完整记录）
      db.updateById(st.rowId, record);
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

// ── MQTT Broker (port 1883) ─────────────────────────
// aedes v1 必须用 createBroker() 异步创建（new Aedes() 不会正确初始化，导致 connack 超时）
const MQTT_PORT = 1883;
let aedes = null;
let mqttServer = null;

async function startMqttBroker() {
  aedes = await Aedes.createBroker();
  mqttServer = net.createServer(aedes.handle);

  aedes.on('client', (client) => {
    log(`🔌 MQTT 客户端连接: ${client.id}`);
  });

  aedes.on('clientDisconnect', (client) => {
    log(`❌ MQTT 客户端断开: ${client.id}`);
  });

  aedes.on('publish', (packet, client) => {
    // 忽略系统主题和无客户端的消息
    if (!client || packet.topic.startsWith('$SYS')) return;

    const payload = packet.payload.toString();
    log(`📡 MQTT [${client.id}] ${packet.topic}: ${payload.slice(0, 200)}`);

    // 解析上报数据
    try {
      const parsed = JSON.parse(payload);

      // 提取 properties（兼容 services 格式和扁平 JSON）
      let data = parsed;
      if (parsed.services && Array.isArray(parsed.services)) {
        const s = parsed.services[0];
        if (s && s.properties) data = s.properties;
      }

      broadcast({
        type: 'espData',
        from: client.id,
        data: data,
        timestamp: new Date().toISOString()
      }, null, ['browser', 'unknown']);

      persistEspData(client.id, data);
    } catch (e) {
      // 非 JSON 忽略
    }
  });

  await new Promise((resolve) => {
    mqttServer.listen(MQTT_PORT, () => {
      log(`MQTT Broker 已启动，监听端口 ${MQTT_PORT}`);
      resolve();
    });
  });
}

// ── Raw TCP Server (port 3001) — ESP01s 透传 JSON 入口 ─────────
const TCP_PORT = 3001;
const tcpClients = new Map();

const tcpServer = net.createServer((sock) => {
  const id = 'tcp_' + sock.remoteAddress + ':' + sock.remotePort;
  tcpClients.set(id, sock);
  log(`🔌 TCP 客户端连接: ${id}`);

  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    // 一行一条 JSON（STM32 端是 \n 结尾）
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;

      log(`📡 TCP 数据 [${id}]: ${line.slice(0, 200)}`);

      try {
        const data = JSON.parse(line);
        broadcast({
          type: 'espData',
          from: id,
          data,
          timestamp: new Date().toISOString()
        }, null, ['browser', 'unknown']);
        persistEspData(id, data);
      } catch (e) {
        log(`TCP JSON 解析失败: ${e.message}`);
      }
    }
  });

  sock.on('close', () => {
    tcpClients.delete(id);
    log(`❌ TCP 客户端断开: ${id}`);
  });

  sock.on('error', (e) => log(`TCP 错误 [${id}]: ${e.message}`));
});

// 工具：向所有 TCP 客户端发送一条命令（前端按钮 → 透传到 STM32）
// 连发 3 次（间隔 60ms）提高可靠性，避开 STM32 USART3 偶发丢包
function tcpBroadcastCmd(cmd) {
  const line = JSON.stringify(cmd) + '\n';
  for (const sock of tcpClients.values()) {
    if (!sock.destroyed) sock.write(line);
  }
}

// ── Start Servers ────────────────────────────────────────────
httpServer.listen(port, () => {
  tcpServer.listen(TCP_PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║       智能安全帽管理服务器                     ║');
    console.log('╠═══════════════════════════════════════════════╣');
    console.log(`║  WS   端口 : ${port}`);
    console.log(`║  MQTT 端口 : ${MQTT_PORT}`);
    console.log(`║  TCP  端口 : ${TCP_PORT}  (ESP-01S 透传)`);
    console.log(`║  API  接口 : http://localhost:${port}/api/*`);
    console.log('╚═══════════════════════════════════════════════╝');
    console.log('');

    db.init();

    // 启动 MQTT broker（异步）
    startMqttBroker().catch((err) => {
      log(`MQTT Broker 启动失败: ${err.message}`);
    });
  });
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
