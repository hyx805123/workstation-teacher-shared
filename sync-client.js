'use strict';
/*
  班主任工作台 · 共享同步客户端（旁挂注入，不修改原作者逻辑）
  用法：在 index.html 主脚本之前引入本文件：
        <script src="sync-client.js"></script>

  工作方式：
    1) 主脚本执行前，把「上次从服务器同步到的缓存」写回应用的存储键，让 boot() 照常读到最新数据；
    2) 主脚本执行后，接管 window.save —— 保留原有本地写入，追加推送到 /api/state；
    3) 通过 SSE 接收其他老师的改动，直接覆盖全局 S 并重绘；
    4) 断网 / 服务未启动时自动退回单机 localStorage，改动打脏标记，恢复后自动补推。

  开发者：本地部署改造层
*/
(function () {
  var STATE_KEY = 'bzr-workbench-v1';   // 与 index.html 中的 STORE_KEY 保持一致
  var CACHE_KEY = 'bzr-sync-cache';
  var META_KEY = 'bzr-sync-meta';
  var CLIENT_KEY = 'bzr-sync-client';
  var DIRTY_KEY = 'bzr-sync-dirty';
  var API = '/api/state';
  var POLL_MS = 4000;

  var meta = { version: 0 };
  var client = { id: '', name: '' };
  var pushing = false, pendingPush = false, pendingRefresh = false;
  var online = false, applying = false, es = null, pollTimer = null;
  var statusText = '未连接';

  /* ---------------- 身份 ---------------- */
  function loadClient() {
    try {
      var raw = localStorage.getItem(CLIENT_KEY);
      if (raw) client = JSON.parse(raw);
    } catch (e) { /* ignore */ }
    if (!client.id) client.id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!client.name) client.name = '';
    saveClient();
  }
  function saveClient() {
    try { localStorage.setItem(CLIENT_KEY, JSON.stringify(client)); } catch (e) { /* ignore */ }
  }

  function loadMeta() {
    try { meta = JSON.parse(localStorage.getItem(META_KEY) || '{"version":0}'); } catch (e) { meta = { version: 0 }; }
    if (!meta.version) meta.version = 0;
  }
  function saveMeta() {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* ignore */ }
  }
  function markDirty(v) {
    try { if (v) localStorage.setItem(DIRTY_KEY, '1'); else localStorage.removeItem(DIRTY_KEY); } catch (e) { /* ignore */ }
  }
  function isDirty() {
    try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch (e) { return false; }
  }

  /* ---------------- 阶段一：主脚本执行前，把缓存写回存储键 ---------------- */
  loadClient();
  loadMeta();
  (function preloadCache() {
    var cache = null;
    try { cache = localStorage.getItem(CACHE_KEY); } catch (e) { /* ignore */ }
    if (!cache) return;
    if (isDirty()) return; // 本地有未推送改动，不能被缓存盖掉
    try { localStorage.setItem(STATE_KEY, cache); } catch (e) { /* ignore */ }
  })();

  /* ---------------- 徽标 UI ---------------- */
  var badgeEl = null, badgeTimer = null;
  function badge() {
    if (badgeEl) return badgeEl;
    var el = document.createElement('div');
    el.id = 'bzrSyncBadge';
    el.style.cssText = [
      'position:fixed', 'left:10px', 'bottom:8px', 'z-index:2147483000',
      'display:flex', 'align-items:center', 'gap:6px',
      'padding:4px 9px', 'border-radius:999px',
      'background:rgba(23,23,23,.82)', 'color:#fff',
      'font:11px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
      'cursor:pointer', 'user-select:none', 'opacity:.28',
      'transition:opacity .25s', 'backdrop-filter:blur(6px)',
      'box-shadow:0 2px 8px rgba(0,0,0,.18)', 'white-space:nowrap'
    ].join(';');
    el.addEventListener('mouseenter', function () { el.style.opacity = '1'; clearTimeout(badgeTimer); });
    el.addEventListener('mouseleave', function () { fadeBadge(); });
    el.addEventListener('click', function () { askName(true); });
    document.body.appendChild(el);
    badgeEl = el;
    return el;
  }

  function setStatus(kind, text) {
    statusText = text;
    if (!document.body) return;
    var el = badge();
    var color = kind === 'ok' ? '#38c172' : kind === 'err' ? '#e5483b' : kind === 'busy' ? '#f0ad4e' : '#9a9a9a';
    el.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';flex:none"></span>' +
      '<span>' + (text || '') + '</span>' +
      '<span style="opacity:.6">·</span>' +
      '<span style="opacity:.85">' + (client.name || '未署名') + '</span>';
    el.style.opacity = '1';
    fadeBadge();
  }
  function fadeBadge() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(function () { if (badgeEl) badgeEl.style.opacity = online ? '0.28' : '0.8'; }, 6000);
  }

  function toast(msg) {
    if (window.UI && typeof window.UI.toast === 'function') { try { window.UI.toast(msg); return; } catch (e) { /* fallthrough */ } }
    var el = document.createElement('div');
    el.style.cssText = ['position:fixed', 'left:50%', 'bottom:56px', 'transform:translateX(-50%)', 'z-index:2147483001',
      'background:rgba(23,23,23,.92)', 'color:#fff', 'padding:9px 16px', 'border-radius:8px',
      'font:13px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif', 'max-width:70vw',
      'box-shadow:0 6px 20px rgba(0,0,0,.25)'].join(';');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, 2800);
    setTimeout(function () { try { el.remove(); } catch (e) { /* ignore */ } }, 3200);
  }

  /* ---------------- 改名 ---------------- */
  function askName(force) {
    if (!document.body) return;
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center';
    var box = document.createElement('div');
    box.style.cssText = ['background:#fff', 'border-radius:12px', 'padding:20px 22px', 'width:320px', 'max-width:86vw',
      'box-shadow:0 18px 48px rgba(0,0,0,.28)', 'font:13px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif', 'color:#171717'].join(';');
    box.innerHTML =
      '<div style="font-size:15px;font-weight:600;margin-bottom:4px">你在这台设备上是谁</div>' +
      '<div style="color:#888;font-size:12px;margin-bottom:12px">改动会记录这个名字，方便同事知道是谁改的。</div>' +
      '<input id="bzrNameIn" placeholder="例如：张老师" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d8d8d4;border-radius:8px;font-size:13px;outline:none">' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">' +
      '<button id="bzrNameCancel" style="padding:7px 14px;border:1px solid #d8d8d4;background:#fff;border-radius:8px;font-size:13px;cursor:pointer">取消</button>' +
      '<button id="bzrNameOk" style="padding:7px 14px;border:0;background:#171717;color:#fff;border-radius:8px;font-size:13px;cursor:pointer">确定</button>' +
      '</div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    var input = box.querySelector('#bzrNameIn');
    var guess = client.name || (window.S && window.S.settings && window.S.settings.teacher && window.S.settings.teacher.name) || '';
    input.value = guess;
    setTimeout(function () { input.focus(); }, 50);
    function close() { try { mask.remove(); } catch (e) { /* ignore */ } }
    function ok() {
      var v = (input.value || '').trim().slice(0, 20);
      if (v) { client.name = v; saveClient(); setStatus(online ? 'ok' : 'off', online ? '已同步' : '离线'); }
      close();
      if (v) push(); // 立刻把名字带到服务器，方便他人看到最后修改人
    }
    box.querySelector('#bzrNameOk').addEventListener('click', ok);
    box.querySelector('#bzrNameCancel').addEventListener('click', function () { close(); if (force && !client.name) toast('没有设置名字，改动会记为「未署名」'); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); });
    input.addEventListener('input', function () { input.style.borderColor = '#d8d8d4'; });
  }

  /* ---------------- 应用远端数据 ---------------- */
  function applyRemote(state, version, opts) {
    opts = opts || {};
    var json = JSON.stringify(state);
    applying = true;
    try {
      localStorage.setItem(STATE_KEY, json);
      localStorage.setItem(CACHE_KEY, json);
      meta.version = version;
      saveMeta();
      markDirty(false);
    } catch (e) { /* ignore */ }

    var hasS = (typeof window.S !== 'undefined') && window.S;
    if (!window.S) {
      // 主脚本还没跑完，留给后续
      applying = false;
      return;
    }
    window.S = state;

    // 正在输入/弹窗中：延后重绘，避免打断老师录入
    var ae = document.activeElement;
    var editing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
    var modalOpen = !!document.querySelector('.modal,.mask,[data-modal]') && document.querySelector('.modal,.mask,[data-modal]').offsetParent !== null;
    if ((editing || modalOpen) && !opts.force) {
      pendingRefresh = true;
      applying = false;
      setStatus('ok', '有更新待刷新');
      return;
    }

    refreshUI(opts.reason);
    applying = false;
  }

  function refreshUI(reason) {
    pendingRefresh = false;
    try {
      if (!window.UI) return;
      if (!stateReady()) { return; }
      // 首次进入的设备：本地还在欢迎页，但服务器已有班级 → 直接进教室
      var w = document.getElementById('welcome');
      var main = document.querySelector('#main');
      if (w || !main || !UI.page || UI.page === 'welcome') {
        if (w && w.parentNode) w.parentNode.removeChild(w);
        UI.shell();
        UI.go('class');
      } else {
        UI.rerender();
      }
      if (reason) toast(reason);
    } catch (e) {
      // 重绘失败时兜底整页刷新
      console.warn('[sync] refresh failed', e);
    }
  }

  function stateReady() {
    return !!(window.S && window.S.settings && window.S.settings.onboarded);
  }

  /* ---------------- 推送 ---------------- */
  function schedulePush() {
    markDirty(true);
    clearTimeout(schedulePush._t);
    schedulePush._t = setTimeout(push, 700); // 大于应用自身的 250ms 落盘防抖
  }

  function push() {
    if (applying) return;
    if (pushing) { pendingPush = true; return; }
    var raw;
    try { raw = localStorage.getItem(STATE_KEY); } catch (e) { return; }
    if (!raw) return;
    var state;
    try { state = JSON.parse(raw); } catch (e) { return; }

    pushing = true;
    setStatus('busy', '同步中');
    fetch(API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: meta.version, state: state, client: client })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (res) {
      pushing = false;
      online = true;
      if (res.error) { setStatus('err', res.error); return; }
      if (res.merged) {
        applyRemote(res.state, res.version, { force: false, reason: '检测到其他老师的修改，已自动合并' });
        if (res.conflicts && res.conflicts.length) {
          console.warn('[sync] conflicts:', res.conflicts);
          showConflicts(res.conflicts);
        }
      } else {
        meta.version = res.version;
        saveMeta();
        try { localStorage.setItem(CACHE_KEY, raw); } catch (e) { /* ignore */ }
        markDirty(false);
        setStatus('ok', '已同步');
      }
      if (pendingPush) { pendingPush = false; push(); }
    }).catch(function (e) {
      pushing = false;
      online = false;
      setStatus('off', '离线，改动已暂存');
      console.warn('[sync] push failed', e && e.message);
      startPolling();
    });
  }

  function showConflicts(list) {
    var head = list.slice(0, 2).join('；');
    toast('合并提示：' + head + (list.length > 2 ? ' 等 ' + list.length + ' 处' : '') + '（详见控制台）');
  }

  /* ---------------- 拉取 ---------------- */
  var lastConflictNote = 0;
  function pull(silent) {
    if (applying) return;
    if (isDirty()) { push(); return; } // 本地有未推送改动时不覆盖，先推
    var url = API + '?since=' + encodeURIComponent(meta.version) + '&t=' + Date.now();
    fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (res) {
      online = true;
      if (res.unchanged) { setStatus('ok', '已同步'); return; }
      if (!res.state) {
        // 服务器还没有数据：如果本地有班级，作为初始版本推上去
        if ((typeof window.S !== 'undefined') && stateReady()) { push(); }
        else setStatus('ok', '已同步');
        return;
      }
      if (res.version > meta.version) {
        var who = res.updatedBy && res.updatedBy !== client.name ? res.updatedBy + ' 更新了数据，已刷新' : null;
        applyRemote(res.state, res.version, { reason: silent ? who : who });
        setStatus('ok', '已同步');
      } else {
        setStatus('ok', '已同步');
      }
    }).catch(function () {
      online = false;
      setStatus('off', '离线，改动已暂存');
      startPolling();
    });
  }

  /* ---------------- SSE ---------------- */
  function startSSE() {
    if (es || typeof EventSource === 'undefined') return;
    try { es = new EventSource('/api/events'); } catch (e) { startPolling(); return; }
    es.onopen = function () { online = true; stopPolling(); setStatus('ok', '已同步'); if (isDirty()) push(); };
    es.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.version && d.version > meta.version) pull(d.type !== 'state');
    };
    es.onerror = function () {
      online = false;
      setStatus('off', '连接中断，改动会暂存');
      startPolling();
      // EventSource 自带重连；若被彻底关闭则重建
      if (es && es.readyState === 2) { try { es.close(); } catch (e) { /* ignore */ } es = null; setTimeout(startSSE, 5000); }
    };
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (isDirty()) push(); else pull(true);
    }, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ---------------- 接管 save ---------------- */
  function hookSave() {
    if (typeof window.save !== 'function' || window.save.__sync) return false;
    var orig = window.save;
    var wrapped = function () {
      var r = orig.apply(window, arguments);
      schedulePush();
      return r;
    };
    wrapped.__sync = true;
    window.save = wrapped;
    return true;
  }

  /* ---------------- 启动 ---------------- */
  function watchName() {
    if (client.name) return;
    var ticks = 0;
    var t = setInterval(function () {
      ticks += 1;
      if (client.name) { clearInterval(t); return; }
      if (stateReady()) {
        clearInterval(t);
        setTimeout(function () { if (!client.name) askName(false); }, 700);
      } else if (ticks > 120) {
        clearInterval(t);
      }
    }, 1000);
  }

  function boot() {
    var tries = 0;
    var t = setInterval(function () {
      tries += 1;
      if (hookSave() || tries > 40) clearInterval(t);
    }, 100);

    setStatus('busy', '连接中');

    // 名字：等真正进入教室后再问，避免和引导页抢输入焦点
    watchName();

    // 首次同步：先拉，若服务器为空且本地有班级则上传
    pull(true);
    startSSE();

    // 兜底：任何路径漏掉的待推送改动，3 秒内补上
    setInterval(function () {
      if (isDirty() && !pushing && !applying && online) push();
    }, 3000);

    // 页面隐藏时补推一次，避免防抖窗口内关页面丢改动
    window.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && isDirty()) push(); });
    window.addEventListener('beforeunload', function () { if (isDirty()) push(); });

    // 别的事件不太需要
    window.__BZR_SYNC__ = {
      info: function () { return { version: meta.version, online: online, dirty: isDirty(), client: client, status: statusText }; },
      pull: pull,
      push: push,
      rename: function () { askName(true); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
