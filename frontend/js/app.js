/**
 * 智能安全帽终端 - 主应用逻辑
 * Apple 设计语言 · 细腻动效 · 丰富内容
 * (业务核心未改动：WS连接管理、数据解析、转发渲染)
 */
(function () {
  'use strict';

  // 固定定位：黑龙江科技大学（松北校区）
  const FIXED_LOCATION = { name: '黑龙江科技大学', lat: 45.8300, lng: 126.5500 };

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
    dataSources: new Map(),
    // 图表状态：多指标合并图，记录每个指标是否显示
    chartMetrics: {
      spO2:        { label: '血氧', color: '--color-spo2', visible: true },
      heart_rate:  { label: '心率', color: '--color-heart', visible: true },
      density:     { label: '浓度', color: '--color-gas', visible: true },
      temperature: { label: '温度', color: '--color-temp', visible: true },
      humidity:    { label: '湿度', color: '--color-humi', visible: true }
    },
    historyData: []
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
    historyRange: $('historyRange'),
    // Chart
    chartLegend: $('chartLegend'),
    historyChart: $('historyChart'),
    chartEmpty: $('chartEmpty')
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

    // Chart 图例点击：切换该指标曲线显隐
    dom.chartLegend.addEventListener('click', (e) => {
      const item = e.target.closest('.chart-legend-item');
      if (!item) return;
      const metric = item.dataset.metric;
      const m = state.chartMetrics[metric];
      if (!m) return;
      m.visible = !m.visible;
      item.classList.toggle('active', m.visible);
      drawChart();
    });
    // 初始化图例圆点颜色
    dom.chartLegend.querySelectorAll('.chart-legend-item').forEach(item => {
      const c = getComputedStyle(document.documentElement).getPropertyValue(item.dataset.color).trim();
      const dot = item.querySelector('.legend-dot');
      if (dot) dot.style.setProperty('--dot-color', c);
    });

    // 设备控制开关（LED / 风扇）
    document.querySelectorAll('.ctrl-switch').forEach(sw => {
      sw.addEventListener('click', () => {
        if (!state.connected) {
          addLog('sys', '未连接到服务器，无法发送控制命令');
          return;
        }
        const target = sw.dataset.target;
        const wasOn = sw.getAttribute('aria-checked') === 'true';
        const nextOn = !wasOn;

        const ok = ws.send({
          type: 'control',
          action: 'toggle',
          target,
          value: nextOn ? 'on' : 'off'
        });
        if (!ok) return;

        sw.setAttribute('aria-checked', String(nextOn));
        const card = sw.closest('.control-card');
        const stateEl = document.getElementById('state_' + target);
        if (card) card.classList.toggle('is-on', nextOn);
        if (stateEl) stateEl.textContent = nextOn ? '已开启' : '已关闭';
        addLog('out', `控制 ${target} = ${nextOn ? '开' : '关'}`);
      });
    });

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

    // 控制按钮：未连接时禁用 + 提示
    document.querySelectorAll('.ctrl-switch').forEach(b => b.disabled = !c);
    const hint = document.getElementById('controlHint');
    if (hint) hint.textContent = c ? '已就绪' : '未连接';
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
    state.historyData = data || [];
    drawChart();
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
      const loc = `${FIXED_LOCATION.lat.toFixed(2)}, ${FIXED_LOCATION.lng.toFixed(2)}`;
      const hasAlarm = r.fall_flag || r.collision_flag;
      const status = hasAlarm
        ? '<span class="badge-alert">警告</span>'
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

  // ── 历史趋势折线图（纯 SVG，多指标合并，各自归一化）──
  function drawChart() {
    const svg = dom.historyChart;
    // 历史接口按 id DESC 返回（最新在前），画图要按时间正序
    const rows = [...state.historyData].reverse();

    // 视图坐标系（viewBox 固定，preserveAspectRatio=none 拉伸填满）
    const W = 600, H = 220;
    const padL = 12, padR = 12, padT = 14, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // 收集每个可见指标的有效数据点
    const series = [];
    let timeLabels = null;
    Object.keys(state.chartMetrics).forEach(metric => {
      const m = state.chartMetrics[metric];
      if (!m.visible) return;
      const pts = rows
        .map(r => ({ v: r[metric], t: r.created_at }))
        .filter(p => p.v !== null && p.v !== undefined && !isNaN(p.v));
      if (pts.length < 2) return;
      const vals = pts.map(p => Number(p.v));
      let min = Math.min(...vals), max = Math.max(...vals);
      if (min === max) { min -= 1; max += 1; } // 平直线兜底
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue(m.color).trim() || '#007aff';
      series.push({ metric, label: m.label, color, pts, vals, min, max });
      if (!timeLabels || pts.length > timeLabels.length) {
        timeLabels = pts.map(p => p.t);
      }
    });

    if (series.length === 0) {
      svg.innerHTML = '';
      dom.chartEmpty.classList.remove('hidden');
      return;
    }
    dom.chartEmpty.classList.add('hidden');

    drawChartSvg(svg, series, timeLabels, { W, H, padL, padR, padT, padB, plotW, plotH });
  }

  // 生成多曲线 SVG 内容（每条曲线按自身 min~max 归一化到画布高度）
  function drawChartSvg(svg, series, timeLabels, g) {
    svg.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
    let svgStr = '';

    // 横向网格线（4 等分，仅作参考，不标数值——因多曲线量纲不同）
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const yy = g.padT + g.plotH - (g.plotH * i) / ticks;
      svgStr += `<line x1="${g.padL}" y1="${yy.toFixed(1)}" x2="${g.W - g.padR}" y2="${yy.toFixed(1)}" stroke="#ececed" stroke-width="1"/>`;
    }

    // 每条曲线：归一化 + 折线 + 端点
    series.forEach(s => {
      const n = s.pts.length;
      const top = s.max + (s.max - s.min) * 0.08;
      const bot = s.min - (s.max - s.min) * 0.08;
      const x = i => g.padL + (g.plotW * i) / (n - 1);
      const y = v => g.padT + g.plotH - (g.plotH * (v - bot)) / (top - bot);

      const line = s.pts.map((p, i) => `${x(i).toFixed(1)},${y(Number(p.v)).toFixed(1)}`).join(' ');
      svgStr += `<polyline points="${line}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

      // 端点（点少时全标，点多只标末点）
      const showDots = n <= 20;
      s.pts.forEach((p, i) => {
        if (showDots || i === n - 1) {
          svgStr += `<circle cx="${x(i).toFixed(1)}" cy="${y(Number(p.v)).toFixed(1)}" r="2.2" fill="#fff" stroke="${s.color}" stroke-width="1.5"/>`;
        }
      });

      // 末点数值标签（显示真实值，避免归一化看不出数值）
      const lastV = Number(s.pts[n - 1].v);
      const lx = x(n - 1), ly = y(lastV);
      svgStr += `<text x="${(lx - 4).toFixed(1)}" y="${(ly - 5).toFixed(1)}" font-size="9" fill="${s.color}" text-anchor="end">${lastV % 1 === 0 ? lastV : lastV.toFixed(1)}</text>`;
    });

    // X 轴首尾时间标签
    const fmt = t => (t && t.length > 16 ? t.slice(5, 16) : (t || ''));
    if (timeLabels && timeLabels.length) {
      svgStr += `<text x="${g.padL}" y="${g.H - 7}" font-size="10" fill="#aeaeb2" text-anchor="start">${fmt(timeLabels[0])}</text>`;
      svgStr += `<text x="${g.W - g.padR}" y="${g.H - 7}" font-size="10" fill="#aeaeb2" text-anchor="end">${fmt(timeLabels[timeLabels.length - 1])}</text>`;
    }

    svg.innerHTML = svgStr;
  }

  let _histTimer; // 历史刷新节流：收到数据后最多每 2 秒刷新一次图表（保证会刷，不会被无限重置）
  function onEspData(msg) {
    if (!_histTimer) {
      _histTimer = setTimeout(() => {
        _histTimer = null;
        loadHistory();
      }, 2000);
    }
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

    // ── Location（固定为黑龙江科技大学）──
    const locEl = dom.val_location.querySelector('.num');
    const txt = `${FIXED_LOCATION.lat.toFixed(4)}°N ${FIXED_LOCATION.lng.toFixed(4)}°E`;
    if (locEl && locEl.textContent !== txt) {
      locEl.textContent = txt;
      flash(locEl);
    }
    setCardStatus('status_location', true, () => FIXED_LOCATION.name);

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
