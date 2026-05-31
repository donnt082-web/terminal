/**
 * 智能终端管理系统 - 主应用逻辑
 * Apple 设计语言 · 细腻动效 · 丰富内容
 * (业务核心未改动：WS连接管理、数据解析、转发渲染)
 */
(function () {
  'use strict';

  // ── State ──
  const state = {
    connected: false,
    connecting: false,
    dataCount: 0,
    sensorData: {
      spO2: 96, heart_rate: 72, density: 8.5,
      temperature: 26, humidity: 58,
      longitude: 113.2644, latitude: 23.1291,
      fall_flag: 0, collision_flag: 0
    },
    dataSources: new Map()
  };

  const ws = new WSClient();
  const $ = id => document.getElementById(id);

  // ── DOM Refs ──
  const dom = {
    // Connection
    serverAddr: $('serverAddr'),
    serverPort: $('serverPort'),
    btnConnect: $('btnConnect'),
    btnDisconnect: $('btnDisconnect'),
    connectionSheet: $('connectionSheet'),
    sheetToggle: $('sheetToggle'),
    connectionInfo: $('connectionInfo'),
    infoClientId: $('infoClientId'),
    infoOnlineCount: $('infoOnlineCount'),
    infoDataCount: $('infoDataCount'),

    // Status
    statusBadge: $('statusBadge'),
    statusDot: $('statusDot'),
    statusLabel: $('statusLabel'),
    navClientId: $('navClientId'),

    // Values
    val_spO2: $('val_spO2'),
    val_heart_rate: $('val_heart_rate'),
    val_density: $('val_density'),
    val_temperature: $('val_temperature'),
    val_humidity: $('val_humidity'),
    val_location: $('val_location'),

    // Bars
    bar_spO2: $('bar_spO2'),
    bar_heart_rate: $('bar_heart_rate'),
    bar_density: $('bar_density'),
    bar_temperature: $('bar_temperature'),
    bar_humidity: $('bar_humidity'),

    // Status labels
    status_spO2: $('status_spO2'),
    status_heart_rate: $('status_heart_rate'),
    status_density: $('status_density'),
    status_temperature: $('status_temperature'),
    status_humidity: $('status_humidity'),
    status_location: $('status_location'),

    // Alarm
    alarm_fall: $('alarm_fall'),
    alarm_collision: $('alarm_collision'),
    badge_fall: $('badge_fall'),
    badge_collision: $('badge_collision'),
    alarmSummary: $('alarmSummary'),

    // Log
    logContainer: $('logContainer'),
    logEmpty: $('logEmpty'),
    logCount: $('logCount'),
    btnClearLog: $('btnClearLog'),
    chkAutoScroll: $('chkAutoScroll'),

    // History
    historyBody: $('historyBody'),
    historyCount: $('historyCount'),
    btnRefreshHistory: $('btnRefreshHistory'),
    historyRange: $('historyRange')
  };

  // ── Init ──
  function init() {
    bindEvents();
    loadSettings();
    renderDashboard();
  }

  // ── Events ──
  function bindEvents() {
    dom.btnConnect.addEventListener('click', handleConnect);
    dom.btnDisconnect.addEventListener('click', handleDisconnect);
    dom.btnClearLog.addEventListener('click', clearLog);
    dom.sheetToggle.addEventListener('click', toggleSheet);

    dom.serverAddr.addEventListener('keydown', e => e.key === 'Enter' && handleConnect());
    dom.serverPort.addEventListener('keydown', e => e.key === 'Enter' && handleConnect());

    // History
    dom.btnRefreshHistory.addEventListener('click', loadHistory);
    dom.historyRange.addEventListener('change', loadHistory);

    // WS events
    ws.on('connected', onConnected);
    ws.on('disconnected', onDisconnected);
    ws.on('error', onError);
    ws.on('espData', onEspData);
    ws.on('clientJoined', onClientJoined);
    ws.on('clientLeft', onClientLeft);
    ws.on('welcome', onWelcome);
  }

  // ── Sheet Toggle ──
  function toggleSheet() {
    dom.connectionSheet.classList.toggle('collapsed');
  }

  // ── Connection ──
  function handleConnect() {
    const addr = dom.serverAddr.value.trim() || 'localhost';
    const port = parseInt(dom.serverPort.value, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      addLog('sys', '请输入有效的端口号 (1-65535)');
      return;
    }
    addLog('sys', `正在连接 ws://${addr}:${port} ...`);
    state.connecting = true;
    updateConnectionUI();
    dom.btnConnect.classList.add('loading');
    ws.connect(addr, port);
  }

  function handleDisconnect() {
    ws.disconnect();
  }

  function onConnected() {
    state.connected = true;
    state.connecting = false;
    dom.btnConnect.classList.remove('loading');
    saveSettings();
    updateConnectionUI();
    addLog('sys', `已连接到服务器 (ID: ${ws.clientId})`);
    dom.connectionSheet.classList.add('collapsed');
    loadHistory(); // 加载历史数据
  }

  function onDisconnected() {
    state.connected = false;
    state.connecting = false;
    dom.btnConnect.classList.remove('loading');
    updateConnectionUI();
    addLog('sys', '连接已断开');
    dom.connectionSheet.classList.remove('collapsed');
  }

  function onError(err) {
    dom.btnConnect.classList.remove('loading');
    state.connecting = false;
    updateConnectionUI();
    const msg = typeof err === 'string' ? err : '无法连接到服务器，请检查地址和端口';
    addLog('sys', `错误: ${msg}`);
  }

  function onWelcome(msg) {
    addLog('sys', `${msg.message} (在线: ${msg.onlineCount})`);
  }

  // ── Connection UI ──
  function updateConnectionUI() {
    const c = state.connected;
    const connecting = state.connecting;

    dom.btnConnect.style.display = c ? 'none' : '';
    dom.btnConnect.disabled = connecting;
    dom.btnDisconnect.style.display = c ? '' : 'none';
    dom.serverAddr.disabled = c;
    dom.serverPort.disabled = c;
    dom.connectionInfo.style.display = c ? '' : 'none';

    // Status badge
    if (c) {
      dom.statusBadge.className = 'status-badge connected';
      dom.statusLabel.textContent = '已连接';
      dom.navClientId.textContent = ws.clientId || '';
      dom.navClientId.className = 'nav-badge active';
    } else if (connecting) {
      dom.statusBadge.className = 'status-badge connecting';
      dom.statusLabel.textContent = '连接中...';
      dom.navClientId.textContent = '连接中';
      dom.navClientId.className = 'nav-badge';
    } else {
      dom.statusBadge.className = 'status-badge';
      dom.statusLabel.textContent = '未连接';
      dom.navClientId.textContent = '等待连接';
      dom.navClientId.className = 'nav-badge';
    }

    if (c) {
      dom.infoClientId.textContent = ws.clientId || '—';
    }
  }

  // ── Data Handlers ──
  // ── History ──
  function getApiBase() {
    const addr = dom.serverAddr.value.trim() || 'localhost';
    const port = dom.serverPort.value.trim() || '3000';
    return `http://${addr}:${port}`;
  }

  function loadHistory() {
    if (!state.connected) return;
    const limit = dom.historyRange.value;
    const base = getApiBase();
    fetch(`${base}/api/data?limit=${limit}`)
      .then(res => res.json())
      .then(res => renderHistory(res.data))
      .catch(err => console.warn('History load failed:', err.message));
  }

  function renderHistory(data) {
    const tbody = dom.historyBody;
    if (!data || data.length === 0) {
      tbody.innerHTML = '<tr class="history-empty"><td colspan="8"><span>暂无历史数据</span></td></tr>';
      dom.historyCount.textContent = '0 条';
      return;
    }

    dom.historyCount.textContent = `${data.length} 条`;
    tbody.innerHTML = data.map(r => {
      const time = r.created_at || '--';
      const timeShort = time.length > 16 ? time.slice(5, 16) : time;
      const spo2 = r.spO2 !== null ? `<span class="num-val">${r.spO2}</span>` : '<span class="num-null">—</span>';
      const hr = r.heart_rate !== null ? r.heart_rate : '<span class="num-null">—</span>';
      const dens = r.density !== null ? r.density.toFixed(1) : '<span class="num-null">—</span>';
      const temp = r.temperature !== null ? `${r.temperature}°` : '<span class="num-null">—</span>';
      const humi = r.humidity !== null ? `${r.humidity}%` : '<span class="num-null">—</span>';
      let loc = '<span class="num-null">—</span>';
      if (r.longitude !== null && r.latitude !== null) {
        loc = `${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}`;
      }
      const hasAlarm = r.fall_flag || r.collision_flag;
      const status = hasAlarm
        ? '<span class="badge-alert">告警</span>'
        : '<span class="badge-ok">正常</span>';

      return `<tr>
        <td class="history-time">${timeShort}</td>
        <td>${spo2}</td>
        <td>${hr}</td>
        <td>${dens}</td>
        <td>${temp}</td>
        <td>${humi}</td>
        <td style="font-size:11px;font-family:var(--font-mono)">${loc}</td>
        <td>${status}</td>
      </tr>`;
    }).join('');
  }

  let _histTimer; // 历史刷新防抖
  function onEspData(msg) {
    clearTimeout(_histTimer);
    _histTimer = setTimeout(loadHistory, 2000);
    const data = msg.data;
    state.dataCount++;
    dom.infoDataCount.textContent = state.dataCount;

    addLog('esp', `来自 [${msg.from}] 的数据`);

    if (!state.dataSources.has(msg.from)) {
      state.dataSources.set(msg.from, { type: 'esp01s', msgCount: 0, lastSeen: new Date() });
    }
    const src = state.dataSources.get(msg.from);
    src.msgCount = msg.msgCount || (src.msgCount + 1);
    src.lastSeen = new Date();

    // Parse properties
    let props = null;
    if (data.services && Array.isArray(data.services)) {
      const s = data.services[0];
      if (s && s.properties) props = s.properties;
    } else if (data.data && typeof data.data === 'object') {
      props = data.data;
    } else {
      props = data;
    }

    if (props) updateSensorData(props);
  }

  function onClientJoined(msg) {
    addLog('sys', `客户端加入 [${msg.clientId}] 类型=${msg.clientType}`);
    dom.infoOnlineCount.textContent = msg.onlineCount;
  }

  function onClientLeft(msg) {
    addLog('sys', `客户端离开 [${msg.clientId}]`);
    dom.infoOnlineCount.textContent = msg.onlineCount;
    state.dataSources.delete(msg.clientId);
  }

  // ── Sensor Data Update ──
  function updateSensorData(props) {
    let changed = false;

    const fieldMap = {
      spO2: 'spO2', heart_rate: 'heart_rate',
      dis_hr: 'heart_rate', dis_spo2: 'spO2',
      density: 'density', ppm: 'density',
      temperature: 'temperature', humidity: 'humidity',
      longitude: 'longitude', latitude: 'latitude',
      fall_flag: 'fall_flag', collision_flag: 'collision_flag'
    };

    for (const [key, target] of Object.entries(fieldMap)) {
      if (props[key] !== undefined && props[key] !== null) {
        const val = Number(props[key]);
        if (state.sensorData[target] !== val) {
          state.sensorData[target] = val;
          changed = true;
        }
      }
    }

    if (changed) renderDashboard();
  }

  // ── Render ──
  function renderDashboard() {
    const d = state.sensorData;

    // ── SpO₂ ──
    setNum('val_spO2', d.spO2, '');
    setBar('bar_spO2', d.spO2, 100);
    setCardStatus('status_spO2', d.spO2, v => `SpO₂ ${v}%`);

    // ── Heart Rate ──
    setNum('val_heart_rate', d.heart_rate, '');
    setBar('bar_heart_rate', d.heart_rate, 200);
    setCardStatus('status_heart_rate', d.heart_rate, v => `${v} bpm`);

    // ── Density ──
    setNum('val_density', d.density, '');
    setBar('bar_density', d.density, 100);
    setCardStatus('status_density', d.density, v => `${v.toFixed(1)} ppm`);

    // ── Temperature ──
    setNum('val_temperature', d.temperature, '');
    setBar('bar_temperature', d.temperature, 60);
    setCardStatus('status_temperature', d.temperature, v => `${v}°C`);

    // ── Humidity ──
    setNum('val_humidity', d.humidity, '');
    setBar('bar_humidity', d.humidity, 100);
    setCardStatus('status_humidity', d.humidity, v => `${v}%`);

    // ── Location ──
    const locEl = dom.val_location.querySelector('.num');
    if (d.longitude !== null && d.latitude !== null) {
      const txt = `${d.latitude.toFixed(4)}°N ${d.longitude.toFixed(4)}°E`;
      if (locEl && locEl.textContent !== txt) {
        locEl.textContent = txt;
        flash(locEl);
      }
      setCardStatus('status_location', true, () => '定位成功');
    } else {
      if (locEl) locEl.textContent = '—';
      setCardStatus('status_location', null, () => '等待数据');
    }

    // ── Alarms ──
    updateAlarm('alarm_fall', 'badge_fall', d.fall_flag, '跌倒');
    updateAlarm('alarm_collision', 'badge_collision', d.collision_flag, '碰撞');

    // Alarm summary
    if (d.fall_flag || d.collision_flag) {
      const parts = [];
      if (d.fall_flag) parts.push('跌倒');
      if (d.collision_flag) parts.push('碰撞');
      dom.alarmSummary.textContent = `⚠ ${parts.join(' + ')}`;
      dom.alarmSummary.className = 'alarm-summary warning';
    } else {
      dom.alarmSummary.textContent = '一切正常';
      dom.alarmSummary.className = 'alarm-summary';
    }

    // Activate card top bars
    const keys = ['spO2', 'heart_rate', 'density', 'temperature', 'humidity', 'location'];
    keys.forEach(k => {
      const card = document.querySelector(`.sensor-card[data-key="${k}"]`);
      if (card) {
        if (state.sensorData[k] !== null && state.sensorData[k] !== undefined) {
          card.classList.add('active');
        }
      }
    });
  }

  function setNum(id, val, unit) {
    const el = dom[id];
    if (!el) return;
    const numSpan = el.querySelector('.num');
    const unitSpan = el.querySelector('.unit');
    if (val !== null && val !== undefined) {
      const display = typeof val === 'number' && !Number.isInteger(val) ? val.toFixed(1) : val;
      if (numSpan && numSpan.textContent !== String(display)) {
        numSpan.textContent = display;
        flash(numSpan);
      }
    } else {
      if (numSpan) numSpan.textContent = '—';
    }
  }

  function setBar(id, val, max) {
    const el = dom[id];
    if (!el) return;
    if (val !== null && val !== undefined && max > 0) {
      const pct = Math.min(Math.round((val / max) * 100), 100);
      el.style.width = pct + '%';
    } else {
      el.style.width = '0%';
    }
  }

  function setCardStatus(id, val, formatter) {
    const el = dom[id];
    if (!el) return;
    if (val !== null && val !== undefined) {
      el.textContent = formatter(val);
      el.className = 'card-status received';
    } else {
      el.textContent = '等待数据';
      el.className = 'card-status';
    }
  }

  function updateAlarm(chipId, badgeId, flag, label) {
    const chip = dom[chipId];
    const badge = dom[badgeId];
    if (!chip || !badge) return;

    if (flag) {
      chip.classList.add('active');
      badge.textContent = `❗ ${label}中`;
    } else {
      chip.classList.remove('active');
      badge.textContent = '正常';
    }
  }

  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth; // reflow
    el.classList.add('flash');
  }

  // ── Log ──
  function addLog(tag, text, detail) {
    // Remove empty state
    if (dom.logEmpty) {
      dom.logEmpty.style.display = 'none';
    }

    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const tagClass = tag === 'esp' ? 'tag-esp' : (tag === 'sys' ? 'tag-sys' : 'tag-msg');

    let content = `<span class="time">${time}</span>`;
    content += `<span class="${tagClass}">${escapeHtml(text)}</span>`;

    if (detail) {
      const str = typeof detail === 'string' ? detail : JSON.stringify(detail);
      content += `<span class="detail">${escapeHtml(str)}</span>`;
    }

    entry.innerHTML = content;
    dom.logContainer.appendChild(entry);

    // Count
    const total = dom.logContainer.querySelectorAll('.log-entry').length;
    dom.logCount.textContent = `${total} 条`;

    // Auto scroll
    if (dom.chkAutoScroll.checked) {
      dom.logContainer.scrollTop = dom.logContainer.scrollHeight;
    }

    // Limit
    while (dom.logContainer.children.length > 500) {
      dom.logContainer.removeChild(dom.logContainer.firstChild);
    }
  }

  function clearLog() {
    // 保留 logEmpty 元素，只移除 .log-entry
    dom.logContainer.querySelectorAll('.log-entry').forEach(el => el.remove());
    if (dom.logEmpty) dom.logEmpty.style.display = '';
    dom.logCount.textContent = '0 条';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Settings ──
  function saveSettings() {
    try {
      localStorage.setItem('terminal_serverAddr', dom.serverAddr.value);
      localStorage.setItem('terminal_serverPort', dom.serverPort.value);
    } catch {}
  }

  function loadSettings() {
    try {
      const addr = localStorage.getItem('terminal_serverAddr');
      const port = localStorage.getItem('terminal_serverPort');
      if (addr) dom.serverAddr.value = addr;
      if (port) dom.serverPort.value = port;
    } catch {}
  }

  // ── Start ──
  document.addEventListener('DOMContentLoaded', init);
})();
