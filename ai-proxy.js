#!/usr/bin/env node
/*
  班主任工作台 · 本地 AI 中转（可选）
  作用：有些 AI 服务商不允许网页直接调用（浏览器跨域限制），用它在本机转发一下即可。
  要求：电脑装有 Node.js 18 或以上版本（https://nodejs.org），无需安装任何依赖。

  用法：
    1. 在这个文件所在的文件夹打开终端，运行：node ai-proxy.js
    2. 在工作台「设置 → AI 接口」里，把接口地址改成：
         http://127.0.0.1:8787/ + 原来的地址
       例如：http://127.0.0.1:8787/https://api.deepseek.com
    3. 用的时候保持这个窗口开着；只监听本机 127.0.0.1，局域网其他电脑访问不到。

  Developed by @赛博老爸
*/
var http = require('http');
var https = require('https');
var URL = require('url').URL;
var PORT = +(process.env.PORT || 8787);
var SKIP = { host: 1, origin: 1, referer: 1, connection: 1, 'content-length': 1 };

http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  var target = decodeURIComponent(req.url.slice(1));
  if (!/^https?:\/\//.test(target)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('AI 中转运行中。请在工作台把接口地址改成：http://127.0.0.1:' + PORT + '/https://你的服务商地址');
    return;
  }
  var u;
  try { u = new URL(target); } catch (e) { res.writeHead(400); res.end('地址格式不对'); return; }

  var headers = {};
  Object.keys(req.headers).forEach(function (k) { if (!SKIP[k]) headers[k] = req.headers[k]; });
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    var body = Buffer.concat(chunks);
    if (body.length) headers['content-length'] = body.length;
    var lib = u.protocol === 'https:' ? https : http;
    var up = lib.request(u, { method: req.method, headers: headers }, function (r) {
      var h = {};
      Object.keys(r.headers).forEach(function (k) { if (k.indexOf('access-control-') !== 0) h[k] = r.headers[k]; });
      h['Access-Control-Allow-Origin'] = '*';
      res.writeHead(r.statusCode || 502, h);
      r.pipe(res);
    });
    up.on('error', function (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('中转失败：' + e.message);
    });
    up.end(body);
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('AI 中转已启动 → http://127.0.0.1:' + PORT + '/');
  console.log('在工作台把接口地址改成：http://127.0.0.1:' + PORT + '/ + 原地址，例如 http://127.0.0.1:' + PORT + '/https://api.deepseek.com');
  console.log('按 Ctrl + C 关闭');
});
