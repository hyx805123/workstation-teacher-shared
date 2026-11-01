/*
  班主任工作台 · 历史版本回滚
  用法：
      node rollback.js              列出所有可回滚的快照
      node rollback.js 12           回滚到 v00000012
      node rollback.js --last       回滚到上一个版本
  安全措施：
      - 回滚前自动把当前 state.json 备份到 backups/
      - 回滚后版本号取「当前最大版本 + 1」，不会覆盖任何历史快照
      - 回滚完成后需重启服务（关闭 node 进程后重新启动）
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const VER_DIR = path.join(DATA_DIR, 'versions');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(ROOT, 'backups');

function die(msg) { console.error('[失败] ' + msg); process.exit(1); }

if (!fs.existsSync(VER_DIR)) die('没有找到 data/versions 目录，说明还没有任何提交记录。');

const files = fs.readdirSync(VER_DIR).filter((f) => /^v\d{8}\.json$/.test(f)).sort();
if (!files.length) die('data/versions 里没有快照文件。');

const versions = files.map((f) => ({
  n: parseInt(f.slice(1, 9), 10),
  file: path.join(VER_DIR, f),
  mtime: fs.statSync(path.join(VER_DIR, f)).mtime
})).sort((a, b) => b.n - a.n);

const maxVersion = versions[0].n;
const arg = process.argv[2];

/* ---------- 只列清单 ---------- */
if (!arg) {
  console.log('可回滚的历史版本（最新在前）：\n');
  console.log('  版本     文件生成时间            学生数');
  console.log('  ------------------------------------------------------');
  versions.forEach((v) => {
    let students = '-';
    let name = '';
    try {
      const s = JSON.parse(fs.readFileSync(v.file, 'utf8'));
      if (Array.isArray(s.students)) students = s.students.length + ' 人';
      name = (s.settings && s.settings.className) || '';
    } catch (e) { students = '(文件损坏)'; }
    const t = v.mtime.toLocaleString('zh-CN');
    console.log('  v' + String(v.n).padStart(8, '0') + '  ' + t.padEnd(22, ' ') + '  ' + students + '  ' + name);
  });
  console.log('\n回滚命令：  node rollback.js 版本号       例如 node rollback.js ' + versions[versions.length > 1 ? 1 : 0].n);
  console.log('回滚后记得重启服务。');
  process.exit(0);
}

/* ---------- 执行回滚 ---------- */
let target;
if (arg === '--last') {
  target = versions.find((v) => v.n < maxVersion);
  if (!target) die('只有一个版本，无法回滚到上一个。');
} else {
  const n = parseInt(arg, 10);
  if (!n || n < 0) die('版本号不合法：' + arg);
  target = versions.find((v) => v.n === n);
  if (!target) die('找不到版本 v' + String(n).padStart(8, '0') + '，先不带参数运行看看有哪些。');
}

let snapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(target.file, 'utf8'));
} catch (e) {
  die('快照文件损坏：' + e.message);
}
if (!snapshot || !Array.isArray(snapshot.students)) die('快照内容不像有效数据，已中止。');

// 备份当前数据
if (fs.existsSync(STATE_FILE)) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = path.join(BACKUP_DIR, 'state-before-rollback-' + stamp + '.json');
  fs.copyFileSync(STATE_FILE, bak);
  console.log('已备份当前数据 → ' + bak);
}

const newVersion = maxVersion + 1;
const payload = {
  version: newVersion,
  updatedAt: Date.now(),
  updatedBy: '回滚到 v' + String(target.n).padStart(8, '0'),
  state: snapshot
};

const tmp = STATE_FILE + '.new';
fs.writeFileSync(tmp, JSON.stringify(payload, 'utf8'));
fs.renameSync(tmp, STATE_FILE);

console.log('');
console.log('回滚完成：');
console.log('  来源快照：' + path.basename(target.file) + '  （' + snapshot.students.length + ' 名学生）');
console.log('  新版本号：v' + String(newVersion).padStart(8, '0'));
console.log('  当前数据已写入 data/state.json');
console.log('');
console.log('下一步：重启服务（任务管理器结束 node.exe，或关掉启动窗口后重新双击 start-workbench.vbs）。');
console.log('同事刷新页面即可看到回滚后的数据。');
