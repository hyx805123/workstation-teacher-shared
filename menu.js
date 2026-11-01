/*
  班主任工作台 · 工具菜单
  由 工具.bat 调用：node menu.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const ROOT = __dirname;
const NODE = process.execPath;

const ITEMS = [
  ['1', '启动共享服务并打开工作台', 'start'],
  ['2', '仅本机模式打开（外出/公共 WiFi）', 'local'],
  ['3', '部署自检（换电脑后先跑这个）', 'check'],
  ['4', '回滚到历史版本', 'rollback'],
  ['5', '打包分发（不含数据）', 'pack'],
  ['6', '打包分发（含班级数据，迁移用）', 'packdata'],
  ['7', '从上游更新到新版本', 'update'],
  ['8', '打开部署手册', 'doc'],
  ['9', '打开数据目录', 'data'],
  ['0', '退出', 'exit']
];

function banner() {
  console.log('');
  console.log('============================================================');
  console.log('   班主任工作台 · 工具菜单');
  console.log('   ' + ROOT);
  console.log('============================================================');
  const ok = healthSync();
  console.log('   服务状态：' + (ok ? '运行中  http://127.0.0.1:8080' : '未启动'));
  console.log('------------------------------------------------------------');
  ITEMS.forEach(([k, label]) => console.log('   ' + k + ') ' + label));
  console.log('------------------------------------------------------------');
}

function healthSync() {
  try {
    const http = require('http');
    const { execFileSync } = require('child_process');
    // 用 curl 做一次极短的同步探测，避免异步打乱菜单
    const out = execFileSync('curl.exe', ['-s', '-m', '2', '-o', 'NUL', '-w', '%{http_code}', 'http://127.0.0.1:8080/api/health'], { encoding: 'utf8' });
    return String(out).trim() === '200';
  } catch (e) {
    return false;
  }
}

function runNode(script, args) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [path.join(ROOT, script)].concat(args || []), { stdio: 'inherit', cwd: ROOT });
    p.on('exit', () => resolve());
    p.on('error', (e) => { console.log('启动失败：' + e.message); resolve(); });
  });
}

function runVbs(file) {
  try {
    const p = spawn('wscript.exe', [path.join(ROOT, file)], { detached: true, stdio: 'ignore', cwd: ROOT });
    p.unref();
    console.log('已调用 ' + file + '（服务在后台启动，页面几秒后打开）');
  } catch (e) {
    console.log('调用失败：' + e.message);
    console.log('请手动双击 ' + file);
  }
}

function openPath(target) {
  try {
    const p = spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' });
    p.unref();
    console.log('已打开：' + target);
  } catch (e) {
    console.log('打开失败：' + e.message);
  }
}

async function handle(action) {
  switch (action) {
    case 'start':
      runVbs('start-workbench.vbs');
      break;
    case 'local':
      runVbs('start-local.vbs');
      break;
    case 'check':
      await runNode('check.js');
      break;
    case 'rollback':
      await runNode('rollback.js');
      break;
    case 'pack':
      await runNode('pack.js');
      break;
    case 'packdata':
      await runNode('pack.js', ['--with-data']);
      break;
    case 'update':
      await runNode('update.js');
      break;
    case 'doc':
      openPath(path.join(ROOT, '部署手册.md'));
      break;
    case 'data':
      fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
      openPath(path.join(ROOT, 'data'));
      break;
    default:
      break;
  }
}

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  function ask(q) {
    return new Promise((resolve) => rl.question(q, resolve));
  }

  while (true) {
    banner();
    const ans = (await ask('   请选择：')).trim();
    const hit = ITEMS.find((i) => i[0] === ans);
    console.log('');

    if (!hit) { continue; }
    if (hit[2] === 'exit') break;

    await handle(hit[2]);

    if (hit[2] === 'start' || hit[2] === 'local') break; // 启动后就退出菜单
    await ask('   按回车返回菜单 ...');
  }

  rl.close();
})();
