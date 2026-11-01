/*
  班主任工作台 · 打包分发
  由 打包.bat 调用：
      node pack.js            干净部署包（不含 data 运行数据）
      node pack.js --with-data  连同当前班级数据（迁移到新设备用）
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const PARENT = path.dirname(ROOT);
const DIR_NAME = path.basename(ROOT);
const WITH_DATA = process.argv.indexOf('--with-data') >= 0;

const d = new Date();
const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const pkgName = '班主任工作台-共享版-' + stamp + (WITH_DATA ? '-含数据' : '');
const outFile = path.join(PARENT, pkgName + '.zip');

// Windows 自带 bsdtar，支持直接写 zip
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
if (!fs.existsSync(TAR)) {
  console.error('[失败] 找不到系统自带的 tar.exe（' + TAR + '）。');
  console.error('       替代办法：手动把整个文件夹拷到 U 盘，删除 data/、backups/、service.log 即可。');
  process.exit(1);
}

if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

const args = ['-a', '-c', '-f', outFile,
  '--exclude', DIR_NAME + '/backups/*',
  '--exclude', DIR_NAME + '/service.log',
  '--exclude', DIR_NAME + '/*.zip',
  '--exclude', DIR_NAME + '/*.tmp'
];
if (!WITH_DATA) args.push('--exclude', DIR_NAME + '/data/*');
args.push('-C', PARENT, DIR_NAME);

console.log('============================================================');
console.log('  正在打包 ...');
console.log('  源目录：' + ROOT);
console.log('  输出：  ' + outFile);
console.log('  模式：  ' + (WITH_DATA ? '含班级数据（迁移用）' : '干净部署包（不含 data）'));
console.log('============================================================');
console.log('');

try {
  execFileSync(TAR, args, { stdio: 'inherit' });
} catch (e) {
  console.error('[失败] 打包出错：' + e.message);
  process.exit(1);
}

if (!fs.existsSync(outFile)) {
  console.error('[失败] 没有生成压缩包。');
  process.exit(1);
}

const size = fs.statSync(outFile).size;
const mb = (size / 1024 / 1024).toFixed(2);
console.log('');
console.log('打包完成：' + outFile + '  (' + mb + ' MB)');
console.log('');
console.log('在新设备上使用：');
console.log('  1) 把 zip 拷过去，解压到任意位置，例如 C:\\Apps\\');
console.log('  2) 安装 Node.js 18+（https://nodejs.org，勾选 Add to PATH）');
console.log('  3) 双击「自检.bat」，全绿后再往下');
console.log('  4) 双击「start-workbench.vbs」启动');
console.log('');
if (WITH_DATA) {
  console.log('注意：本包含学生姓名、家庭情况、家长电话等隐私数据，');
  console.log('      只通过 U 盘或校内共享盘传输，不要发微信/QQ 群。');
  console.log('');
}
