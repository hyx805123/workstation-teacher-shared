/*
  班主任工作台 · 部署自检
  由 自检.bat 调用：node check.js
  退出码：0 全部正常 / 1 有致命问题
*/
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = __dirname;
const PORT = 8080;
const lines = [];
let fail = 0, warn = 0;

const ok = (m) => lines.push('  [OK]   ' + m);
const bad = (m) => { lines.push('  [FAIL] ' + m); fail += 1; };
const hint = (m) => { lines.push('  [WARN] ' + m); warn += 1; };
const info = (m) => lines.push('  [i]    ' + m);
const head = (m) => { lines.push(''); lines.push(m); };

lines.push('============================================================');
lines.push('  班主任工作台 · 共享版 部署自检');
lines.push('  目录：' + ROOT);
lines.push('============================================================');

/* ---------- 1. 运行环境 ---------- */
head('1. 运行环境');
const major = Number(process.version.replace('v', '').split('.')[0]);
if (major >= 18) ok('Node.js ' + process.version + '  (' + process.execPath + ')');
else bad('Node.js ' + process.version + ' 版本过低，需要 18 或以上：https://nodejs.org');
if (process.platform === 'win32') ok('操作系统 Windows');
else hint('当前不是 Windows，启动器（.vbs/.bat）不可用，请手动运行 node sync-server.js');

/* ---------- 2. 文件完整性 ---------- */
head('2. 文件完整性');
const required = [
  ['index.html', '工作台本体'],
  ['sync-client.js', '同步客户端（接管 save / 实时刷新）'],
  ['sync-server.js', '同步服务（数据源 / 合并 / 推送）']
];
required.forEach(([f, desc]) => {
  if (fs.existsSync(path.join(ROOT, f))) ok(f + ' — ' + desc);
  else bad('缺少 ' + f + ' — ' + desc);
});
const optional = [
  ['start-workbench.vbs', '共享模式启动器'],
  ['start-local.vbs', '仅本机启动器'],
  ['start-service.vbs', '开机自启脚本'],
  ['update.js', '上游更新工具'],
  ['rollback.js', '历史版本回滚'],
  ['pack.js', '打包分发']
];
optional.forEach(([f, desc]) => {
  if (fs.existsSync(path.join(ROOT, f))) ok(f + ' — ' + desc);
  else hint('缺少 ' + f + '（' + desc + '），对应功能不可用');
});

/* ---------- 3. 注入层 ---------- */
head('3. 同步层注入');
try {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (html.indexOf('sync-client.js') >= 0) ok('index.html 已引用 sync-client.js');
  else bad('index.html 缺少 sync-client.js 引用，共享功能不会生效。执行 node update.js 可自动补回');
  if (/function boot\(\)/.test(html)) ok('index.html 结构正常');
  else bad('index.html 结构异常，可能下载不完整，请重新获取');
  if (html.length < 100000) bad('index.html 体积异常（' + html.length + ' 字符），可能被截断');
} catch (e) {
  bad('index.html 读取失败：' + e.message);
}

/* ---------- 4. 服务与端口 ---------- */
head('4. 服务状态');
function health(cb) {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 2500 }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => {
      try { cb(null, res.statusCode, JSON.parse(buf)); }
      catch (e) { cb(null, res.statusCode, null); }
    });
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', (e) => cb(e));
}

health((err, code, data) => {
  if (!err && code === 200 && data && data.ok) {
    ok('服务接口正常 http://127.0.0.1:' + PORT + '  当前数据版本 v' + data.version);
    if (data.hasState) ok('已有班级数据，提交人：' + (data.updatedBy || '尚未记录'));
    else info('服务器还没有班级数据 — 谁第一个打开工作台并建班，谁的数据就成为全班共享的初始数据');
  } else if (err) {
    hint('服务未启动（' + err.message + '）。双击 start-workbench.vbs 启动后再自检');
  } else {
    bad('服务返回异常 HTTP ' + code + '，查看 service.log');
  }

  /* ---------- 5. 数据目录 ---------- */
  head('5. 数据与备份');
  const stateFile = path.join(ROOT, 'data', 'state.json');
  if (fs.existsSync(stateFile)) {
    const kb = Math.round(fs.statSync(stateFile).size / 1024);
    ok('data/state.json 存在（' + kb + ' KB）');
    const vdir = path.join(ROOT, 'data', 'versions');
    if (fs.existsSync(vdir)) {
      const n = fs.readdirSync(vdir).filter((f) => /^v\d{8}\.json$/.test(f)).length;
      ok('历史快照 ' + n + ' 份（最多保留 30 份，可回滚）');
    }
  } else {
    info('还没有 data/ 数据目录，首次提交后会自动生成');
  }

  /* ---------- 6. 网络地址 ---------- */
  head('6. 同事可用的访问地址');
  const nets = os.networkInterfaces();
  const ips = [];
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((a) => {
      if (a.family === 'IPv4' && !a.internal) ips.push({ name, ip: a.address });
    });
  });
  if (!ips.length) hint('没有检测到局域网地址，可能没连网络');
  ips.forEach((x) => lines.push('         http://' + x.ip + ':' + PORT + '/    （' + x.name + '）'));
  const primary = ips.filter((x) => x.ip.indexOf('169.254') !== 0);
  if (primary.length > 1) info('有多块网卡，请选和同事在同一网段的那个地址');
  if (ips.some((x) => x.ip.indexOf('169.254') === 0)) hint('存在 169.254.x.x 地址，说明该网卡没拿到 IP，别用这个');

  /* ---------- 7. 防火墙 ---------- */
  head('7. 局域网访问');
  lines.push('         若同事打不开，右键「开启局域网访问.bat」→ 以管理员身份运行');
  lines.push('         （只放行专用/域网络，公共 WiFi 不对外开放）');

  /* ---------- 结论 ---------- */
  lines.push('');
  lines.push('============================================================');
  if (fail > 0) lines.push('  结论：发现 ' + fail + ' 个致命问题，按上面 [FAIL] 逐条处理后重新自检');
  else if (warn > 0) lines.push('  结论：可以使用，但有 ' + warn + ' 个提醒项（通常是服务还没启动）');
  else lines.push('  结论：全部通过，可以正常使用（共享模式）');
  lines.push('============================================================');

  console.log(lines.join('\n'));
  process.exit(fail > 0 ? 1 : 0);
});
