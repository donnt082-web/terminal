const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'data', 'sensor_data.db'), { readonly: true });

const PORT = 8090;

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/data') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 50000);
    const rows = db.prepare(`
      SELECT
        MAX(id) AS id,
        created_at,
        client_id,
        MAX(spO2)           AS spO2,
        MAX(heart_rate)     AS heart_rate,
        MAX(density)        AS density,
        MAX(temperature)    AS temperature,
        MAX(humidity)       AS humidity,
        MAX(longitude)      AS longitude,
        MAX(latitude)       AS latitude,
        MAX(fall_flag)      AS fall_flag,
        MAX(collision_flag) AS collision_flag
      FROM sensor_data
      GROUP BY client_id, created_at
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
    const total = db.prepare('SELECT COUNT(DISTINCT client_id || created_at) AS c FROM sensor_data').get().c;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total, rows }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>智能安全帽 - 数据库表</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; margin: 0; padding: 16px; background: #f5f5f7; }
  h2 { margin: 0 0 12px 0; color: #1d1d1f; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
  .toolbar input, .toolbar select, .toolbar button { padding: 6px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px; }
  .toolbar button { background: #007aff; color: white; border: none; cursor: pointer; }
  .toolbar button:hover { background: #0051d5; }
  .stats { color: #666; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th, td { padding: 8px 12px; text-align: right; border-bottom: 1px solid #eaeaea; font-size: 13px; }
  th { background: #fafafa; cursor: pointer; user-select: none; position: sticky; top: 0; font-weight: 600; }
  th:hover { background: #f0f0f0; }
  th.asc::after { content: ' ▲'; color: #007aff; }
  th.desc::after { content: ' ▼'; color: #007aff; }
  td.text, th.text { text-align: left; }
  tr:hover td { background: #f9f9fb; }
  .alert-row { background: #ffebeb; font-weight: bold; color: #d70015; }
  .badge-ok { color: #34c759; }
  .badge-warn { color: #ff3b30; font-weight: bold; }
  .container { max-height: calc(100vh - 100px); overflow: auto; border-radius: 8px; }
</style>
</head>
<body>
<h2>智能安全帽传感器数据 (sensor_data)</h2>
<div class="toolbar">
  <label>显示条数 <select id="limit">
    <option value="100">100</option>
    <option value="500" selected>500</option>
    <option value="1000">1000</option>
    <option value="5000">5000</option>
    <option value="50000">全部</option>
  </select></label>
  <input id="filter" placeholder="筛选（任意列含此文字）" style="flex:1; min-width:200px;">
  <button onclick="load()">🔄 刷新</button>
  <span class="stats" id="stats"></span>
</div>
<div class="container"><table id="tbl">
  <thead><tr>
    <th class="text" data-key="id">id</th>
    <th class="text" data-key="created_at">时间</th>
    <th class="text" data-key="client_id">设备</th>
    <th data-key="spO2">spO2</th>
    <th data-key="heart_rate">心率</th>
    <th data-key="density">气体浓度</th>
    <th data-key="temperature">温度</th>
    <th data-key="humidity">湿度</th>
    <th data-key="longitude">经度</th>
    <th data-key="latitude">纬度</th>
    <th data-key="has_alert">状态</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table></div>

<script>
let data = [];
let sortKey = 'id', sortDir = 'desc';

async function load() {
  const limit = document.getElementById('limit').value;
  const r = await fetch('/api/data?limit=' + limit);
  const j = await r.json();
  data = j.rows;
  document.getElementById('stats').textContent = '已显示 ' + j.rows.length + ' / 总计 ' + j.total + ' 条';
  render();
}

function render() {
  const filter = document.getElementById('filter').value.trim().toLowerCase();
  let view = data;
  if (filter) {
    view = data.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(filter)));
  }
  view = [...view].sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number') return sortDir === 'asc' ? va - vb : vb - va;
    return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });

  document.querySelectorAll('th').forEach(th => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.key === sortKey) th.classList.add(sortDir);
  });

  const tb = document.getElementById('tbody');
  tb.innerHTML = view.map(r => {
    const hasAlert = r.fall_flag || r.collision_flag;
    const statusHtml = hasAlert
      ? '<span class="badge-warn">⚠ 警告</span>'
      : '<span class="badge-ok">正常</span>';
    return '<tr' + (hasAlert ? ' class="alert-row"' : '') + '>' +
      '<td class="text">' + r.id + '</td>' +
      '<td class="text">' + r.created_at + '</td>' +
      '<td class="text">admin</td>' +
      '<td>' + (r.spO2 ?? '-') + '</td>' +
      '<td>' + (r.heart_rate ?? '-') + '</td>' +
      '<td>' + (r.density != null ? r.density.toFixed(2) : '-') + '</td>' +
      '<td>' + (r.temperature ?? '-') + '</td>' +
      '<td>' + (r.humidity ?? '-') + '</td>' +
      '<td>' + (r.longitude != null ? r.longitude.toFixed(4) : '-') + '</td>' +
      '<td>' + (r.latitude != null ? r.latitude.toFixed(4) : '-') + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '</tr>';
  }).join('');
}

document.querySelectorAll('th').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.key;
    if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = k; sortDir = 'desc'; }
    render();
  });
});
document.getElementById('filter').addEventListener('input', render);
document.getElementById('limit').addEventListener('change', load);

load();
</script>
</body>
</html>`);
}).listen(PORT, () => {
  console.log('📊 数据库表格视图已启动: http://localhost:' + PORT);
});
