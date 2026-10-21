/**
 * 图寻答案助手 —— 独立版
 *
 * 只做一件事：从页面的街景实例里读出当前这条全景的真实坐标（就是这一题的答案），
 * 显示国家和经纬度，并可以一键在图寻的猜点地图上打点。
 *
 * 不调用 AI、不发任何网络请求、不需要 Key；跨平台（Edge/Chrome，Windows/macOS 均可）。
 */
(() => {
  'use strict';
  if (window.__TXANS_UI__) return;
  if (window.top !== window) return; // 只在顶层出界面

  const DEFAULTS = {
    autoPin: true,
    pos: null,
  };

  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; } })();

  const S = {
    settings: Object.assign({}, DEFAULTS),
    collapsed: false,
    pos: null,
    overlayPos: null,
    country: '',
    coords: '',
    notice: '',
    noticeErr: false,
    diagText: '',
    tileFail: false,
    lastPanoId: null,
    autoPinned: {},
    busy: false,
    enabled: true,
  };

  /* ------------------------------ 与页面主世界通信 ------------------------------ */
  function bridge(cmd, payload, timeout) {
    return new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9) + 1;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, timeout || 2000);
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.__txai !== 'res' || d.id !== id) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(d);
      };
      window.addEventListener('message', onMsg);
      try {
        window.postMessage({ __txai: 'req', id, cmd, payload: payload || {} }, '*');
      } catch (e) {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(null);
      }
    });
  }

  /* ------------------------------ 工具 ------------------------------ */
  function pointInRing(x, y, flat) {
    let inside = false;
    for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
      const xi = flat[i];
      const yi = flat[i + 1];
      const xj = flat[j];
      const yj = flat[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // 中国模式：用省份边界反查具体省份
  function provinceAt(lat, lng) {
    const list = window.__TX_CN_PROVINCES__;
    if (!Array.isArray(list) || !list.length) return '';
    for (const p of list) {
      const b = p.b;
      if (!b) continue;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      for (const ring of p.r || []) {
        if (pointInRing(lng, lat, ring)) return p.n;
      }
    }
    return '';
  }

  function countryAt(lat, lng) {
    const list = (window.__TX_WORLD__ && window.__TX_WORLD__.countries) || [];
    let best = null;
    for (const co of list) {
      const b = co.mb || co.b;
      if (!b) continue;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      if (!best || area < best.area) best = { co, area };
    }
    return best ? best.co : null;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setNotice(msg, isErr) {
    S.notice = msg || '';
    S.noticeErr = !!isErr;
    render();
    if (msg) {
      setTimeout(() => {
        if (S.notice === msg) {
          S.notice = '';
          render();
        }
      }, 3500);
    }
  }

  /* ------------------------------ 样式 / DOM ------------------------------ */
  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .panel { position: fixed; z-index: 2147483000; width: 258px; background: #101722f2; color: #e7edf7;
    border: 1px solid #ffffff1f; border-radius: 14px; box-shadow: 0 18px 44px #000000a0; backdrop-filter: blur(10px);
    font-size: 12.5px; line-height: 1.5; overflow: hidden; }
  .panel.min { width: 178px; }
  .hd { display: flex; align-items: center; gap: 7px; padding: 9px 11px; cursor: move; user-select: none;
    border-bottom: 1px solid #ffffff14; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #6b7280; }
  .dot.on { background: #22c55e; box-shadow: 0 0 8px #22c55e90; }
  .hd b { font-size: 12.5px; }
  .hd .sub { font-size: 11px; color: #9aa4b2; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 96px; }
  .sp { flex: 1; }
  .hbtn { border: 0; background: #ffffff10; color: #cfd6e2; width: 20px; height: 20px; border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 1; }
  .bd { padding: 10px 12px 12px; }
  .big { font-size: 17px; font-weight: 700; color: #ffb27a; }
  .co { font-size: 11px; color: #9aa4b2; margin-top: 1px; word-break: break-all; }
  .minimap { display:block; width:100%; height:150px; margin-top:8px; border-radius:10px; border:1px solid #ffffff18; cursor:grab; background:#0a1424; touch-action:none; }
  .mapmodal { position:fixed; inset:0; display:none; align-items:center; justify-content:center; background:#05070bcc; z-index:2147483001; }
  .mapmodal.on { display:flex; }
  .mapcard { width:min(1100px,92vw); background:#0d131df5; border:1px solid #ffffff22; border-radius:14px; overflow:hidden; box-shadow:0 24px 70px #000000b0; }
  .maphd { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid #ffffff14; font-size:12px; color:#9aa4b2; }
  .maphd b { color:#e7edf7; font-size:13px; }
  .bigmap { display:block; width:100%; height:64vh; cursor:grab; touch-action:none; background:#0a1424; }
  .maphint { padding:8px 12px 11px; font-size:11px; color:#7d8898; }
  .btns { display: flex; gap: 7px; margin-top: 9px; }
  .btn { flex: 1; border: 0; border-radius: 9px; padding: 8px 6px; font-size: 12px; cursor: pointer;
    background: #ff8a3d; color: #14202e; font-weight: 600; }
  .btn.ghost { background: #ffffff12; color: #dbe4f0; font-weight: 500; }
  .btn:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  .kv { display: flex; justify-content: space-between; font-size: 11.5px; color: #b9c4d4; padding: 3px 0; }
  .hint { font-size: 11px; color: #8b96a6; margin-top: 7px; }
  .diag { font-size: 10px; line-height: 1.4; color: #93c5fd; background: #00000040; border-radius: 8px; padding: 6px 8px; margin-top: 7px; max-height: 130px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .notice { font-size: 11.5px; color: #6ee7b7; margin-top: 7px; word-break: break-all; }
  .notice.err { color: #fca5a5; }
  .muted { color: #8b96a6; }
  `;

  const host = document.createElement('div');
  host.id = 'txans-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  const wrap = document.createElement('div');
  shadow.appendChild(styleEl);
  shadow.appendChild(wrap);
  const mount = () => {
    try {
      (document.body || document.documentElement).appendChild(host);
    } catch (e) {
      document.documentElement.appendChild(host);
    }
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  function panelPos() {
    if (S.overlayPos) return S.overlayPos;
    const w = 258;
    return { x: Math.max(8, window.innerWidth - w - 18), y: 74 };
  }

  /* ------------------------------ 渲染 ------------------------------ */
  function render() {
    const p = panelPos();
    const st = S.lastState;
    const ok = !!(st && st.ok);
    const head = `
      <div class="hd" id="txans-drag">
        <span class="dot ${ok ? 'on' : ''}"></span>
        <b>图寻答案</b>
        <span class="sub">${ok ? '已连接' : '未检测到街景'}</span>
        <span class="sp"></span>
        <button class="hbtn" data-act="collapse" title="收起">${S.collapsed ? '+' : '−'}</button>
      </div>`;

    if (S.collapsed) {
      wrap.innerHTML = `<div class="panel min" style="left:${p.x}px;top:${p.y}px">${head}</div>`;
      bindDrag();
      return;
    }

    const notice = S.notice ? `<div class="notice ${S.noticeErr ? 'err' : ''}">${esc(S.notice)}</div>` : '';
    const body = S.pos
      ? `
        <div class="big">${esc(S.country || '未知')}</div>
        <div class="co" id="txans-coords">${S.coords}</div>
        <canvas id="txans-minimap" class="minimap" title="点一下打开大图；滚轮缩放、拖动平移"></canvas>
        <div id="txans-mapdbg" class="muted" style="font-size:10px;margin-top:4px;word-break:break-all"></div>
        ${S.tileFail ? '<div class="hint" style="color:#fca5a5">地图瓦片没加载出来（网络/瓦片源不可用），点「诊断」看详情</div>' : ''}
        <div class="btns">
          <button class="btn" data-act="pin" ${S.busy ? 'disabled' : ''}>📍 打点</button>
          <button class="btn ghost" data-act="copy">复制</button>
        </div>
        <div class="row">
          <button class="btn ghost" data-act="refresh">刷新</button>
          <button class="btn ghost" data-act="diag">诊断</button>
        </div>
        ${S.diagText ? `<pre class="diag">${esc(S.diagText)}</pre>` : ''}
        <div class="kv"><span>自动打点</span><span>${S.settings.autoPin ? '开' : '关'}</span></div>
        <div class="row">
          <button class="btn ghost" data-act="autopin">${S.settings.autoPin ? '关闭自动打点' : '开启自动打点'}</button>
        </div>
        ${notice}
        <div class="hint">直接读街景对象的真实坐标，不经过 AI。拖动标题可移动。<span class="muted">v${VERSION}</span></div>`
      : `<div class="muted">进入一局游戏、等街景加载后，这里会直接显示答案。</div>${notice}`;

    wrap.innerHTML = `<div class="panel" style="left:${p.x}px;top:${p.y}px">${head}<div class="bd">${body}</div></div>`;
    const mini = shadow.getElementById('txans-minimap');
    if (mini && !mini.__txansRo) {
      try {
        mini.__txansRo = new ResizeObserver(() => scheduleDraw());
        mini.__txansRo.observe(mini);
      } catch (e) {}
    }
    if (mini && S.pos) {
      attachMap(mini, openBigMap);
      if (!view.ready || view.key !== S.coords) centerOnAnswer();
      let tries = 0;
      const kick = () => {
        tries += 1;
        try {
          if (!view.ready) centerOnAnswer();
          drawMap(mini);
        } catch (e) {
          host.setAttribute('data-map', 'err:' + String((e && e.message) || e));
        }
        const dbg = shadow.getElementById('txans-mapdbg');
        if (dbg) {
          dbg.textContent =
            'map ready=' + view.ready + ' z=' + view.zoom.toFixed(1) + ' ok=' + view.ok + ' err=' + view.err +
            ' anim=' + !!window.__TX_MAP_ANIM__ + ' lok=' + levelOk + ' w=' + mini.width + ' h=' + mini.height + ' tpl=' + (function(){ try { const A = window.__TX_MAP_ANIM__; return A && A.debugInfo ? A.debugInfo().hasTemplate : '?'; } catch (e) { return '?'; } })();
        }
        if (tries < 24) setTimeout(kick, 250);
      };
      setTimeout(kick, 30);
    } else {
      host.setAttribute('data-map', 'no-mini pos=' + !!S.pos);
    }
    bindDrag();
  }

  /* ------------------------------ 交互 ------------------------------ */
  function bindDrag() {
    const el = shadow.getElementById('txans-drag');
    const panel = shadow.querySelector('.panel');
    if (!el || !panel) return;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-act]')) return;
      const start = { x: e.clientX, y: e.clientY };
      const orig = { x: panel.offsetLeft, y: panel.offsetTop };
      const move = (ev) => {
        S.overlayPos = { x: Math.max(4, orig.x + ev.clientX - start.x), y: Math.max(4, orig.y + ev.clientY - start.y) };
        panel.style.left = S.overlayPos.x + 'px';
        panel.style.top = S.overlayPos.y + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  wrap.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) {
      if (S.collapsed) {
        S.collapsed = false;
        render();
      }
      return;
    }
    const act = el.dataset.act;
    if (act === 'collapse') {
      S.collapsed = !S.collapsed;
      render();
    } else if (act === 'pin') {
      await placePin(false);
    } else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(`${S.country} ${S.coords}`);
        setNotice('已复制：' + S.country + ' ' + S.coords);
      } catch (err) {
        setNotice('复制失败，手动选吧', true);
      }
    } else if (act === 'refresh') {
      refresh();
    } else if (act === 'diag') {
      const d = await bridge('diag', {}, 4000);
      const mi = await bridge('map-info', {}, 4000);
      let mm = null;
      try {
        const A = window.__TX_MAP_ANIM__;
        mm = A && A.debugInfo ? A.debugInfo() : null;
      } catch (e) {}
      S.diagText = JSON.stringify({ diag: d, mapInfo: mi, map: mm, tiles: { ok: view.ok, err: view.err } }, null, 1).slice(0, 900);
      try {
        console.log('[图寻答案] 诊断', d, mi);
      } catch (e) {}
      render();
    } else if (act === 'autopin') {
      S.settings.autoPin = !S.settings.autoPin;
      persist();
      render();
    }
  });

  /* ------------------------------ 可缩放地图 ------------------------------ */
  const TILE = 256;
  const view = { lat: 0, lng: 0, zoom: 5, ready: false, key: '', ok: 0, err: 0 };
  const tileCache = new Map();
  let rafPending = false;
  let zoomAnim = null;
  let retryTimer = 0;

  function ensureRetry() {
    if (retryTimer) return;
    retryTimer = setInterval(() => {
      if (!view.ready) return;
      if (view.ok === 0) scheduleDraw();
    }, 2000);
  }
  let tileBudget = 12;
  let tileBudgetTs = 0;


  function proj(lat, lng, z) {
    const size = TILE * Math.pow(2, z);
    const x = ((lng + 180) / 360) * size;
    const s = Math.sin((lat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
    return { x, y, size };
  }
  function unproj(x, y, z) {
    const size = TILE * Math.pow(2, z);
    const lng = (x / size) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / size;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
  }
  function tileUrl(z, x, y) {
    const A = window.__TX_MAP_ANIM__;
    return A && A.tileUrlFor ? A.tileUrlFor(z, x, y, 1) : '';
  }
  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const mini = shadow.getElementById('txans-minimap');
      if (mini) drawMap(mini);
      const big = shadow.getElementById('txans-bigmap');
      if (big && big.clientWidth) drawMap(big);
    });
  }

  // 连续缩放：view.zoom 是小数，瓦片取 floor(zoom) 那一级再按 2^fraction 缩放绘制
  function drawMap(canvas) {
    if (!view.ready) return;
    const isBig = canvas.id === 'txans-bigmap';
    const dpr = Math.min(isBig ? 1.5 : 2, window.devicePixelRatio || 1);
    const w = Math.max(80, canvas.clientWidth || 240);
    const h = Math.max(60, canvas.clientHeight || 150);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a1424';
    ctx.fillRect(0, 0, w, h);

    // 整数级别瓦片 + 整体缩放：所有瓦片同一比例，避免接缝/字号不一致
    const zoomF = Math.max(1, Math.min(16, view.zoom));
    const z = Math.max(1, Math.min(16, Math.round(zoomF)));
    const scale = Math.pow(2, zoomF - z);
    const vw = w / scale;
    const vh = h / scale;
    const c = proj(view.lat, view.lng, z);
    const tx = Math.floor((c.x - vw / 2) / TILE);
    const ty = Math.floor((c.y - vh / 2) / TILE);
    const offX = -((c.x - vw / 2) - tx * TILE);
    const offY = -((c.y - vh / 2) - ty * TILE);
    const cols = Math.ceil(vw / TILE) + 1;
    const rows = Math.ceil(vh / TILE) + 1;
    const maxTile = Math.pow(2, z);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-vw / 2, -vh / 2);

    let levelOk = 0;
    const nowTs = performance.now();
    if (nowTs - tileBudgetTs > 300) {
      tileBudgetTs = nowTs;
      tileBudget = 12;
    }

    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const X = tx + i;
        const Y = ty + j;
        if (Y < 0 || Y >= maxTile) continue;
        const key = z + '/' + X + '/' + Y;
        const rec = tileCache.get(key);
        const dx = i * TILE + offX;
        const dy = j * TILE + offY;
        if (rec && rec.ok && rec.img) {
          try {
            ctx.drawImage(rec.img, dx, dy, TILE, TILE);
          } catch (e) {}
          levelOk += 1;
          continue;
        }
        // 缺图：用更粗一级的缓存垫底
        let filled = false;
        for (let lv = z - 1; lv >= Math.max(1, z - 3); lv--) {
          const p = Math.pow(2, z - lv);
          const px = Math.floor(X / p);
          const py = Math.floor(Y / p);
          const pr = tileCache.get(lv + '/' + px + '/' + py);
          if (!pr || !pr.ok || !pr.img) continue;
          const sub = 256 / p;
          try {
            ctx.drawImage(pr.img, (X - px * p) * sub, (Y - py * p) * sub, sub, sub, dx, dy, TILE, TILE);
          } catch (e) {}
          filled = true;
          break;
        }
        // 注意：垫底只负责显示，仍然要继续请求当前层级的瓦片，否则放大后永远停在模糊的父级图
        if (rec && rec.loading) continue;
        if (rec && rec.err && Date.now() - rec.ts < 8000) continue;
        if (tileBudget <= 0) continue;
        tileBudget -= 1;
        const item = { loading: true, ok: false, err: false, img: null, ts: Date.now() };
        tileCache.set(key, item);
        const img = new Image();
        img.onload = () => {
          item.ok = true;
          item.loading = false;
          item.img = img;
          view.ok += 1;
          if (S.tileFail) {
            S.tileFail = false;
            render();
          }
          scheduleDraw();
        };
        img.onerror = () => {
          item.loading = false;
          item.err = true;
          item.ts = Date.now();
          view.err += 1;
          if (!S.tileFail && view.ok === 0 && view.err >= 8) {
            S.tileFail = true;
            render();
          }
        };
        img.src = tileUrl(z, X, Y);
      }
    }
    ctx.restore();

    // 当前层级完全没有图：1.5 秒后强制重扫瓦片地址并重试（避免一直用粗一级的模糊图）
    if (levelOk === 0) {
      const now2 = Date.now();
      if (!view.levelRetryTs || now2 - view.levelRetryTs > 1500) {
        view.levelRetryTs = now2;
        setTimeout(() => {
          try {
            const A = window.__TX_MAP_ANIM__;
            if (A && A.resetTemplate) A.resetTemplate();
            for (const [k, v] of tileCache) {
              if (v && v.err && k.indexOf(z + '/') === 0) tileCache.delete(k);
            }
          } catch (e) {}
          scheduleDraw();
        }, 1500);
      }
    } else {
      view.levelRetryTs = 0;
    }

    // 标记与文字在屏幕坐标系里画，大小不随缩放变化
    if (S.pos) {
      const ap = proj(S.pos.lat, S.pos.lng, z);
      const mx = w / 2 + (ap.x - c.x) * scale;
      const my = h / 2 + (ap.y - c.y) * scale;
      if (mx > -20 && my > -20 && mx < w + 20 && my < h + 20) {
        ctx.beginPath();
        ctx.arc(mx, my, 12, 0, Math.PI * 2);
        ctx.fillStyle = '#ff4d4f44';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(mx, my, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ff4d4f';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }
    if (view.ok === 0) {
      const elapsed = Date.now() - (view.startTs || 0);
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = elapsed > 5000 ? '#fca5a5cc' : '#7d8898aa';
      ctx.fillText(elapsed > 5000 ? '瓦片未加载，点「诊断」' : '地图加载中…', w / 2, h / 2 + 4);
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = '#ffffffaa';
    ctx.font = '10px sans-serif';
    ctx.fillText('z' + zoomF.toFixed(1), 6, h - 6);
  }

  function clampZoom(z) {
    return Math.max(1, Math.min(16, z));
  }

  // 官方那种「实时放大」：目标缩放 + 每帧缓动逼近
  function animateZoom() {
    if (!zoomAnim) return;
    const t = Math.min(1, (performance.now() - zoomAnim.t0) / zoomAnim.dur);
    const e = 1 - Math.pow(1 - t, 3);
    view.zoom = zoomAnim.from + (zoomAnim.to - zoomAnim.from) * e;
    scheduleDraw();
    if (t < 1) requestAnimationFrame(animateZoom);
    else {
      zoomAnim = null;
      scheduleDraw();
    }
  }
  function zoomToward(target) {
    const to = clampZoom(target);
    const from = zoomAnim ? zoomAnim.to : view.zoom;
    if (Math.abs(to - from) < 0.01) return;
    zoomAnim = { from: view.zoom, to, t0: performance.now(), dur: 200 };
    // 动画期间就按目标级别预取瓦片，动画结束时基本已经就位
    tileBudget = 12;
    tileBudgetTs = performance.now();
    animateZoom();
  }
  function zoomBy(delta) {
    const base = zoomAnim ? zoomAnim.to : view.zoom;
    zoomToward(base + delta);
  }
  function panBy(dxPx, dyPx) {
    const zf = view.zoom;
    const size = TILE * Math.pow(2, zf);
    const c = proj(view.lat, view.lng, zf);
    const np = unproj(c.x - dxPx, c.y - dyPx, zf);
    view.lat = np.lat;
    view.lng = np.lng;
    scheduleDraw();
  }
  function centerOnAnswer() {
    if (!S.pos) return;
    view.lat = S.pos.lat;
    view.lng = S.pos.lng;
    view.ready = true;
    view.key = S.coords;
    const A = window.__TX_MAP_ANIM__;
    view.zoom = clampZoom((A && A.zoomForPoint ? A.zoomForPoint(S.pos.lat, S.pos.lng) : 5) + 0.2);
    view.startTs = Date.now();
    allowTiles = true;
    ensureRetry();
    scheduleDraw();
  }
  function attachMap(canvas, onClick) {
    if (!canvas || canvas.__txansBound) return;
    canvas.__txansBound = true;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = Math.max(-1.2, Math.min(1.2, -e.deltaY * 0.0022));
      zoomBy(step);
    }, { passive: false });
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        panBy(-dx, -dy);
        drag.x = e.clientX;
        drag.y = e.clientY;
      }
    });
    canvas.addEventListener('pointerup', () => {
      const wasDrag = drag && drag.moved;
      drag = null;
      scheduleDraw();
      if (!wasDrag && onClick) onClick();
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('dblclick', () => zoomBy(1));
  }
  function openBigMap() {
    let modal = shadow.getElementById('txans-mapmodal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'txans-mapmodal';
      modal.className = 'mapmodal';
      modal.innerHTML = '<div class="mapcard">' +
        '<div class="maphd"><b>答案位置</b><span class="muted" id="txans-mapinfo"></span><span class="sp"></span><button class="hbtn" data-act="map-close">×</button></div>' +
        '<canvas id="txans-bigmap" class="bigmap"></canvas>' +
        '<div class="maphint">滚轮缩放 · 拖动平移 · 双击放大</div></div>';
      modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="map-close"]')) modal.classList.remove('on');
      });
      shadow.appendChild(modal);
    }
    const info = modal.querySelector('#txans-mapinfo');
    if (info) info.textContent = (S.country || '') + ' ' + (S.coords || '');
    modal.classList.add('on');
    allowTiles = true;
    centerOnAnswer();
    const big = shadow.getElementById('txans-bigmap');
    attachMap(big, null);
    setTimeout(() => {
      if (big) drawMap(big);
    }, 30);
  }

  /* ------------------------------ 核心逻辑 ------------------------------ */
  async function persist() {
    try {
      await chrome.storage.local.set({ answerSettings: S.settings });
    } catch (e) {}
  }

  async function placePin(silent) {
    if (!S.pos) {
      if (!silent) setNotice('还没有坐标', true);
      return false;
    }
    S.busy = true;
    render();
    const res = await bridge('place-guess', { lat: S.pos.lat, lng: S.pos.lng }, 8000);
    S.busy = false;
    if (res && res.ok) {
      setNotice('已在图寻地图上打点');
      return true;
    }
    if (!silent) setNotice('没找到图寻的猜点地图：确认已进入游戏、地图已展开', true);
    render();
    return false;
  }

  async function autoPinWithRetry(panoId, attempt) {
    const n = attempt || 0;
    if (!S.pos) return;
    const ok = await placePin(true);
    if (!ok && n < 3) {
      setTimeout(() => {
        if (S.lastPanoId === panoId) autoPinWithRetry(panoId, n + 1);
      }, 1600);
    } else if (!ok) {
      setNotice('自动打点失败：图寻猜点地图可能还没展开');
    }
  }

  async function refresh() {
    S.dbg = S.dbg || { calls: 0, ok: 0, fail: 0, last: '' };
    S.dbg.calls += 1;
    const st = await bridge('state', {}, 2500);
    S.lastState = st;
    if (st && st.ok) {
      S.dbg.ok += 1;
      S.failStreak = 0;
    } else {
      S.dbg.fail += 1;
      S.failStreak = (S.failStreak || 0) + 1;
      S.dbg.last = JSON.stringify(st);
    }
    if (S.dbg.calls % 10 === 0) {
      try {
        host.setAttribute('data-dbg', 'calls=' + S.dbg.calls + ' ok=' + S.dbg.ok + ' fail=' + S.dbg.fail + ' last=' + S.dbg.last);
      } catch (e) {}
    }
    if (!st || !st.ok || !st.position) {
      if ((S.failStreak || 0) >= 3) {
        S.pos = null;
        S.country = '';
        S.coords = '';
        const k0 = 'none';
        if (k0 !== S.uiKey) {
          S.uiKey = k0;
          render();
        }
      }
      return;
    }
    S.pos = st.position;
    const co = countryAt(S.pos.lat, S.pos.lng);
    S.country = co ? co.z : '未知';
    S.province = co && co.i === 'CN' ? provinceAt(S.pos.lat, S.pos.lng) : '';
    if (S.province) S.country += ' · ' + S.province;
    S.coords = `${S.pos.lat.toFixed(4)}, ${S.pos.lng.toFixed(4)}`;
    // 只在内容变化时重绘，避免轮询导致地图闪烁
    const uiKey = 'ok|' + S.country + '|' + S.coords;
    if (uiKey !== S.uiKey) {
      S.uiKey = uiKey;
      render();
    }

    // 新的一题 + 自动打点
    if (st.panoId && st.panoId !== S.lastPanoId) {
      S.lastPanoId = st.panoId;
      if (S.settings.autoPin && !S.autoPinned[st.panoId]) {
        S.autoPinned[st.panoId] = true;
        setTimeout(() => autoPinWithRetry(st.panoId), 500);
      }
    } else if (st.panoId && S.settings.autoPin && !S.autoPinned[st.panoId]) {
      S.autoPinned[st.panoId] = true;
      setTimeout(() => autoPinWithRetry(st.panoId), 500);
    }
  }

  async function loadAll() {
    try {
      const store = await chrome.storage.local.get(['answerSettings']);
      if (store && store.answerSettings) {
        S.settings = Object.assign({}, DEFAULTS, store.answerSettings);
      } else {
        // 第一次用：写一份默认设置（自动打点开）
        await chrome.storage.local.set({ answerSettings: S.settings });
      }
    } catch (e) {}
  }

  (async () => {
    render();
    await loadAll();
    render();
    refresh();
    // 刚进页面时图寻的地图/街景可能还没完全就绪：自动补几次刷新（等于手动点「刷新」）
    setTimeout(() => refresh(), 700);
    setTimeout(() => refresh(), 2000);
    setTimeout(() => refresh(), 5000);
    setInterval(() => {
      if (S.enabled) refresh();
    }, 700);
  })();

  // 调试入口
  window.__TXANS_DEBUG__ = { state: S, refresh, placePin, bridge };
})();
