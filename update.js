/*
  从上游仓库更新 index.html，并自动补回共享同步的注入行。
  用法：node update.js        （或双击 更新.bat）
*/
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const TARGET = path.join(ROOT, 'index.html');
const BACKUP_DIR = path.join(ROOT, 'backups');
const REPO = 'cyberdaddyleo/workstation-teacher';
const URL_RAW = 'https://api.github.com/repos/' + REPO + '/contents/index.html';
const INJECT = '<script src="sync-client.js"></script>';
const MARK = 'BZR-SYNC-INJECT';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/vnd.github.raw', 'User-Agent': 'teacher-workbench-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function inject(html) {
  if (html.indexOf(INJECT) >= 0) return { html, injected: false };
  const anchor = '<div id="tip" class="tip"></div>';
  const at = html.indexOf(anchor);
  if (at < 0) throw new Error('找不到注入锚点（<div id="tip" class="tip"></div>），上游结构可能变了，请手动在 <script> 前加一行：' + INJECT);
  const cut = at + anchor.length;
  const patched = html.slice(0, cut) +
    '\n<!-- ' + MARK + ': 班级共享同步层（本地部署新增，勿删） -->\n' + INJECT +
    html.slice(cut);
  return { html: patched, injected: true };
}

(async () => {
  console.log('正在从 ' + REPO + ' 拉取最新 index.html ...');
  let remote;
  try {
    remote = await get(URL_RAW);
  } catch (e) {
    console.error('下载失败：' + e.message);
    console.error('请检查网络，或手动到 https://github.com/' + REPO + ' 下载 index.html 覆盖（然后用记事本把下面这行加在 <div id="tip"> 之后）：');
    console.error('  ' + INJECT);
    process.exit(1);
  }

  if (!/function boot\(\)/.test(remote) || remote.length < 100000) {
    console.error('下载内容不像 index.html（长度 ' + remote.length + '），已中止，原文件未改动。');
    process.exit(1);
  }

  let patched;
  try {
    patched = inject(remote);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (fs.existsSync(TARGET)) {
    fs.copyFileSync(TARGET, path.join(BACKUP_DIR, 'index-' + stamp + '.html'));
    console.log('已备份原文件 → backups/index-' + stamp + '.html');
  }

  const tmp = TARGET + '.new';
  fs.writeFileSync(tmp, patched.html, 'utf8');
  fs.renameSync(tmp, TARGET);

  console.log('更新完成，共 ' + patched.html.length + ' 字符。');
  console.log(patched.injected ? '已自动补回同步层注入行。' : '同步层注入行原本就在，未改动。');
  console.log('刷新浏览器页面即可生效（服务无需重启）。');
})().catch((e) => {
  console.error('意外错误：' + e.message);
  process.exit(1);
});
