/**
 * 图寻 AI 助手 —— 页面悬浮窗（ISOLATED world）
 *
 * 功能：
 *  - 一键让 DeepSeek 看 360° 街景，猜坐标 + 给证据 + 教学；
 *  - 与你自己的图寻得分做对战记分（20 回合自动累计）；
 *  - 回合结束后可以做 AI 复盘。
 */
(() => {
  'use strict';
  if (window.__TXAI_UI__) return;
  window.__TXAI_UI__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (v) =>
    String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('zh-CN'));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ------------------------------ 与主世界通信 ------------------------------ */
  let seq = 0;
  const pending = new Map();
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__txai !== 'res' || typeof d.id !== 'number') return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    clearTimeout(p.timer);
    p.resolve(d);
  });
  function bridge(cmd, payload, timeout = 5000) {
    return new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeout);
      pending.set(id, { resolve, timer });
      window.postMessage({ __txai: 'req', id, cmd, payload: payload || {} }, '*');
    });
  }

  /* ------------------------------ 全局状态 ------------------------------ */
  const DEFAULTS = {
    apiKey: '', // 填写你自己的 DeepSeek API Key，或安装后在「设置」里填
    baseUrl: 'https://api.deepseek.com',
    profile: 'fast',
    model: 'deepseek-flash',
    frames: 3,
    captureMode: 'auto',
    stealth: false,
    humanize: false,
    passiveCapture: false,
    hideTruth: false,
    autoCollapse: false,
    directAuto: false,
    settleMs: 600,
    effort: 'low',
    maxTokens: 1600,
    maxWidth: 700,
    rounds: 20,
    mapSizeKm: 14916.862,
    metaReview: true,
    deep: false,
    autoPin: true,
    autoSubmit: true,
    autoNext: true,
    language: 'zh',
  };

  const PROFILE_PRESETS = {
    fast: { frames: 3, settleMs: 600, maxWidth: 700, maxTokens: 1600, effort: 'low' },
    balanced: { frames: 4, settleMs: 800, maxWidth: 800, maxTokens: 2600, effort: 'low' },
    accurate: { frames: 5, settleMs: 950, maxWidth: 900, maxTokens: 4000, effort: 'high' },
  };

  const S = {
    settings: null, // 直接读 chrome.storage.local 的设置（含 apiKey，仅本机）
    battle: { target: 20, rounds: [] },
    current: null, // { panoId, truth, guess, reasoning, images, aiScore, distanceKm }
    lastReview: null,
    busy: false,
    progress: null,
    notice: '',
    collapsed: false,
    tab: 'main',
    lastState: null,
    lastPanoId: null,
    autoScore: null,
    lastAnim: null,
    reviewPending: false,
    pinStatus: '',
    mode: 'battle',
    enabled: true,
    lastAct: Date.now(),
    passive: { panoId: null, frames: [], headings: [], lastHeading: null, lastCapHeading: null, stableSince: Date.now(), capturing: false },
    refreshTimer: 0,
    autoLoop: false,
    autoTimer: 0,
    timing: null,
    authOk: null,
    needAuth: false,
    pos: null,
  };

  /* ------------------------------ 样式 ------------------------------ */
  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap { position: fixed; inset: 0; pointer-events: none; font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .panel {
    position: absolute; width: 372px; max-height: calc(100vh - 120px); display: flex; flex-direction: column;
    background: linear-gradient(180deg, #161a22f2, #10131af7); color: #e8ecf3;
    border: 1px solid #ffffff1f; border-radius: 14px; box-shadow: 0 18px 50px #00000080;
    pointer-events: auto; overflow: hidden; backdrop-filter: blur(10px);
  }
  .panel.min { width: 220px; }
  .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: move; user-select: none;
        background: #ffffff08; border-bottom: 1px solid #ffffff14; }
  .hd b { font-size: 13px; letter-spacing: .3px; }
  .hd .sub { font-size: 11px; color: #9aa4b2; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 150px; }
  .hd .sp { flex: 1; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; box-shadow: 0 0 0 2px #ffffff10; }
  .dot.on { background: #22c55e; box-shadow: 0 0 10px #22c55e90; }
  .sw { width: 30px; height: 16px; border-radius: 9px; background: #ffffff22; position: relative; cursor: pointer; flex: 0 0 auto; transition: background .15s; }
  .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #cbd5e1; transition: left .15s, background .15s; }
  .sw.on { background: #22c55e66; }
  .sw.on::after { left: 16px; background: #22c55e; }
  .hbtn { border: 0; background: #ffffff10; color: #cfd6e2; width: 22px; height: 22px; border-radius: 7px;
          cursor: pointer; font-size: 13px; line-height: 1; }
  .hbtn:hover { background: #ffffff22; }
  .bd { padding: 12px; overflow-y: auto; }
  .tabs { display: flex; gap: 6px; padding: 0 12px 8px; }
  .tab { flex: 1; text-align: center; padding: 6px 0; border-radius: 9px; font-size: 12px; color: #9aa4b2;
         background: #ffffff08; cursor: pointer; border: 1px solid transparent; }
  .tab.on { color: #ffb27a; background: #ff8a3d1f; border-color: #ff8a3d55; }
  .score { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin: 0 12px 10px;
           background: #ffffff08; border: 1px solid #ffffff12; border-radius: 12px; }
  .score .side { flex: 1; text-align: center; }
  .score .n { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .score .lbl { font-size: 11px; color: #9aa4b2; }
  .score .vs { font-size: 11px; color: #6b7280; }
  .score .mine .n { color: #6ee7b7; }
  .score .ai .n { color: #93c5fd; }
  .btn { display: block; width: 100%; padding: 10px; border-radius: 11px; border: 0; cursor: pointer;
         font-size: 13px; font-weight: 600; color: #1a1206;
         background: linear-gradient(135deg, #ffb26b, #ff8a3d); }
  .btn:hover { filter: brightness(1.06); }
  .btn:disabled { opacity: .55; cursor: default; filter: none; }
  .btn.ghost { background: #ffffff10; color: #cfd6e2; font-weight: 500; }
  .btn.ghost:hover { background: #ffffff1c; }
  .row { display: flex; gap: 8px; }
  .mt { margin-top: 10px; }
  .card { margin-top: 10px; padding: 10px 12px; background: #ffffff0a; border: 1px solid #ffffff14; border-radius: 12px; }
  .card .title { display: flex; align-items: baseline; gap: 8px; }
  .card .title b { font-size: 15px; }
  .muted { color: #9aa4b2; }
  .small { font-size: 11px; }
  .bar { height: 5px; border-radius: 4px; background: #ffffff14; overflow: hidden; margin: 7px 0; }
  .bar i { display: block; height: 100%; background: linear-gradient(90deg, #ff8a3d, #ffd08a); }
  .clue { display: flex; gap: 7px; margin-top: 6px; font-size: 12px; }
  .clue .k { flex: 0 0 auto; padding: 0 6px; height: 18px; line-height: 18px; border-radius: 6px;
             background: #ff8a3d22; color: #ffb27a; font-size: 10px; }
  .clue .t { color: #cfd6e2; }
  .clue .w { color: #8b95a7; font-size: 11px; }
  .meta-review { margin-top: 8px; padding: 7px 9px; border-left: 2px solid #22c55e; background: #ffffff07; border-radius: 8px; }
  .minimap { display: block; width: 100%; height: 170px; margin-top: 8px; border-radius: 10px; border: 1px solid #ffffff18; cursor: pointer; background: #0a1424; }
  .thumbs { display: flex; gap: 4px; margin: 7px 0 2px; }
  .thumbs img { width: 25%; height: 48px; object-fit: cover; border-radius: 6px; border: 1px solid #ffffff1a; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: #9fb0c9; font-size: 12px; }
  pre { white-space: pre-wrap; font-size: 11px; color: #8b95a7; margin: 6px 0 0; }
  .teach { font-size: 12px; color: #dbe3ee; white-space: pre-wrap; }
  .settle { margin-top: 10px; padding: 10px 12px; background: #ffffff08; border: 1px dashed #ffffff26; border-radius: 12px; }
  .field { display: flex; gap: 8px; margin-top: 8px; }
  input, select { width: 100%; padding: 8px 10px; border-radius: 9px; border: 1px solid #ffffff20;
                  background: #0b0e14; color: #e8ecf3; font-size: 13px; outline: none; }
  input:focus, select:focus { border-color: #ff8a3d88; }
  .hint { font-size: 11px; color: #ffb27a; margin-top: 6px; }
  .notice { margin: 0 12px 10px; padding: 7px 10px; border-radius: 9px; font-size: 12px;
            background: #ff8a3d1a; border: 1px solid #ff8a3d40; color: #ffc79a; }
  .notice.err { background: #ef44441a; border-color: #ef444455; color: #fca5a5; }
  .prog { margin: 10px 12px 0; }
  .prog .bar { margin: 0; }
  .list { display: flex; flex-direction: column; gap: 6px; }
  .item { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 9px; background: #ffffff07; font-size: 12px; }
  .item .no { color: #6b7280; width: 26px; }
  .item .g { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .item .p { font-variant-numeric: tabular-nums; }
  .item .p.me { color: #6ee7b7; }
  .item .p.ai { color: #93c5fd; }
  .final { padding: 12px; text-align: center; border-radius: 12px; background: #ff8a3d14; border: 1px solid #ff8a3d40; }
  .final .big { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
  .kv { display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0; border-bottom: 1px dashed #ffffff12; }
  .kv:last-child { border-bottom: 0; }
  .foot { margin-top: 10px; font-size: 11px; color: #6b7280; text-align: center; }
  .tag { display:inline-block; padding:0 6px; height:18px; line-height:18px; border-radius:6px; background:#ffffff10; color:#9aa4b2; font-size:10px; }

  /* 分步定位动画弹层 */
  .modal { position: fixed; inset: 0; background: #05070bcc; display: none; align-items: center; justify-content: center;
           pointer-events: auto; z-index: 5; }
  .modal.on { display: flex; }
  .mcard { width: min(760px, 94vw); background: #121720f7; border: 1px solid #ffffff22; border-radius: 16px;
           box-shadow: 0 24px 70px #000000b0; overflow: hidden; }
  .mhd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #ffffff14; }
  .mhd b { font-size: 13px; }
  .mhd .mstep { font-size: 11px; color: #9aa4b2; margin-left: auto; }
  #tx-mapcanvas { display: block; width: 100%; height: 380px; background: #0a1424; }
  .mcard.big { width: 96vw; }
  .mcard.big #tx-mapcanvas { height: 68vh; }
  .mcap { padding: 10px 14px 4px; min-height: 62px; }
  .mcap b { font-size: 13px; color: #ffb27a; display: block; margin-bottom: 2px; }
  .mcap div { font-size: 12px; color: #c3ccdb; line-height: 1.55; }
  .mft { display: flex; gap: 8px; padding: 8px 14px 14px; }
  .mft .btn { width: auto; flex: 1; padding: 8px; }
  .progress-dots { display: flex; gap: 5px; align-items: center; padding: 0 14px 8px; }
  .progress-dots i { width: 6px; height: 6px; border-radius: 50%; background: #ffffff22; display: block; }
  .progress-dots i.on { background: #ff8a3d; box-shadow: 0 0 8px #ff8a3d90; }
  .mhint { padding: 0 14px 12px; font-size: 11px; color: #7d8898; }
  /* 截图预览 */
  .svcard { width: min(1100px, 96vw); background: #0b0f16f2; border: 1px solid #ffffff22; border-radius: 14px; overflow: hidden; }
  .svhd { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #ffffff14; font-size: 12px; color: #9aa4b2; }
  .svhd b { color: #e6edf7; font-size: 13px; }
  .svhd .svlabel { margin-left: auto; font-variant-numeric: tabular-nums; }
  .svbody { padding: 8px; background: #000; display: flex; justify-content: center; }
  #tx-shimg { max-width: 100%; max-height: 70vh; display: block; }
  .svft { display: flex; gap: 8px; padding: 8px 12px 12px; }
  .svft .btn { width: auto; flex: 1; padding: 8px; }
  `;

  /* ------------------------------ DOM ------------------------------ */
  const host = document.createElement('div');
  host.id = 'txai-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  shadow.appendChild(styleEl);
  shadow.appendChild(wrap);

  /* -------------------- 分步定位动画弹层（独立于面板重绘） -------------------- */
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="mcard">
      <div class="mhd"><b>AI 是怎么一步步排除的</b>
        <span class="mstep" id="tx-mstep">1/1</span>
        <button class="hbtn" data-act="map-close" title="关闭">×</button>
      </div>
      <canvas id="tx-mapcanvas"></canvas>
      <div class="progress-dots" id="tx-mdots"></div>
      <div class="mcap"><b id="tx-maptitle">…</b><div id="tx-maptext"></div></div>
      <div class="mft">
        <button class="btn ghost" data-act="map-prev">上一步</button>
        <button class="btn ghost" data-act="map-next">下一步</button>
        <button class="btn ghost" data-act="map-auto">暂停自动</button>
        <button class="btn ghost" data-act="map-big">全屏</button>
        <button class="btn ghost" data-act="map-replay">重播</button>
      </div>
      <div class="mhint">地图与图寻同源（中文注记/道路/地形），可拖动平移、滚轮缩放；每一步都按 AI 这次的回答实时生成。</div>
    </div>`;
  shadow.appendChild(modal);
  let mapAnim = null;

  function mapStepsFromAnim() {
    const showTruth = !(S.settings && S.settings.hideTruth);
    const src = S.current
      ? { guess: S.current.guess, truth: showTruth ? S.current.truth : null }
      : S.lastAnim ? { guess: S.lastAnim.guess, truth: showTruth ? S.lastAnim.truth : null } : null;
    const A = window.__TX_MAP_ANIM__;
    if (!A || !src || !src.guess) return null;
    return A.buildSteps({ guess: src.guess, truth: src.truth, aiLabel: 'AI 猜测' });
  }

  let shotView = null;

  function ensureShotView() {
    if (shotView) return shotView;
    shotView = document.createElement('div');
    shotView.className = 'modal';
    shotView.innerHTML = `<div class="svcard">
      <div class="svhd"><b>发给 AI 的截图</b><span class="svlabel" id="tx-shotlabel"></span><button class="hbtn" data-act="shot-close">×</button></div>
      <div class="svbody"><img id="tx-shimg" alt="截图"></div>
      <div class="svft"><button class="btn ghost" data-act="shot-prev">上一张</button><button class="btn ghost" data-act="shot-next">下一张</button></div>
    </div>`;
    shadow.appendChild(shotView);
    return shotView;
  }

  function renderShot() {
    if (!shotView) return;
    const cur = S.current;
    const imgs = (cur && cur.images) || [];
    const idx = clamp(Number(S.shotIndex) || 0, 0, Math.max(0, imgs.length - 1));
    const img = shotView.querySelector('#tx-shimg');
    if (img && imgs[idx]) img.src = imgs[idx];
    const lbl = shotView.querySelector('#tx-shotlabel');
    if (lbl) lbl.textContent = imgs.length ? idx + 1 + ' / ' + imgs.length : '';
  }

  function openShot(i) {
    const cur = S.current;
    if (!cur || !cur.images || !cur.images.length) {
      setNotice('这一回合还没有截图', true);
      return;
    }
    ensureShotView();
    S.shotIndex = clamp(Number(i) || 0, 0, cur.images.length - 1);
    shotView.classList.add('on');
    renderShot();
  }

  function closeShot() {
    if (shotView) shotView.classList.remove('on');
  }

  function openMapModal() {
    const A = window.__TX_MAP_ANIM__;
    const steps = mapStepsFromAnim();
    if (!A) {
      setNotice('正在重新加载地图模块…');
      chrome.runtime
        .sendMessage({ type: 'inject-modules' })
        .then(() => {
          setTimeout(() => {
            if (window.__TX_MAP_ANIM__) openMapModal();
            else setNotice('地图动画模块仍没加载：到 edge://extensions 点刷新扩展，再刷新页面', true);
          }, 500);
        })
        .catch(() => setNotice('地图动画模块没加载：刷新一下页面再试', true));
      return;
    }
    if (!steps || !steps.length) {
      setNotice('先让 AI 猜一次，再来看「一步步排除」动画', true);
      return;
    }
    modal.classList.add('on');
    const canvas = modal.querySelector('#tx-mapcanvas');
    const titleEl = modal.querySelector('#tx-maptitle');
    const textEl = modal.querySelector('#tx-maptext');
    const stepEl = modal.querySelector('#tx-mstep');
    const dotsEl = modal.querySelector('#tx-mdots');
    if (!mapAnim) {
      mapAnim = A.create(canvas, {
        onTileFail() {
          const hint = modal.querySelector('.mhint');
          if (hint) {
            hint.textContent = '⚠ 地图瓦片加载失败，已退回离线轮廓（可能是网络或瓦片源不可用）；步骤说明不受影响。';
            hint.style.color = '#fca5a5';
          }
        },
        onStep(step, i, total) {
          titleEl.textContent = step.title || '';
          textEl.textContent = step.text || '';
          stepEl.textContent = `${i + 1}/${total}`;
          dotsEl.innerHTML = Array.from({ length: total }, (_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('');
        },
      });
    }
    setTimeout(() => {
      if (mapAnim) mapAnim.play(steps);
    }, 40);
  }

  function closeMapModal() {
    modal.classList.remove('on');
    if (mapAnim) {
      mapAnim.destroy();
      mapAnim = null;
    }
    // 清掉瓦片缓存，释放内存
    try {
      window.__TX_MAP_ANIM__ && window.__TX_MAP_ANIM__.clearTiles && window.__TX_MAP_ANIM__.clearTiles();
    } catch (e) {}
  }

  modal.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'map-close') closeMapModal();
    else if (act === 'map-prev') mapAnim && mapAnim.prev();
    else if (act === 'map-next') mapAnim && mapAnim.next();
    else if (act === 'map-replay') {
      const s = mapStepsFromAnim();
      if (mapAnim && s) mapAnim.play(s);
    } else if (act === 'map-big') {
      const card = modal.querySelector('.mcard');
      card.classList.toggle('big');
      el.textContent = card.classList.contains('big') ? '还原' : '全屏';
      setTimeout(() => mapAnim && mapAnim.redraw(), 60);
    } else if (act === 'map-auto') {
      if (mapAnim) {
        const on = mapAnim.toggleAuto();
        el.textContent = on ? '暂停自动' : '自动播放';
      }
    }
  });

  // 测试/截图用：document.dispatchEvent(new CustomEvent('txai-step', {detail:{i}}))
  document.addEventListener('txai-step', (e) => {
    if (mapAnim && e.detail && typeof e.detail.i === 'number') mapAnim.show(e.detail.i);
  });

  window.addEventListener('resize', () => {
    if (mapAnim && modal.classList.contains('on')) mapAnim.redraw();
  });

  document.documentElement.appendChild(host);

  function panelPos() {
    if (S.pos) return S.pos;
    return { x: Math.max(12, window.innerWidth - 396), y: 84 };
  }

  /* ------------------------------ 渲染 ------------------------------ */
  const statusText = () => {
    if (!S.enabled) return '已暂停';
    if (!S.lastState) return '连接中…';
    if (!S.lastState.ok) {
      const inGame = /\/(solo|party|challenge|daily|streak)\b/.test(location.pathname || '');
      return inGame ? '未检测到街景实例 · 可用整屏截图' : '没检测到街景';
    }
    return `街景已连接 · 回合 ${S.battle.rounds.length + (S.current ? 1 : 0)}/${S.battle.target}`;
  };

  function scoreTotals() {
    const mine = S.battle.rounds.reduce((a, r) => a + (Number(r.playerScore) || 0), 0);
    const ai = S.battle.rounds.reduce((a, r) => a + (Number(r.aiScore) || 0), 0);
    return { mine, ai };
  }

  function render() {
    // 设置页正在输入/选择时，不要整块重绘：会丢失焦点、把列表滚回顶部
    try {
      const ae = shadow.activeElement;
      if (S.tab === 'settings' && ae && ae.id && ae.id.indexOf('tx-') === 0 && (ae.tagName === 'SELECT' || ae.tagName === 'INPUT')) {
        return;
      }
    } catch (e) {}
    const st = S.lastState;
    const p = panelPos();
    const { mine, ai } = scoreTotals();
    const rounds = S.battle.rounds;
    const done = rounds.length;
    const total = S.battle.target;
    const finalDone = done >= total;

    const head = `
      <div class="hd" id="tx-drag">
        <span class="dot ${st && st.ok ? 'on' : ''}"></span>
        <b>图寻 AI</b>
        <span class="sub" id="tx-status">${esc(statusText())}</span>
        <span class="sp"></span>
        <span class="sw ${S.enabled ? 'on' : ''}" data-act="power" title="${S.enabled ? '运行中，点击暂停全部功能' : '已暂停，点击恢复'}"></span>
        <button class="hbtn" data-act="collapse" title="收起">${S.collapsed ? '+' : '−'}</button>
        <button class="hbtn" data-act="close" title="隐藏（点工具栏图标可再打开）">×</button>
      </div>`;

    if (S.collapsed) {
      wrap.innerHTML = `<div class="panel min" style="left:${p.x}px;top:${p.y}px">${head}</div>`;
      bindDrag();
      return;
    }

    const pausedBanner = S.enabled
      ? ''
      : '<div class="notice" style="margin:0 12px 10px">⏸ 已暂停：街景监听、自动打点、自动提交、全自动循环都停了。点右上角开关恢复。</div>';

    const notice = S.notice
      ? `<div class="notice ${S.noticeErr ? 'err' : ''}">${esc(S.notice)}</div>`
      : '';

    const prog = S.busy && S.progress
      ? `<div class="prog"><div class="bar"><i style="width:${Math.round((S.progress.i / S.progress.n) * 100)}%"></i></div>
         <div class="small muted mt" style="margin-top:4px">正在截取第 ${S.progress.i}/${S.progress.n} 个朝向…</div></div>`
      : '';

    const modeBar = `
      <div class="tabs" style="padding-top:2px">
        <div class="tab ${S.mode === 'battle' ? 'on' : ''}" data-act="mode" data-mode="battle">对战模式</div>
        <div class="tab ${S.mode === 'auto' ? 'on' : ''}" data-act="mode" data-mode="auto">AI 代打</div>
        <div class="tab ${S.mode === 'direct' ? 'on' : ''}" data-act="mode" data-mode="direct">直接答案</div>
      </div>`;

    const scoreBar = S.mode !== 'battle'
      ? `
      <div class="score">
        <div class="side ai" style="flex:1.6"><div class="n" id="tx-ai">${fmt(ai)}</div><div class="lbl">${S.mode === 'direct' ? '直接答案累计' : 'AI 累计'}（${done}/${total} 回合）</div></div>
      </div>`
      : `
      <div class="score">
        <div class="side mine"><div class="n" id="tx-mine">${fmt(mine)}</div><div class="lbl">我</div></div>
        <div class="vs">VS</div>
        <div class="side ai"><div class="n" id="tx-ai">${fmt(ai)}</div><div class="lbl">DeepSeek</div></div>
      </div>`;

    const tabs = `
      <div class="tabs">
        <div class="tab ${S.tab === 'main' ? 'on' : ''}" data-act="tab" data-tab="main">对战</div>
        <div class="tab ${S.tab === 'history' ? 'on' : ''}" data-act="tab" data-tab="history">记录 ${done ? `(${done})` : ''}</div>
        <div class="tab ${S.tab === 'settings' ? 'on' : ''}" data-act="tab" data-tab="settings">设置</div>
      </div>`;

    let body = '';
    if (S.tab === 'settings') body = settingsView();
    else if (S.tab === 'history') body = historyView();
    else body = mainView({ prog, finalDone, total });

    const prevBd = shadow.querySelector('.bd');
    if (prevBd && S.tab === 'settings') S.settingsScroll = prevBd.scrollTop;
    const prevScroll = S.tab === 'settings' ? Number(S.settingsScroll) || 0 : prevBd ? prevBd.scrollTop : 0;
    wrap.innerHTML = `<div class="panel" style="left:${p.x}px;top:${p.y}px">${head}${modeBar}${scoreBar}${tabs}
      <div class="bd">${pausedBanner}${notice}${body}</div></div>`;
    const nextBd = shadow.querySelector('.bd');
    if (nextBd && prevScroll && S.tab === 'settings') nextBd.scrollTop = prevScroll;
    const mini = shadow.getElementById('tx-minimap');
    if (mini && S.current && S.current.guess && S.current.guess.lat != null) {
      const A = window.__TX_MAP_ANIM__;
      if (A && A.renderStatic) {
        A.renderStatic(mini, { lat: S.current.guess.lat, lng: S.current.guess.lng });
      }
    }
    bindDrag();
  }

  function mainView({ prog, finalDone, total }) {
    const cur = S.current;
    const { mine, ai } = scoreTotals();
    const diff = mine - ai;

    const done = S.battle.rounds.length;
    const avgAi = done ? Math.round(ai / done) : 0;
    const finalBlock = finalDone
      ? S.mode !== 'battle'
        ? `<div class="final mt">
             <div class="big">${S.mode === 'direct' ? '直接答案' : 'AI'} 跑完 ${total} 回合：累计 ${fmt(ai)} 分</div>
             <div class="small muted">平均 ${avgAi} 分/回合</div>
             <div class="row mt"><button class="btn ghost" data-act="reset">清空重来</button></div>
           </div>`
        : `<div class="final mt">
           <div class="big">${diff >= 0 ? `你赢了 DeepSeek ${fmt(diff)} 分` : `DeepSeek 赢了你 ${fmt(-diff)} 分`}</div>
           <div class="small muted">${total} 回合 · 你 ${fmt(mine)} : ${fmt(ai)} DeepSeek</div>
           <div class="row mt"><button class="btn ghost" data-act="reset">重新开一局对战</button></div>
         </div>`
      : '';

    const autoPanel = S.mode !== 'battle'
      ? `<button class="btn ${S.autoLoop ? 'ghost' : ''}" data-act="autoloop">
           ${S.autoLoop ? '⏹ 停止全自动' : '▶ 开始全自动跑'}
         </button>
         <div class="small muted mt">${S.mode === 'direct'
           ? '全自动：读街景坐标 → 反查国家 → 自动打点 → 自动提交 → 记录，回合结束自动进入下一题。'
           : '全自动：AI 截图 → 判断 → 线索库复核 → 自动打点 → 自动提交 → 记录，回合结束后自动进入下一题。'}${S.autoLoop ? '（正在跑）' : ''}</div>`
      : '';

    const aiCard = cur
      ? `<div class="card">
           <div class="title"><b>${esc(cur.guess.country || '未知地点')}</b>
             ${cur.guess.region ? `<span class="muted small">${esc(cur.guess.region)}</span>` : ''}</div>
           <div class="small muted mt">${cur.guess.lat != null ? `${cur.guess.lat.toFixed(4)}, ${cur.guess.lng.toFixed(4)}` : '无坐标'} ·
             置信度 ${cur.guess.confidence != null ? Math.round(cur.guess.confidence * 100) + '%' : '—'}</div>
           ${cur.guess.lat != null ? '<canvas id="tx-minimap" class="minimap" data-act="minimap" title="点这张小地图看大图/精确位置"></canvas>' : ''}
           <div class="bar"><i style="width:${Math.round((cur.guess.confidence || 0.15) * 100)}%"></i></div>
           ${(cur.thumbnails || []).length >= 1
             ? `<div class="thumbs">${cur.thumbnails
                 .map((u, i) => `<img src="${u}" alt="视角${i + 1}" title="点击看发给 AI 的原图（第 ${i + 1} 张）" data-act="shot" data-i="${i}">`)
                 .join('')}</div>`
             : ''}
           ${cur.guess.summary ? `<div class="small">${esc(cur.guess.summary)}</div>` : ''}
           ${(cur.guess.clues || []).map((c) => `
             <div class="clue"><span class="k">${esc(c.kind)}</span>
               <span class="t">${esc(c.see)}<div class="w">${esc(c.why)}</div></span></div>`).join('')}
           ${(cur.guess.alternatives || []).length ? `<div class="small muted mt">备选：${cur.guess.alternatives
             .map((a) => `${esc(a.place)}${a.weight != null ? `(${Math.round(a.weight * 100)}%)` : ''}`).join('、')}</div>` : ''}
           ${cur.reasoning ? `<details><summary>看 AI 的推理过程</summary><pre>${esc(cur.reasoning)}</pre></details>` : ''}
           ${cur.guess.teaching ? `<details open><summary>教练口诀（教我为什么）</summary><div class="teach">${esc(cur.guess.teaching)}</div></details>` : ''}
           ${S.reviewPending && !cur.guess.review
             ? `<div class="meta-review" style="border-left-color:#f59e0b"><div class="small muted">线索库复核中…（不阻塞上面的结论）</div></div>`
             : ''}
           ${cur.guess.review
             ? `<div class="meta-review">
                  <div class="small"><b>线索库复核</b> · ${cur.guess.metaAdjusted ? '已按 Plonk It 线索修正' : '与当地特征吻合'}${cur.guess.review.sourceCountry ? '（' + esc(cur.guess.review.sourceCountry) + '）' : ''}</div>
                  ${cur.guess.review.reason ? `<div class="small muted">${esc(cur.guess.review.reason)}</div>` : ''}
                  ${(cur.guess.review.matched || []).length ? `<div class="small muted">符合：${cur.guess.review.matched.map(esc).join('；')}</div>` : ''}
                  ${(cur.guess.review.mismatched || []).length ? `<div class="small" style="color:#fca5a5">矛盾：${cur.guess.review.mismatched.map(esc).join('；')}</div>` : ''}
                </div>`
             : ''}
           <button class="btn ghost mt" data-act="map">🗺️ 看 AI 一步步排除定位</button>
           <button class="btn mt" data-act="pin">📍 在图寻地图上自动打点</button>
           ${S.pinStatus ? `<div class="hint">${esc(S.pinStatus)}</div>` : ''}
         </div>

         <div class="settle" style="${S.mode !== 'battle' ? 'display:none' : ''}">
           <div class="small">你这一回合在图寻得了多少分？</div>
           <div class="field">
             <input id="tx-score" type="number" min="0" max="5000" placeholder="${S.autoScore != null ? '检测到 ' + S.autoScore : '例如 4200'}">
             <button class="btn" style="width:96px" data-act="settle">结算</button>
           </div>
           <div class="row mt">
             <button class="btn ghost" data-act="autoscore">自动识别我的得分</button>
           </div>
           ${S.autoScore != null ? `<div class="hint">从对局数据里找到可能是 ${S.autoScore} 分，直接填进输入框即可</div>` : ''}
           ${!cur.truth
             ? `<div class="hint">没自动取到真实坐标：手动填一下 lat, lng（图寻结算页的地点坐标），AI 才会算分</div>
                <div class="field"><input id="tx-truth" placeholder="例如 48.8584, 2.2945"></div>`
             : ''}
         </div>`
      : '';

    const last = S.battle.rounds.length ? S.battle.rounds[S.battle.rounds.length - 1] : null;
    const lastBlock = last
      ? `<div class="card">
           <div class="small muted">上一回合 · 真实地点 ${last.truthLat != null ? `${last.truthLat.toFixed(3)}, ${last.truthLng.toFixed(3)}` : '未知'}</div>
           <div class="kv"><span>${S.mode === 'direct' ? '答案' : 'AI 猜'}</span><span>${esc(last.aiCountry || '')}${last.aiRegion ? ' · ' + esc(last.aiRegion) : ''}</span></div>
           <div class="kv"><span>${S.mode === 'direct' ? '偏差' : 'AI 偏差'}</span><span>${last.distanceKm != null ? fmt(last.distanceKm) + ' km' : '—'}</span></div>
           <div class="kv"><span>${S.mode === 'direct' ? '得分' : 'AI 得分'}</span><span>${fmt(last.aiScore)}</span></div>
           <div class="kv"><span>你的得分</span><span>${fmt(last.playerScore)}</span></div>
           <div class="row mt"><button class="btn ghost" data-act="map">🗺️ 回放定位动画</button></div>
           ${S.lastReview
             ? `<details open><summary>AI 复盘</summary><div class="teach">${esc(S.lastReview)}</div></details>`
             : `<button class="btn ghost mt" data-act="review">让 AI 复盘这一回合</button>`}
         </div>`
      : '';

    const st = S.lastState;
    const startHint = !st || !st.ok
      ? `<div class="hint">还没检测到街景实例：先进入一局游戏。如果游戏里仍然如此，点上面的按钮会退回「整屏截图」模式（不能自动转视角，答案坐标要手动填）。</div>`
      : (!S.settings || !S.settings.apiKey
        ? `<div class="hint">还没配置 DeepSeek API Key，去「设置」里填一下。</div>`
        : (!S.authOk ? `<div class="hint">小提示：第一次用先点一下浏览器工具栏的扩展图标，给截图授权。</div>` : ''));

    const authBanner = S.needAuth
      ? `<div class="notice" style="margin:0 0 10px">
           ⚠️ 还没拿到截图权限：点一下浏览器右上角工具栏里的扩展图标（图寻 AI），
           然后回到这里点下面的按钮。每次整页刷新后需要点一次。
         </div>`
      : '';

    return `
      ${authBanner}
      ${S.mode === 'direct'
        ? `<button class="btn mt" data-act="direct" ${S.busy || !S.enabled ? 'disabled' : ''}>
             ⚡ 直接出答案（读街景坐标，100% 准）
           </button>
           <div class="small muted mt">直接答案模式：不调用 AI，直接读街景对象坐标 → 反查国家 → 自动打点 → 自动提交。绝对准确。</div>`
        : `<button class="btn ghost mt" data-act="direct">⚡ 直接出答案（读街景坐标，100% 准）</button>
           <button class="btn" data-act="ask" ${S.busy || !S.enabled ? 'disabled' : ''}>
             ${S.busy ? 'AI 正在看图…' : '🤖 让 DeepSeek 看图猜位置'}
           </button>
           <div class="small muted mt">会自动把街景环视 360° 截下来发给 AI；快速档通常 10~15 秒出结论，线索库复核随后补上（准确档会明显更慢但更准）。</div>`}
      ${S.timing ? `<div class="hint">耗时：${S.captureKind === 'canvas' ? '画布' : '截图'} ${(S.timing.capture / 1000).toFixed(1)}s · 判断 ${S.timing.first ? (S.timing.first / 1000).toFixed(1) + 's' : '—'} · 首屏合计 ${((S.timing.total || 0) / 1000).toFixed(1)}s${S.timing.review ? ' · 线索库复核 ' + (S.timing.review / 1000).toFixed(1) + 's' : ''}</div>` : ''}
      ${startHint}
      ${prog}
      ${finalBlock}
      ${autoPanel}
      ${aiCard}
      ${lastBlock}
      <div class="foot">截图只发给你的 DeepSeek 账号；不做任何上传。</div>`;
  }

  function donePlayerAvg(sum, n) {
    return n ? fmt(Math.round((sum || 0) / n)) : '—';
  }

  function historyView() {
    if (!S.battle.rounds.length) return `<div class="muted small">还没有结算过回合。打完一回合，输入你的得分点「结算」即可记录。</div>`;
    const { mine, ai } = scoreTotals();
    const n = S.battle.rounds.length;
    const avg = n ? Math.round(ai / n) : 0;
    return `
      <div class="list">
        ${S.battle.rounds
          .map(
            (r, i) => `<div class="item" data-act="replay" data-i="${i}" title="点这一行回看这回合的排除过程">
              <span class="no">#${i + 1}</span>
              <span class="g">${esc(r.aiCountry || '—')}${r.aiRegion ? ' · ' + esc(r.aiRegion) : ''}</span>
              <span class="p me">${fmt(r.playerScore)}</span>
              <span class="muted">:</span>
              <span class="p ai">${fmt(r.aiScore)}</span>
            </div>`,
          )
          .join('')}
      </div>
      <div class="kv mt"><span>合计</span><span><b style="color:#6ee7b7">${fmt(mine)}</b> : <b style="color:#93c5fd">${fmt(ai)}</b></span></div>
      <div class="kv"><span>平均 / 回合</span><span>${donePlayerAvg(mine, n)} : <b style="color:#93c5fd">${avg}</b></span></div>
      <button class="btn ghost mt" data-act="reset">清空对战记录</button>`;
  }

  function settingsView() {
    const s = settingsMasked();
    return `
      <div class="small muted">API Key（只存在本机浏览器里）</div>
      <div class="field"><input id="tx-key" type="password" placeholder="${s.hasKey ? '已配置：' + esc(s.apiKeyMasked || '') : 'sk-...'}" autocomplete="off"></div>
      <div class="kv mt"><span>模型</span></div>
      <div class="field">
        <select id="tx-model">
          <option value="deepseek-flash" ${s.model === 'deepseek-flash' ? 'selected' : ''}>deepseek-flash（支持看图）</option>
          <option value="deepseek-v4-pro" ${s.model === 'deepseek-v4-pro' ? 'selected' : ''}>deepseek-v4-pro（纯文本，不推荐）</option>
        </select>
      </div>
      <div class="kv mt"><span>无感模式（不动视角、不隐藏面板，表面看不出在截图）</span></div>
      <div class="field">
        <select id="tx-stealth">
          <option value="0" ${!s.stealth ? 'selected' : ''}>关闭</option>
          <option value="1" ${s.stealth ? 'selected' : ''}>开启（只截当前画面，1 帧）</option>
        </select>
      </div>
      <div class="kv mt"><span>自动收起面板（闲置 8 秒收成小条；鼠标在面板上不会收）</span></div>
      <div class="field">
        <select id="tx-autocollapse">
          <option value="0" ${!s.autoCollapse ? 'selected' : ''}>关闭（推荐）</option>
          <option value="1" ${s.autoCollapse ? 'selected' : ''}>开启</option>
        </select>
      </div>
      <div class="kv mt"><span>直接答案模式（自动流程不用 AI，直接读街景坐标出答案；相当于读答案）</span></div>
      <div class="field">
        <select id="tx-direct">
          <option value="0" ${!s.directAuto ? 'selected' : ''}>关闭（用 AI 猜）</option>
          <option value="1" ${s.directAuto ? 'selected' : ''}>开启（全自动时直接出答案）</option>
        </select>
      </div>
      <div class="kv mt"><span>隐藏真实位置（不剧透：地图动画不显示答案坐标，但分数照常算）</span></div>
      <div class="field">
        <select id="tx-hidetruth">
          <option value="0" ${!s.hideTruth ? 'selected' : ''}>不隐藏（能看到真实位置）</option>
          <option value="1" ${s.hideTruth ? 'selected' : ''}>隐藏（保留悬念）</option>
        </select>
      </div>
      <div class="kv mt"><span>跟随我转动（我自己转视角，转到合适角度时静默抓帧，攒够自动看图；扩展不自己转）</span></div>
      <div class="field">
        <select id="tx-passive">
          <option value="0" ${!s.passiveCapture ? 'selected' : ''}>关闭</option>
          <option value="1" ${s.passiveCapture ? 'selected' : ''}>开启</option>
        </select>
      </div>
      <div class="kv mt"><span>拟人间隔（AI 代打提交前随机等 2.5~9 秒，避免固定节奏）</span></div>
      <div class="field">
        <select id="tx-humanize">
          <option value="0" ${!s.humanize ? 'selected' : ''}>关闭</option>
          <option value="1" ${s.humanize ? 'selected' : ''}>开启</option>
        </select>
      </div>
      <div class="kv mt"><span>抓图方式（画布=直接读街景画布，无 UI 遮挡）</span></div>
      <div class="field">
        <select id="tx-capture">
          <option value="auto" ${s.captureMode !== 'tabs' ? 'selected' : ''}>自动（优先画布，失败退回截图）</option>
          <option value="tabs" ${s.captureMode === 'tabs' ? 'selected' : ''}>整屏截图（旧方式）</option>
        </select>
      </div>
      <div class="kv mt"><span>速度档位</span></div>
      <div class="field">
        <select id="tx-profile">
          <option value="fast" ${s.profile === 'fast' ? 'selected' : ''}>快速（3 张图，约 10~15 秒，日常推荐）</option>
          <option value="balanced" ${s.profile === 'balanced' ? 'selected' : ''}>平衡（4 张图，约 18~25 秒）</option>
          <option value="accurate" ${s.profile === 'accurate' ? 'selected' : ''}>准确（5 张图 + 完整复核，约 30~45 秒）</option>
        </select>
      </div>
      <div class="kv mt"><span>360° 截图张数</span></div>
      <div class="field">
        <select id="tx-frames">
          ${[1, 2, 4, 6].map((n) => `<option value="${n}" ${Number(s.frames) === n ? 'selected' : ''}>${n} 张${n === 1 ? '（只看当前朝向）' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="kv mt"><span>对战回合数</span></div>
      <div class="field">
        <select id="tx-rounds">
          ${[5, 10, 20, 30].map((n) => `<option value="${n}" ${Number(S.battle.target) === n ? 'selected' : ''}>${n} 回合</option>`).join('')}
        </select>
      </div>
      <div class="kv mt"><span>深度模式（默认关。只有在「没检测到街景」时才开；会改图寻 API，可能被检测）</span></div>
      <div class="field">
        <select id="tx-deep">
          <option value="0" ${!s.deep ? 'selected' : ''}>关闭（推荐，不改页面）</option>
          <option value="1" ${s.deep ? 'selected' : ''}>开启（用构造函数兜底捕获）</option>
        </select>
      </div>
      <div class="kv mt"><span>自动打点（AI 出结果后自动在图寻地图上点）</span></div>
      <div class="field">
        <select id="tx-autopin">
          <option value="1" ${s.autoPin !== false ? 'selected' : ''}>开启（推荐）</option>
          <option value="0" ${s.autoPin === false ? 'selected' : ''}>关闭</option>
        </select>
      </div>
      <div class="kv mt"><span>AI 代打：自动提交（只点图寻的确认按钮）</span></div>
      <div class="field">
        <select id="tx-autosubmit">
          <option value="1" ${s.autoSubmit !== false ? 'selected' : ''}>开启</option>
          <option value="0" ${s.autoSubmit === false ? 'selected' : ''}>关闭</option>
        </select>
      </div>
      <div class="kv mt"><span>AI 代打：自动进入下一题</span></div>
      <div class="field">
        <select id="tx-autonext">
          <option value="1" ${s.autoNext !== false ? 'selected' : ''}>开启</option>
          <option value="0" ${s.autoNext === false ? 'selected' : ''}>关闭</option>
        </select>
      </div>
      <div class="kv mt"><span>线索库复核（Plonk It，更准但稍慢）</span></div>
      <div class="field">
        <select id="tx-meta">
          <option value="1" ${s.metaReview !== false ? 'selected' : ''}>开启（推荐）</option>
          <option value="0" ${s.metaReview === false ? 'selected' : ''}>关闭</option>
        </select>
      </div>
      <div class="kv mt"><span>AI 推理强度</span></div>
      <div class="field">
        <select id="tx-effort">
          <option value="low" ${s.effort === 'low' ? 'selected' : ''}>low（快、省 token，推荐）</option>
          <option value="high" ${s.effort === 'high' ? 'selected' : ''}>high（更缜密，但慢且贵）</option>
          <option value="" ${!s.effort ? 'selected' : ''}>默认</option>
        </select>
      </div>
      <div class="kv mt"><span>单次最大输出 token（含推理）</span></div>
      <div class="field"><input id="tx-maxtok" type="number" min="1000" max="16000" value="${Number(s.maxTokens) || 4000}"></div>
      <div class="kv mt"><span>转动视角后等待（毫秒）</span></div>
      <div class="field"><input id="tx-settle" type="number" min="300" max="3000" value="${Number(s.settleMs) || 850}"></div>
      <div class="row mt">
        <button class="btn" data-act="save">保存设置</button>
        <button class="btn ghost" style="width:110px" data-act="testkey">测试 Key</button>
      </div>
      <button class="btn ghost mt" data-act="diag">🩺 诊断街景（黑屏时点这个）</button>
      <div id="tx-diag" class="small muted mt"></div>
      <div class="foot">截图需要「activeTab」授权：在 tuxun.fun 页面点一下浏览器工具栏的扩展图标即可。</div>`;
  }

  /* ------------------------------ 拖拽 ------------------------------ */
  function bindDrag() {
    const hd = shadow.getElementById('tx-drag');
    if (!hd) return;
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const start = panelPos();
      const ox = e.clientX - start.x;
      const oy = e.clientY - start.y;
      const move = (ev) => {
        S.pos = {
          x: clamp(ev.clientX - ox, 4, window.innerWidth - 200),
          y: clamp(ev.clientY - oy, 4, window.innerHeight - 60),
        };
        const panel = shadow.querySelector('.panel');
        if (panel) {
          panel.style.left = S.pos.x + 'px';
          panel.style.top = S.pos.y + 'px';
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /* ------------------------------ 事件 ------------------------------ */
  wrap.addEventListener('change', async (e) => {
    if (S.tab !== 'settings') return;
    const t = e.target;
    if (!t || (t.tagName !== 'SELECT' && t.tagName !== 'INPUT')) return;
    S.lastAct = Date.now();
    try {
      await saveSettings(true);
    } catch (err) {
      console.warn('[图寻AI] 设置自动保存失败', err);
    }
  });

  const markAct = () => {
    S.lastAct = Date.now();
  };
  wrap.addEventListener('pointermove', markAct);
  wrap.addEventListener('pointerdown', markAct);
  wrap.addEventListener('mouseenter', markAct);

  wrap.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) {
      if (S.collapsed) {
        S.collapsed = false;
        S.lastAct = Date.now();
        render();
      }
      return;
    }
    S.lastAct = Date.now();
    const act = el.dataset.act;
    try {
      if (act === 'collapse') {
        S.collapsed = !S.collapsed;
        render();
      } else if (act === 'close') {
        host.style.display = 'none';
      } else if (act === 'tab') {
        S.tab = el.dataset.tab;
        render();
      } else if (act === 'diag') {
        const d = await bridge('diag', {}, 4000);
        const el = shadow.getElementById('tx-diag');
        if (el) {
          el.textContent = 'top=' + d.top + ' · google=' + d.google + ' · 街景类=' + d.svp + ' · 已捕获=' + d.hasInstance + ' · pano=' + (d.panoId || '-') + ' · iframe=' + d.iframes + ' · canvas=' + d.canvases + ' · 画布=' + (d.canvas ? d.canvas.w + 'x' + d.canvas.h : '无') + ' · 猜点地图=' + (d.guessMap && d.guessMap.found ? d.guessMap.kind : '未找到') + (d.iframeSrcs && d.iframeSrcs.length ? ' · ' + d.iframeSrcs.join(' , ') : '');
        }
      } else if (act === 'power') {
        setEnabled(!S.enabled);
      } else if (act === 'mode') {
        setMode(el.dataset.mode);
      } else if (act === 'autoloop') {
        toggleAutoLoop();
      } else if (act === 'pin') {
        await placePin(false);
      } else if (act === 'replay') {
        const idx = Number(el.dataset.i) || 0;
        const r = S.battle.rounds[idx];
        if (r) {
          S.lastAnim = {
            guess: { lat: r.aiLat, lng: r.aiLng, country: r.aiCountry, region: r.aiRegion },
            truth: r.truthLat != null ? { lat: r.truthLat, lng: r.truthLng } : null,
          };
          openMapModal();
        }
      } else if (act === 'shot') {
        openShot(el.dataset.i);
      } else if (act === 'shot-close') {
        closeShot();
      } else if (act === 'shot-prev') {
        S.shotIndex = (Number(S.shotIndex) || 0) - 1;
        renderShot();
      } else if (act === 'shot-next') {
        S.shotIndex = (Number(S.shotIndex) || 0) + 1;
        renderShot();
      } else if (act === 'minimap') {
        openMapModal();
      } else if (act === 'map') {
        openMapModal();
      } else if (act === 'direct') {
        await directAnswer();
      } else if (act === 'ask') {
        await answerAuto();
      } else if (act === 'settle') {
        await settle();
      } else if (act === 'autoscore') {
        await autoScore();
      } else if (act === 'review') {
        await review();
      } else if (act === 'reset') {
        S.battle.rounds = [];
        S.current = null;
        S.lastReview = null;
        S.autoScore = null;
        await persistBattle();
        render();
      } else if (act === 'save') {
        await saveSettings();
      } else if (act === 'testkey') {
        await testKey();
      }
    } catch (err) {
      setNotice(String((err && err.message) || err), true);
    }
  });

  function setNotice(text, isErr) {
    S.notice = text || '';
    S.noticeErr = !!isErr;
    render();
    if (text) {
      clearTimeout(setNotice._t);
      setNotice._t = setTimeout(() => {
        S.notice = '';
        render();
      }, 8000);
    }
  }

  /* ------------------------------ 业务逻辑 ------------------------------ */
  function closePanel() {
    host.style.display = 'none';
  }

  function setPanelOpacity(v) {
    host.style.opacity = String(v);
  }

  async function refreshState() {
    if (!S.enabled) return;
    const st = await bridge('state', {}, 2500);
    const prevOk = S.lastState && S.lastState.ok;
    S.lastState = st && st.ok ? st : st || { ok: false };
    if (S.lastState.ok && S.lastState.panoId) {
      if (S.lastPanoId && S.lastPanoId !== S.lastState.panoId) {
        if (S.current && !S.current.settled) {
          S.notice = '新回合开始了：上一回合还没结算，记得补上你的得分。';
          S.noticeErr = false;
        }
        S.autoScore = null;
        S.lastReview = null;
        if (S.mode !== 'battle' && S.autoLoop && (!S.settings || S.settings.autoNext !== false)) {
          scheduleAutoNext(1600);
        }
      }
      S.lastPanoId = S.lastState.panoId;
    }
    // 只更新轻量状态，避免打断输入
    const dot = shadow.querySelector('.hd .dot');
    if (dot) dot.classList.toggle('on', !!S.lastState.ok);
    const sub = shadow.getElementById('tx-status');
    if (sub) sub.textContent = statusText();
    maybePassive(S.lastState);
    if (prevOk !== !!S.lastState.ok && S.tab !== 'settings') render();
    if (S.settings && S.settings.autoCollapse && !S.busy && !S.collapsed && S.tab !== 'settings' && Date.now() - S.lastAct > 8000) {
      S.collapsed = true;
      render();
    }
  }

  function captureRectWithoutPanel(st) {
    try {
      const host = document.getElementById('txai-host');
      const panel = host && host.shadowRoot && host.shadowRoot.querySelector('.panel');
      const vp = (st && st.viewport) || { w: window.innerWidth, h: window.innerHeight };
      const r = panel && panel.getBoundingClientRect();
      if (!r) return { x: 0, y: 0, w: vp.w, h: vp.h };
      const leftW = Math.max(0, Math.floor(r.left));
      const rightX = Math.max(0, Math.floor(r.right));
      const rightW = Math.max(0, Math.floor(vp.w - r.right));
      // 取更大的一块「没有面板遮挡」的区域
      if (rightW > leftW) return { x: rightX, y: 0, w: rightW, h: vp.h };
      if (leftW > 0) return { x: 0, y: 0, w: leftW, h: vp.h };
      return { x: 0, y: 0, w: vp.w, h: vp.h };
    } catch (e) {
      return null;
    }
  }

  function passiveDelta(a, b) {
    return Math.abs(((a - b + 540) % 360) - 180);
  }

  async function passiveCaptureFrame(st, heading) {
    const p = S.passive;
    if (p.capturing) return;
    p.capturing = true;
    try {
      const shot = await chrome.runtime.sendMessage({
        type: 'capture',
        rect: captureRectWithoutPanel(st),
        viewport: st.viewport,
      });
      if (shot && shot.ok && shot.dataUrl) {
        p.frames.push(shot.dataUrl);
        p.headings.push(Math.round(heading));
        p.lastCapHeading = heading;
        S.captureKind = 'passive';
      }
    } catch (e) {
      /* ignore */
    } finally {
      p.capturing = false;
    }
  }

  // 跟随用户自己转动：转到合适角度、画面稳定时静默抓一帧；攒够/停手后自动送 AI
  function maybePassive(st) {
    const s = S.settings || {};
    if (!s.passiveCapture || !st || !st.ok || S.busy) return;
    const h = st.pov && st.pov.heading;
    if (typeof h !== 'number' || !st.panoId) return;
    const p = S.passive;
    const target = clamp(Number(s.frames) || 4, 2, 6);
    if (p.panoId !== st.panoId) {
      p.panoId = st.panoId;
      p.frames = [];
      p.headings = [];
      p.lastHeading = h;
      p.lastCapHeading = null;
      p.stableSince = Date.now();
      return;
    }
    if (typeof p.lastHeading === 'number' && passiveDelta(h, p.lastHeading) > 4) p.stableSince = Date.now();
    p.lastHeading = h;
    const stable = Date.now() - p.stableSince > 350;
    const movedFromCapture = p.lastCapHeading == null ? 360 : passiveDelta(h, p.lastCapHeading);
    if (stable && movedFromCapture >= 35 && p.frames.length < target) passiveCaptureFrame(st, h);
    const stale = !S.current || S.current.panoId !== st.panoId;
    const idleShort = Date.now() - p.stableSince > 2500;
    const idleLong = Date.now() - p.stableSince > 6000;
    const ready = p.frames.length >= target || (idleShort && p.frames.length >= 2) || (idleLong && p.frames.length >= 1);
    if (stale && ready) {
      const imgs = p.frames.slice();
      p.frames = [];
      p.lastCapHeading = null;
      answerAuto(imgs);
    }
  }

  async function captureFrames(st) {
    const s = S.settings || {};
    const stealth = !!s.stealth;
    const frames = stealth ? 1 : clamp(Number(s.frames) || 4, 1, 6);
    const settleMs = clamp(Number(s.settleMs) || 850, 300, 3000);
    const baseHeading = st.pov && typeof st.pov.heading === 'number' ? st.pov.heading : 0;
    const basePitch = st.pov && typeof st.pov.pitch === 'number' ? st.pov.pitch : 0;
    const images = [];
    let canvasBroken = false;
    try {
      for (let i = 0; i < frames; i++) {
        const heading = (baseHeading + (360 / frames) * i) % 360;
        S.progress = { i: i + 1, n: frames };
        render();
        if (!stealth) {
          await bridge('setPov', { heading, pitch: 0, zoom: 1 });
          await sleep(settleMs);
        } else {
          await sleep(60);
        }
        let dataUrl = null;
        if (!canvasBroken && s.captureMode !== 'tabs') {
          const cv = await bridge('canvas', {}, 6000);
          if (cv && cv.ok) {
            for (const cand of [cv.dataUrl, cv.altUrl]) {
              if (!cand) continue;
              if (await frameIsBlack(cand)) continue;
              dataUrl = cand;
              S.captureKind = 'canvas';
              break;
            }
            if (!dataUrl) {
              canvasBroken = true;
              S.captureKind = 'tabs';
            }
          } else if (cv && (cv.reason === 'tainted' || cv.reason === 'no-canvas')) {
            canvasBroken = true;
            S.captureKind = 'tabs';
          }
        }
        if (!dataUrl) {
          if (!stealth) {
            setPanelOpacity(0);
            await sleep(90);
          }
          let shot;
          try {
            shot = await chrome.runtime.sendMessage({
              type: 'capture',
              rect: stealth ? captureRectWithoutPanel(st) : st.rect,
              viewport: st.viewport,
            });
          } finally {
            if (!stealth) setPanelOpacity(1);
          }
          if (!shot || !shot.ok) {
            throw new Error((shot && (shot.hint || shot.error)) || '截图失败');
          }
          S.authOk = true;
          dataUrl = shot.dataUrl;
        }
        images.push(dataUrl);
      }
    } finally {
      if (!stealth) await bridge('setPov', { heading: baseHeading, pitch: basePitch, zoom: st.zoom });
      S.progress = null;
    }
    return images;
  }

  // 没拿到 StreetViewPanorama 实例时的兜底：直接截当前整屏（不能转视角，也拿不到答案）
  async function captureViewportFallback() {
    S.progress = { i: 1, n: 1 };
    render();
    setPanelOpacity(0);
    await sleep(120);
    let shot;
    try {
      shot = await chrome.runtime.sendMessage({
        type: 'capture',
        rect: null,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      });
    } finally {
      setPanelOpacity(1);
      S.progress = null;
    }
    if (!shot || !shot.ok) throw new Error((shot && (shot.hint || shot.error)) || '截图失败');
    return [shot.dataUrl];
  }

  async function frameIsBlack(dataUrl) {
    try {
      const img = await loadImage(dataUrl);
      const cv = document.createElement('canvas');
      cv.width = 32;
      cv.height = 32;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0, 32, 32);
      const d = g.getImageData(0, 0, 32, 32).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      const avg = sum / ((d.length / 4) * 3);
      return avg < 10; // 0~255，<10 基本就是纯黑
    } catch (e) {
      return true;
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  async function makeThumbs(list) {
    const out = [];
    for (const url of list) {
      try {
        const img = await loadImage(url);
        const w = 200;
        const h = Math.max(1, Math.round((img.height / img.width) * w));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        out.push(cv.toDataURL('image/jpeg', 0.6));
      } catch (e) {
        /* 忽略单张失败 */
      }
    }
    return out;
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

  // 直接出答案：不调 AI，直接从街景对象读真实坐标（100% 准确，等于读游戏答案）
  async function directAnswer() {
    if (!S.enabled) {
      setNotice('已暂停：点右上角开关恢复后再用', true);
      return;
    }
    if (S.busy) return;
    const st = await bridge('state', {}, 3000);
    if (!st || !st.ok || !st.position) {
      setNotice('没拿到街景坐标：确认已经进入一局、街景已加载', true);
      return;
    }
    const lat = Number(st.position.lat);
    const lng = Number(st.position.lng);
    if (!isFinite(lat) || !isFinite(lng)) {
      setNotice('街景坐标无效', true);
      return;
    }
    const co = countryAt(lat, lng);
    const guess = {
      country: co ? co.z : '未知',
      countryEn: co ? co.n : '',
      countryCode: co ? co.i : '',
      region: '',
      lat,
      lng,
      confidence: 1,
      summary: '直接读取街景对象坐标（未使用 AI 猜测）',
      clues: [],
      alternatives: [],
      teaching: '',
    };
    S.busy = true;
    S.notice = '';
    S.timing = { capture: 0, first: 0, total: 0 };
    render();
    try {
      S.current = {
        panoId: st.panoId || 'direct-' + Date.now(),
        fallback: false,
        truth: { lat, lng },
        guess,
        reasoning: '',
        images: [],
        thumbnails: [],
        distanceKm: 0,
        aiScore: 5000,
        direct: true,
        settled: false,
        createdAt: Date.now(),
      };
      S.lastAnim = { guess, truth: { lat, lng } };
      setNotice('⚡ 直接答案：' + guess.country + ' ' + lat.toFixed(4) + ', ' + lng.toFixed(4));
      render();
      if (S.settings && S.settings.autoPin !== false) await placePin(true);
      if (S.mode !== 'battle' && (!S.settings || S.settings.autoSubmit !== false)) {
        setTimeout(() => autoSubmitRound(), 900);
      }
    } finally {
      S.busy = false;
      render();
    }
  }

  function answerAuto(imgs) {
    if (S.mode === 'direct' || (S.settings && S.settings.directAuto)) return directAnswer();
    return askAI(imgs);
  }

  async function askAI(preImages) {
    if (!S.enabled) {
      setNotice('已暂停：点右上角开关恢复后再用', true);
      return;
    }
    if (S.busy) return;
    if (!S.settings || !S.settings.apiKey) {
      S.tab = 'settings';
      render();
      setNotice('先填一下 DeepSeek API Key', true);
      return;
    }
    const st = await bridge('state', {}, 3000);
    const hasPano = !!(st && st.ok);
    S.busy = true;
    S.notice = '';
    S.timing = null;
    render();
    const tCapture0 = performance.now();
    try {
      let images;
      try {
        images = preImages && preImages.length
          ? preImages
          : hasPano
          ? await captureFrames(st)
          : await captureViewportFallback();
      } catch (e) {
        if (/授权|activeTab|permission/i.test(String((e && e.message) || e))) S.needAuth = true;
        throw e;
      }
      const captureMs = Math.round(performance.now() - tCapture0);
      S.timing = { capture: captureMs };
      const res = await chrome.runtime.sendMessage({ type: 'ask', images });
      if (!res || !res.ok) throw new Error((res && res.error) || 'AI 调用失败');
      S.timing.first = res.firstMs || null;
      S.timing.total = captureMs + (res.firstMs || 0);
      if (S.settings && S.settings.passiveCapture && S.collapsed) {
        S.collapsed = false;
      }
      const truth = hasPano ? await resolveTruth(st) : null;
      let distanceKm = null;
      let aiScore = null;
      if (truth && res.guess && res.guess.lat != null && res.guess.lng != null) {
        distanceKm = haversineKm(truth.lat, truth.lng, res.guess.lat, res.guess.lng);
        aiScore = scoreFor(distanceKm);
      }
      const thumbnails = await makeThumbs(images);
      S.current = {
        panoId: hasPano ? st.panoId : `viewport-${Date.now()}`,
        fallback: !hasPano,
        truth,
        guess: res.guess || {},
        reasoning: res.reasoning || '',
        images: images.slice(0, 6),
        thumbnails,
        distanceKm,
        aiScore,
        settled: false,
        createdAt: Date.now(),
      };
      S.lastAnim = { guess: S.current.guess, truth: S.current.truth };
      S.autoScore = null;
      S.lastReview = null;
      S.reviewPending = true;
      if (S.settings && S.settings.autoPin !== false) setTimeout(() => placePin(true), 30);
      if (S.mode === 'auto' && (!S.settings || S.settings.autoSubmit !== false)) {
        setTimeout(() => autoSubmitRound(), 1300);
      }
      S.notice = hasPano ? '' : '没检测到街景实例，已用「整屏截图」模式：无法自动转视角和取答案，结算时请手动填真实坐标。';
      // 第二段：线索库复核（不阻塞首屏）
      runMetaReview(S.current);
      S.noticeErr = false;
    } finally {
      S.busy = false;
      render();
    }
  }

  function setEnabled(on) {
    S.enabled = !!on;
    try { chrome.storage.local.set({ enabled: S.enabled }); } catch (e) {}
    if (!S.enabled) {
      S.autoLoop = false;
      clearTimeout(S.autoTimer);
      S.autoTimer = 0;
      stopPolling();
      try { closeMapModal(); } catch (e) {}
    } else {
      startPolling();
      refreshState();
    }
    S.notice = '';
    render();
  }

  function setMode(mode) {
    S.mode = mode === 'auto' ? 'auto' : mode === 'direct' ? 'direct' : 'battle';
    if (S.mode === 'battle') {
      S.autoLoop = false;
      clearTimeout(S.autoTimer);
    }
    try { chrome.storage.local.set({ uiMode: S.mode }); } catch (e) {}
    render();
  }

  function toggleAutoLoop() {
    if (!S.enabled) {
      setNotice('已暂停：点右上角开关恢复后再跑全自动', true);
      return;
    }
    if (S.mode === 'battle') setMode('auto');
    S.autoLoop = !S.autoLoop;
    if (S.autoLoop) {
      if (!S.current || S.current.settled) answerAuto();
      else scheduleAutoNext(300);
    } else {
      clearTimeout(S.autoTimer);
      S.autoTimer = 0;
    }
    render();
  }

  function scheduleAutoNext(delay) {
    clearTimeout(S.autoTimer);
    S.autoTimer = setTimeout(() => {
      if (!S.enabled || !S.autoLoop || S.mode !== 'auto' || S.busy) return;
      if (!S.lastState || !S.lastState.ok) return;
      answerAuto();
    }, delay || 1500);
  }

  function gameButtonByText(re) {
    const nodes = document.querySelectorAll('button, [role="button"], .ant-btn, div[class*="btn"], div[class*="Btn"]');
    for (const el of nodes) {
      const t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (!t || t.length > 8) continue;
      if (!re.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      return el;
    }
    return null;
  }

  async function autoSubmitRound() {
    if (!S.enabled || (S.mode !== 'auto' && S.mode !== 'direct') || !S.current || S.current.settled) return;
    const cur = S.current;
    if (S.settings && S.settings.humanize) {
      const wait = 2500 + Math.random() * 6500; // 2.5~9 秒随机，避免机械固定节奏
      await sleep(wait);
      if ((S.mode !== 'auto' && S.mode !== 'direct') || S.current !== cur || cur.settled) return;
    }
    const confirm = gameButtonByText(/^(确认|确认位置|确认选择|提交|提交答案|确定|选择位置|确定位置)$/);
    if (!confirm) {
      S.pinStatus = '没找到图寻的「确认」按钮，请手动点一下';
      render();
      return;
    }
    try {
      confirm.click();
    } catch (e) {}
    S.pinStatus = '已自动提交本回合';
    const truth = cur.truth || {};
    const rec = {
      idx: S.battle.rounds.length + 1,
      panoId: cur.panoId,
      truthLat: truth.lat != null ? truth.lat : null,
      truthLng: truth.lng != null ? truth.lng : null,
      aiCountry: cur.guess.country || '',
      aiRegion: cur.guess.region || '',
      aiLat: cur.guess.lat != null ? cur.guess.lat : null,
      aiLng: cur.guess.lng != null ? cur.guess.lng : null,
      distanceKm: cur.distanceKm,
      aiScore: cur.aiScore,
      playerScore: null,
      auto: true,
      settledAt: Date.now(),
    };
    S.battle.rounds.push(rec);
    cur.settled = true;
    await persistBattle();
    render();
    if (S.autoLoop) scheduleAutoNext(1800);
  }

  async function placePin(auto) {
    if (!S.enabled) return false;
    const cur = S.current;
    if (!cur || !cur.guess || cur.guess.lat == null || cur.guess.lng == null) {
      if (!auto) setNotice('还没有可用的坐标，先让 AI 猜一次', true);
      return false;
    }
    const res = await bridge('place-guess', { lat: cur.guess.lat, lng: cur.guess.lng }, 8000);
    if (res && res.ok) {
      S.pinStatus = res.moved ? '已把地图移到 AI 位置并打点' : '已在图上打点';
      if (!auto) setNotice('📍 ' + S.pinStatus + '（检查没问题就点图寻的确认）');
      render();
      return true;
    }
    S.pinStatus = '没找到图寻的猜点地图';
    if (!auto) setNotice('没找到图寻的猜点地图：确认已经进入一局游戏、且地图已展开', true);
    render();
    return false;
  }

  async function runMetaReview(cur) {
    if (!cur || !cur.guess) return;
    if (S.settings && S.settings.metaReview === false) {
      S.reviewPending = false;
      render();
      return;
    }
    const t0 = performance.now();
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'meta-review',
        guess: cur.guess,
        image: (cur.images || [])[0] || null,
      });
      if (S.current !== cur) return;
      if (res && res.ok && res.review) {
        cur.guess.review = res.review;
        if (res.review.verdict === 'adjust' && res.review.lat != null && res.review.lng != null) {
          if (res.review.country) cur.guess.country = res.review.country;
          if (res.review.countryCode) cur.guess.countryCode = res.review.countryCode;
          if (res.review.region) cur.guess.region = res.review.region;
          cur.guess.lat = res.review.lat;
          cur.guess.lng = res.review.lng;
          if (res.review.confidence != null) cur.guess.confidence = res.review.confidence;
          cur.guess.metaAdjusted = true;
          if (S.settings && S.settings.autoPin !== false) setTimeout(() => placePin(true), 30);
          if (cur.truth) {
            cur.distanceKm = haversineKm(cur.truth.lat, cur.truth.lng, cur.guess.lat, cur.guess.lng);
            cur.aiScore = scoreFor(cur.distanceKm);
          }
        }
        if (S.timing) S.timing.review = Math.round(performance.now() - t0);
      }
    } catch (e) {
      console.warn('[图寻AI] 线索库复核失败', e);
    } finally {
      if (S.current === cur) {
        S.reviewPending = false;
        render();
      }
    }
  }

  function parseLatLng(text) {
    if (!text) return null;
    const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }

  function numOf(...vals) {
    for (const v of vals) {
      const n = Number(v);
      if (v != null && v !== '' && isFinite(n)) return n;
    }
    return null;
  }

  // 在任意 JSON 里找“和当前 panoId 关联的 lat/lng”
  function scanForTruth(obj, panoId, depth) {
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    if (Array.isArray(obj)) {
      for (const v of obj) {
        const r = scanForTruth(v, panoId, depth + 1);
        if (r) return r;
      }
      return null;
    }
    const pid = obj.panoId != null ? obj.panoId : obj.pano != null ? obj.pano : obj.panoramaId;
    if (pid != null && String(pid) === String(panoId)) {
      const lat = numOf(obj.lat, obj.latitude);
      const lng = numOf(obj.lng, obj.lon, obj.longitude);
      if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const r = scanForTruth(v, panoId, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  async function truthFromWs(panoId) {
    const res = await bridge('ws', {}, 2500);
    const msgs = (res && res.messages) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const raw = msgs[i] && msgs[i].data;
      if (!raw || raw === '[binary]') continue;
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      const hit = scanForTruth(obj, panoId, 0);
      if (hit) return hit;
    }
    return null;
  }

  async function truthFromApi(panoId) {
    const eps = ['getPanoInfo', 'getTuxunPanoInfo', 'getQQPanoInfo'];
    for (const ep of eps) {
      try {
        const r = await fetch(`/api/v0/tuxun/mapProxy/${ep}?pano=${encodeURIComponent(panoId)}`, {
          credentials: 'include',
        });
        const j = await r.json();
        const d = j && j.data;
        if (d && d.lat != null && d.lng != null) {
          return { lat: Number(d.lat), lng: Number(d.lng) };
        }
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  async function resolveTruth(st) {
    if (st && st.position && st.position.lat != null) return st.position;
    const panoId = st && st.panoId;
    if (!panoId) return null;
    const ws = await truthFromWs(panoId);
    if (ws) return ws;
    const api = await truthFromApi(panoId);
    if (api) return api;
    return null;
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function scoreFor(distanceKm) {
    const size = Number(S.settings && S.settings.mapSizeKm) || 14916.862;
    if (distanceKm == null || !isFinite(distanceKm)) return 0;
    return Math.round(5000 * Math.exp((-10 * distanceKm) / size));
  }

  async function settle() {
    const cur = S.current;
    if (!cur) return;
    const input = shadow.getElementById('tx-score');
    let val = input ? Number(input.value) : NaN;
    if (!isFinite(val) && S.autoScore != null) val = S.autoScore;
    if (!isFinite(val)) {
      setNotice('先填一下你这一回合在图寻拿到的分数', true);
      return;
    }
    val = clamp(Math.round(val), 0, 5000);

    let truth = cur.truth || null;
    if (!truth) {
      const tEl = shadow.getElementById('tx-truth');
      const parsed = tEl ? parseLatLng(tEl.value) : null;
      if (parsed) truth = parsed;
    }
    truth = truth || {};
    let distanceKm = cur.distanceKm;
    let aiScore = cur.aiScore;
    const guess0 = cur.guess || {};
    if (truth.lat != null && truth.lng != null && guess0.lat != null && guess0.lng != null) {
      distanceKm = haversineKm(truth.lat, truth.lng, guess0.lat, guess0.lng);
      aiScore = scoreFor(distanceKm);
    }
    const guess = cur.guess || {};
    const record = {
      idx: S.battle.rounds.length + 1,
      panoId: cur.panoId,
      truthLat: truth.lat != null ? truth.lat : null,
      truthLng: truth.lng != null ? truth.lng : null,
      aiCountry: guess.country || '',
      aiRegion: guess.region || '',
      aiLat: guess.lat != null ? guess.lat : null,
      aiLng: guess.lng != null ? guess.lng : null,
      distanceKm,
      aiScore,
      playerScore: val,
      settledAt: Date.now(),
    };
    S.battle.rounds.push(record);
    S.lastAnim = { guess: cur.guess || {}, truth: truth.lat != null ? truth : null };
    S.lastReview = null;
    S.current = null;
    S.autoScore = null;
    S.notice = '';
    await persistBattle();
    render();
  }

  async function autoScore() {
    const res = await bridge('ws', {}, 2500);
    const msgs = (res && res.messages) || [];
    const candidate = guessScoreFromWs(msgs);
    if (candidate == null) {
      setNotice('没能从对局数据里自动认出得分，直接手动填一下吧', true);
      return;
    }
    S.autoScore = candidate;
    render();
    const input = shadow.getElementById('tx-score');
    if (input) input.value = String(candidate);
  }

  function guessScoreFromWs(msgs) {
    // 尽力而为：从最近的 websocket 消息里找 0~5000 的分数型字段
    const keys = /(score|point|pts|gain|roundscore|getScore)/i;
    let found = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const raw = msgs[i] && msgs[i].data;
      if (!raw || raw === '[binary]') continue;
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      const walk = (o, depth) => {
        if (!o || depth > 6 || found != null) return;
        if (Array.isArray(o)) return o.forEach((v) => walk(v, depth + 1));
        if (typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (keys.test(k) && typeof v === 'number' && v >= 0 && v <= 5000) {
            found = Math.round(v);
            return;
          }
          if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(obj, 0);
      if (found != null) break;
    }
    return found;
  }

  async function review() {
    const last = S.battle.rounds[S.battle.rounds.length - 1];
    const images = (S.current && S.current.images) || [];
    if (!last) return;
    S.busy = true;
    render();
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'review',
        images,
        truth: [last.aiCountry, last.aiRegion].filter(Boolean).join(' · ') || '未知',
        truthLat: last.truthLat,
        truthLng: last.truthLng,
        guess: [last.aiCountry, last.aiRegion].filter(Boolean).join(' · '),
        guessLat: last.aiLat,
        guessLng: last.aiLng,
        distanceKm: last.distanceKm != null ? Math.round(last.distanceKm) : '?',
      });
      if (!res || !res.ok) throw new Error((res && res.error) || '复盘失败');
      S.lastReview = res.text;
    } finally {
      S.busy = false;
      render();
    }
  }

  async function saveSettings(silent) {
    const keyEl = shadow.getElementById('tx-key');
    const modelEl = shadow.getElementById('tx-model');
    const framesEl = shadow.getElementById('tx-frames');
    const roundsEl = shadow.getElementById('tx-rounds');
    const settleEl = shadow.getElementById('tx-settle');
    const metaEl = shadow.getElementById('tx-meta');
    const effortEl = shadow.getElementById('tx-effort');
    const maxtokEl = shadow.getElementById('tx-maxtok');
    const patch = { model: DEFAULTS.model, frames: DEFAULTS.frames, settleMs: DEFAULTS.settleMs };
    if (modelEl) patch.model = modelEl.value;
    if (framesEl) patch.frames = Number(framesEl.value);
    if (settleEl) patch.settleMs = Number(settleEl.value);
    if (metaEl) patch.metaReview = metaEl.value === '1';
    const autoPinEl = shadow.getElementById('tx-autopin');
    if (autoPinEl) patch.autoPin = autoPinEl.value === '1';
    const deepEl = shadow.getElementById('tx-deep');
    const capEl = shadow.getElementById('tx-capture');
    if (capEl) patch.captureMode = capEl.value === 'tabs' ? 'tabs' : 'auto';
    const stealthEl = shadow.getElementById('tx-stealth');
    if (stealthEl) patch.stealth = stealthEl.value === '1';
    const humEl = shadow.getElementById('tx-humanize');
    if (humEl) patch.humanize = humEl.value === '1';
    const pasEl = shadow.getElementById('tx-passive');
    if (pasEl) patch.passiveCapture = pasEl.value === '1';
    const hideTruthEl = shadow.getElementById('tx-hidetruth');
    if (hideTruthEl) patch.hideTruth = hideTruthEl.value === '1';
    const dirEl = shadow.getElementById('tx-direct');
    if (dirEl) patch.directAuto = dirEl.value === '1';
    const acEl = shadow.getElementById('tx-autocollapse');
    if (acEl) patch.autoCollapse = acEl.value === '1';
    if (deepEl) {
      patch.deep = deepEl.value === '1';
      if (patch.deep) bridge('deep-on', {}, 3000);
      else bridge('hook-off', {}, 3000);
    }
    const autoSubmitEl = shadow.getElementById('tx-autosubmit');
    if (autoSubmitEl) patch.autoSubmit = autoSubmitEl.value === '1';
    const autoNextEl = shadow.getElementById('tx-autonext');
    if (autoNextEl) patch.autoNext = autoNextEl.value === '1';
    const profileEl = shadow.getElementById('tx-profile');
    const profileChanged = !!(profileEl && profileEl.value && profileEl.value !== (S.settings && S.settings.profile));
    if (profileChanged) {
      patch.profile = profileEl.value;
      Object.assign(patch, PROFILE_PRESETS[profileEl.value] || {});
    }
    if (effortEl) patch.effort = effortEl.value || '';
    if (maxtokEl) patch.maxTokens = Number(maxtokEl.value) || DEFAULTS.maxTokens;
    if (keyEl && keyEl.value.trim()) patch.apiKey = keyEl.value.trim();
    const next = Object.assign({}, S.settings, patch);
    await chrome.storage.local.set({ settings: next });
    S.settings = next;
    if (roundsEl && Number(roundsEl.value)) {
      S.battle.target = Number(roundsEl.value);
      await persistBattle();
    }
    if (!silent) {
      setNotice('设置已保存');
      render();
    } else if (profileChanged) {
      // 换速度档位会联动改帧数/token，立刻重绘让下拉同步
      render();
    }
  }

  async function testKey() {
    const keyEl = shadow.getElementById('tx-key');
    if (keyEl && keyEl.value.trim()) {
      const next = Object.assign({}, S.settings, { apiKey: keyEl.value.trim() });
      await chrome.storage.local.set({ settings: next });
      S.settings = next;
    }
    const res = await chrome.runtime.sendMessage({ type: 'test-key' });
    if (!res || !res.ok) throw new Error((res && res.error) || '测试失败');
    setNotice('Key 可用：' + String(res.text || '').trim());
  }

  async function persistBattle() {
    await chrome.storage.local.set({
      battle: { target: S.battle.target, rounds: S.battle.rounds, savedAt: Date.now() },
    });
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  }

  async function loadAll() {
    // 设置直接从 storage 读，不依赖后台 Service Worker 是否已唤醒
    let raw = null;
    try {
      const store = await chrome.storage.local.get(['settings', 'battle', 'uiMode', 'enabled']);
      if (store.enabled === false) S.enabled = false;
      raw = store.settings;
      if (store.uiMode === 'auto' || store.uiMode === 'battle' || store.uiMode === 'direct') S.mode = store.uiMode;
      const battle = store.battle;
      if (battle && Array.isArray(battle.rounds)) {
        S.battle.rounds = battle.rounds;
        S.battle.target = Number(battle.target) || 20;
      }
    } catch (e) {
      console.warn('[图寻AI] 读取本地设置失败', e);
    }
    S.settings = Object.assign({}, DEFAULTS, raw || {});
    if (!raw) {
      // 首次使用：把默认值写进去（含预填的 Key）
      try {
        await chrome.storage.local.set({ settings: S.settings });
      } catch (e) {
        /* ignore */
      }
    }
    if (!S.battle.target) S.battle.target = Number(S.settings.rounds) || 20;
    if (!S.settings.apiKey) S.tab = 'settings';
    if (S.settings.deep) bridge('deep-on', {}, 3000);
  }

  function settingsMasked() {
    const s = Object.assign({}, S.settings || {});
    s.hasKey = !!s.apiKey;
    s.apiKeyMasked = s.apiKey ? `${s.apiKey.slice(0, 6)}…${s.apiKey.slice(-4)}` : '';
    return s;
  }

  /* ------------------------------ 启动 ------------------------------ */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle-panel') {
      host.style.display = host.style.display === 'none' ? '' : 'none';
      if (host.style.display !== 'none') refreshState();
    }
    if (msg && msg.type === 'action-clicked') {
      // 用户点了工具栏图标 = 截图权限（activeTab）已授予
      host.style.display = '';
      S.needAuth = false;
      S.authOk = true;
      setNotice('✅ 截图权限已激活（本次页面有效），可以点「让 DeepSeek 看图猜位置」了');
      refreshState();
    }
  });

  // 演示数据：?txai-demo=1 时注入一份罗马尼亚示例，方便截图/验收
  function initDemo() {
    if (!/[?&]txai-demo=1/.test(location.search) || S.current) return;
    const guess = {
      country: '罗马尼亚',
      countryEn: 'Romania',
      countryCode: 'RO',
      continent: 'Europe',
      region: '特兰西瓦尼亚 · 布拉索夫',
      lat: 45.65,
      lng: 25.6,
      confidence: 0.82,
      summary: '罗马尼亚中部、布拉索夫附近的喀尔巴阡山前丘陵',
      steps: [
        { level: 'hemisphere', conclusion: '北半球、东半球', evidence: '路牌是拉丁字母、温带阔叶林、正午太阳偏南' },
        { level: 'continent', conclusion: '欧洲', evidence: '白底红圈限速牌、欧式斑马线、红瓦尖顶、车牌左侧蓝色条' },
        { level: 'country', conclusion: '罗马尼亚', evidence: '车牌上的 RO 标识、蓝底白字地名牌、东欧风格教堂尖顶' },
        { level: 'place', conclusion: '布拉索夫附近的喀尔巴阡山前丘陵', evidence: '远处喀尔巴阡山轮廓、红瓦屋顶密集、道路两侧排水沟' },
      ],
      clues: [
        { kind: '路牌', see: '白底红圈限速牌 + 蓝底白字地名牌', why: '典型中东欧道路标识体系' },
        { kind: '植被', see: '温带阔叶林与草地', why: '中欧/东欧气候带' },
      ],
      teaching: '先用车牌国家码锁定国家，再看地形和建筑确认区域。',
      review: {
        verdict: 'agree',
        country: '罗马尼亚',
        countryCode: 'RO',
        region: '布拉索夫',
        confidence: 0.88,
        matched: ['白色长车牌 + 左侧蓝条', '细白路桩带红条', '红瓦尖顶与东欧教堂'],
        mismatched: [],
        reason: '车牌、路桩、建筑三处都与罗马尼亚线索库吻合，坐标保持布拉索夫附近。',
        sourceCountry: '罗马尼亚',
      },
      alternatives: [{ place: '保加利亚', reason: '同样有东欧路牌风格', weight: 0.15 }],
    };
    S.current = {
      panoId: 'DEMO-ROMANIA',
      fallback: false,
      truth: { lat: 45.6427, lng: 25.5887 },
      guess,
      reasoning: '',
      images: [],
      thumbnails: [],
      distanceKm: 1,
      aiScore: 5000,
      settled: false,
      createdAt: Date.now(),
    };
    S.lastAnim = { guess, truth: S.current.truth };
  }

  function startPolling() {
    if (S.refreshTimer) return;
    S.refreshTimer = setInterval(() => {
      if (!S.enabled) return;
      refreshState();
    }, 450);
  }

  function stopPolling() {
    if (S.refreshTimer) {
      clearInterval(S.refreshTimer);
      S.refreshTimer = 0;
    }
  }

  (async () => {
    initDemo();
    render(); // 先把悬浮窗画出来，避免后台启动慢时空白
    try {
      await loadAll();
    } catch (e) {
      console.warn('[图寻AI] 初始化失败', e);
    }
    render();
    if (S.enabled) {
      refreshState();
      startPolling();
    }
  })();

  // 暴露给控制台调试
  window.__TXAI_UI_STATE__ = S;
})();
