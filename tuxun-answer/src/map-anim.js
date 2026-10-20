/**
 * 图寻 AI 助手 —— 分步排除定位地图
 *
 * 核心：直接用「图寻官方地图同源的瓦片」（华为云 ROADMAP，中文注记、道路、地形）
 * 渲染一张真正的 Web Mercator 地图，而不是一张粗糙的世界轮廓示意图。
 *
 * 特点：
 *  - 实时按当前视野拉瓦片，瓦片缓存数量有上限，关闭弹层立刻清空；
 *  - 每一步的镜头、高亮、证据文字都由 AI 本次回答实时生成，不是录好的死动画；
 *  - 支持拖动平移、滚轮缩放、上/下一步、暂停自动、重播；
 *  - 瓦片不可用时自动退回内置的矢量世界地图（离线兜底）。
 *
 * 用法：
 *   const anim = window.__TX_MAP_ANIM__.create(canvas, { onStep });
 *   anim.play(steps);
 */
(() => {
  'use strict';
  if (window.__TX_MAP_ANIM__) return;

  const WORLD = window.__TX_WORLD__ || { countries: [] };
  const COUNTRIES = WORLD.countries || [];

  const TILE = 256;
  const MAX_TILE_WEIGHT = 96; // 瓦片缓存权重上限（scale=2 的瓦片算 4）
  const RETRY_AFTER = 8000;  // 失败的瓦片 15 秒内不重试
  const requested = new Map(); // 最近请求过的瓦片，防止反复秒回请求
  const ZOOM_MIN = 1.2;
  const ZOOM_MAX = 13.5;

  // 图寻前端 bundle 内嵌的公共瓦片地址（华为云地图，中文注记）
  const TILE_KEY =
    'DAEDANitav6P7Q0lWzCzKkLErbrJG4kS1u%2FCpEe5ZyxW5u0nSkb40bJ%2BYAugRN03fhf0BszLS1rCrzAogRHDZkxaMrloaHPQGO6LNg==';
  const TILE_URL = (z, x, y, ts) =>
    `https://maprastertile-drcn.dbankcdn.cn/display-service/v1/online-render/getTile/26.02.03.16/${z}/${x}/${y}/` +
    `?language=zh&p=46&scale=${ts || 1}&mapType=ROADMAP&presetStyleId=standard&pattern=JPG&key=${TILE_KEY}`;

  // 页面里图寻自己的地图会加载同源瓦片：直接沿用它当前的地址（key/版本变了也能跟上）
  let liveTemplate = null;
  let liveChecked = false;
  let optsRef = null;
  function findLiveTemplate() {
    if (liveChecked) return liveTemplate;
    liveChecked = true;
    try {
      const list = performance.getEntriesByType('resource');
      for (const e of list) {
        const u = (e && e.name) || '';
        if (u.indexOf('getTile') < 0) continue;
        const m = /^(https?:\/\/[^?#]+?\/)(\d+)\/(\d+)\/(\d+)(\/\?.*)$/.exec(u);
        if (!m) continue;
        if (!/scale=/.test(m[5])) continue;
        liveTemplate = { base: m[1], q: m[5] };
        break;
      }
    } catch (e) {}
    return liveTemplate;
  }
  function tileUrlFor(z, x, y, ts) {
    const t = findLiveTemplate();
    if (t) {
      const q = t.q.replace(/([?&]scale=)\d+/, '$1' + (ts || 1));
      return t.base + z + '/' + x + '/' + y + q;
    }
    return TILE_URL(z, x, y, ts);
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const mercY = (lat) => {
    const l = clamp(lat, -85.05112878, 85.05112878) * (Math.PI / 180);
    return (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2;
  };
  const invMercY = (y) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));

  /* ---------------- 国家数据（高亮用） ---------------- */
  const CONTINENTS = {};
  for (const c of COUNTRIES) (CONTINENTS[c.c] = CONTINENTS[c.c] || []).push(c);

  function findCountry(key) {
    if (!key) return null;
    const k = String(key).toLowerCase();
    return (
      COUNTRIES.find((c) => c.i && c.i.toLowerCase() === k) ||
      COUNTRIES.find((c) => c.z === key) ||
      COUNTRIES.find((c) => c.n && c.n.toLowerCase() === k) ||
      null
    );
  }

  function continentKey(name) {
    if (!name) return null;
    const k = String(name).toLowerCase();
    return Object.keys(CONTINENTS).find((c) => c.toLowerCase() === k) || null;
  }

  const CONTINENT_BBOX = {
    Europe: [-24, 34, 45, 71],
    Asia: [26, -11, 146, 55],
    Africa: [-19, -35, 52, 37],
    'North America': [-168, 6, -52, 73],
    'South America': [-82, -56, -34, 13],
    Oceania: [110, -48, 179, 0],
    Antarctica: [-180, -90, 180, -60],
  };

  const CONTINENT_ZH = {
    Asia: '亚洲',
    Europe: '欧洲',
    Africa: '非洲',
    'North America': '北美洲',
    'South America': '南美洲',
    Oceania: '大洋洲',
    Antarctica: '南极洲',
  };
  const ZH_TO_CONTINENT = Object.fromEntries(Object.entries(CONTINENT_ZH).map(([en, zh]) => [zh, en]));

  function viewForContinent(name) {
    const key = continentKey(name);
    if (!key) return null;
    const b = CONTINENT_BBOX[key];
    if (b) {
      return { lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2, spanLon: b[2] - b[0], spanLat: b[3] - b[1] };
    }
    return null;
  }

  /* ---------------- 瓦片缓存（全局共享一份） ---------------- */
  const TILE_STATS = { ok: 0, err: 0, req: 0, lastErr: '', skip: {}, lastDraw: null };
  window.__TX_TILE_STATS__ = TILE_STATS;
  window.__TX_TILE_INFLIGHT__ = () => inFlight;
  const tileCache = new Map();
  let tileWeight = 0;
  let inFlight = 0;
  let tileFailStreak = 0;
  let tileOkCount = 0;
  const requestQueue = [];
  let queueTimer = 0;
  const QUEUE_INTERVAL = 75; // 顺序、间隔请求瓦片，避免被服务端限流

  function trimTiles() {
    while (tileWeight > MAX_TILE_WEIGHT && tileCache.size > 6) {
      // 优先淘汰已经加载完的旧瓦片，正在加载的不动（否则会自己取消请求、还会被记成失败）
      let evictKey = null;
      for (const [k, r] of tileCache) {
        if (r && !r.loading) {
          evictKey = k;
          break;
        }
      }
      if (!evictKey) break;
      const rec = tileCache.get(evictKey);
      tileCache.delete(evictKey);
      tileWeight -= rec && rec.w ? rec.w : 1;
      if (rec && rec.img) {
        try {
          rec.img.src = '';
        } catch (e) {}
      }
    }
  }


  function pumpQueue() {
    queueTimer = 0;
    if (!requestQueue.length) return;
    const job = requestQueue.shift();
    startTileRequest(job);
    queueTimer = setTimeout(pumpQueue, QUEUE_INTERVAL);
  }

  function getTile(z, x, y, ts, onLoad) {
    const n = 1 << z;
    const wrappedX = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    const key = `${ts}/${z}/${wrappedX}/${y}`;
    const hit = tileCache.get(key);
    if (hit) {
      if (hit.err && Date.now() - (hit.ts || 0) < 20000) return hit;
      tileCache.delete(key);
      tileCache.set(key, hit);
      return hit;
    }
    const prevReq = requested.get(key);
    if (prevReq) {
      if (prevReq.err && Date.now() - prevReq.t < RETRY_AFTER) return null;
      if (!prevReq.err) return null; // 已在队列里
    }
    requested.set(key, { t: Date.now(), err: false });
    if (requested.size > 500) {
      const first = requested.keys().next().value;
      requested.delete(first);
    }
    requestQueue.push({ z, x: wrappedX, y, ts, key, onLoad });
    if (requestQueue.length > 240) requestQueue.length = 240;
    if (!queueTimer) queueTimer = setTimeout(pumpQueue, 0);
    return null;
  }

  function startTileRequest(job) {
    const rec = { ok: false, err: false, loading: true, img: null, ts: Date.now(), w: job.ts === 2 ? 4 : 1 };
    tileCache.set(job.key, rec);
    tileWeight += rec.w;
    trimTiles();
    TILE_STATS.req += 1;
    inFlight += 1;

    const img = new Image();
    img.decoding = 'async';
    const watchdog = setTimeout(() => {
      if (!rec.loading) return;
      rec.loading = false;
      rec.err = true;
      inFlight = Math.max(0, inFlight - 1);
      try {
        img.src = '';
      } catch (e) {}
      scheduleRedraw();
    }, 6000);

    img.onload = () => {
      clearTimeout(watchdog);
      rec.ok = true;
      rec.img = img;
      rec.ts = Date.now();
      rec.loading = false;
      inFlight = Math.max(0, inFlight - 1);
      tileOkCount += 1;
      tileFailStreak = 0;
      TILE_STATS.ok += 1;
      job.onLoad && job.onLoad();
    };

    img.onerror = () => {
      clearTimeout(watchdog);
      rec.err = true;
      rec.loading = false;
      rec.ts = Date.now();
      inFlight = Math.max(0, inFlight - 1);
      tileFailStreak += 1;
      TILE_STATS.err += 1;
      if (tileFailStreak >= 5 && tileOkCount === 0 && !TILE_STATS.failNotified && optsRef && optsRef.onTileFail) {
        TILE_STATS.failNotified = true;
        try {
          optsRef.onTileFail();
        } catch (e) {}
      }
      TILE_STATS.lastErr = tileUrlFor(job.z, job.x, job.y, job.ts);
      requested.set(job.key, { t: Date.now(), err: true });
      job.onLoad && job.onLoad();
    };

    img.src = tileUrlFor(job.z, job.x, job.y, job.ts);
  }

  /* ---------------- 静态小地图（答案卡片） ---------------- */
  const miniTiles = new Map();

  function zoomForPoint(lat, lng) {
    let best = null;
    for (const c of COUNTRIES) {
      const b = c.mb || c.b;
      if (!b) continue;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      if (!best || area < best.area) best = { b, area };
    }
    if (!best) return 5;
    const span = Math.max(best.b[2] - best.b[0], best.b[3] - best.b[1]);
    if (span < 1.5) return 8;
    if (span < 3) return 7;
    if (span < 6) return 7;
    if (span < 12) return 6;
    if (span < 25) return 5;
    return 4;
  }
  function renderStatic(canvas, opt) {
    if (!canvas) return;
    const lat = Number(opt && opt.lat);
    const lng = Number(opt && opt.lng);
    if (!isFinite(lat) || !isFinite(lng)) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.max(120, canvas.clientWidth || 360);
    const cssH = Math.max(70, canvas.clientHeight || 140);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    } catch (e) {}
    ctx.fillStyle = '#0a1424';
    ctx.fillRect(0, 0, cssW, cssH);
    const zoom = Math.round(clamp(Number(opt && opt.zoom) || zoomForPoint(lat, lng), 1, 9));
    const worldPx = TILE * Math.pow(2, zoom);
    const px = ((lng + 180) / 360) * worldPx;
    const py = mercY(lat) * worldPx;
    const offX = cssW / 2 - px;
    const offY = cssH / 2 - py;

    // 离线轮廓兜底
    ctx.fillStyle = '#132a44';
    ctx.strokeStyle = '#3d6ea8';
    ctx.lineWidth = 0.8;
    for (const c of COUNTRIES) {
      const rings = c.r || [];
      for (const ring of rings) {
        if (!ring || ring.length < 6) continue;
        ctx.beginPath();
        for (let i = 0; i < ring.length; i += 2) {
          const X = ((ring[i] + 180) / 360) * worldPx + offX;
          const Y = mercY(ring[i + 1]) * worldPx + offY;
          if (i === 0) ctx.moveTo(X, Y);
          else ctx.lineTo(X, Y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // 瓦片（和分步动画同一套动态地址）
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    const todraw = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const X = tx + dx, Y = ty + dy;
        const key = zoom + '/' + X + '/' + Y;
        const rec = miniTiles.get(key);
        if (rec && rec.img && rec.ok) {
          todraw.push({ img: rec.img, x: X, y: Y });
          continue;
        }
        if (rec && rec.loading) continue;
        if (rec && rec.err && Date.now() - rec.ts < 20000) continue;
        const item = { loading: true, ok: false, err: false, img: null, ts: Date.now() };
        miniTiles.set(key, item);
        const img = new Image();
        img.onload = () => {
          item.ok = true;
          item.loading = false;
          item.img = img;
          drawStaticTiles(canvas, opt);
        };
        img.onerror = () => {
          item.err = true;
          item.loading = false;
          item.ts = Date.now();
        };
        img.src = tileUrlFor(zoom, X, Y, 2);
      }
    }
    for (const d of todraw) {
      try {
        ctx.drawImage(d.img, (d.x * TILE + offX), (d.y * TILE + offY), TILE, TILE);
      } catch (e) {}
    }

    // 标记点
    const cx = cssW / 2;
    const cy = cssH / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4d4f33';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4d4f';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  function drawStaticTiles(canvas, opt) {
    renderStatic(canvas, opt || {});
  }

  /* ---------------- 地图实例 ---------------- */
  function create(canvas, opts) {
    opts = opts || {};
    optsRef = opts;
    liveChecked = false;
    liveTemplate = null;
    TILE_STATS.failNotified = false;
    const ctx = canvas.getContext('2d');
    let W = 0;
    let H = 0;
    let dpr = 1;

    const state = {
      steps: [],
      index: -1,
      cam: { lon: 0, lat: 20, zoom: 1.4 },
      from: null,
      to: null,
      t0: 0,
      dur: 950,
      phase: 'idle',
      holdTimer: 0,
      raf: 0,
      auto: true,
      destroyed: false,
      mode: 'tiles', // tiles | vector
    };

    function resize(force) {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(120, Math.round(rect.width || 560));
      const h = Math.max(80, Math.round(rect.height || 300));
      const nd = Math.min(2, window.devicePixelRatio || 1);
      if (!force && w === W && h === H && nd === dpr) return;
      W = w;
      H = h;
      dpr = nd;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }

    /* ---- 相机与投影 ---- */
    const worldPx = (zoom) => TILE * Math.pow(2, zoom);

    function project(lat, lng) {
      const c = state.cam;
      const wp = worldPx(c.zoom);
      let x = ((lng + 180) / 360) * wp;
      const y = mercY(lat) * wp;
      const cx = ((c.lon + 180) / 360) * wp;
      const cy = mercY(c.lat) * wp;
      const dx = x - cx;
      if (dx > wp / 2) x -= wp;
      else if (dx < -wp / 2) x += wp;
      return { x: W / 2 + (x - cx), y: H / 2 + (y - cy) };
    }

    function zoomForView(v) {
      const spanLon = Math.max(0.05, Number(v.spanLon) || 360);
      const spanLat = Math.max(0.05, Number(v.spanLat) || 180);
      const zLon = Math.log2((360 * W) / (spanLon * TILE));
      const f = Math.abs(mercY(v.lat - spanLat / 2) - mercY(v.lat + spanLat / 2));
      const zLat = Math.log2(H / (Math.max(1e-6, f) * TILE));
      return clamp(Math.min(zLon, zLat), ZOOM_MIN, ZOOM_MAX);
    }

    function targetFromStep(step) {
      if (step.view && step.view.spanLon) {
        return { lon: step.view.lon, lat: clamp(step.view.lat, -80, 80), zoom: zoomForView(step.view) };
      }
      if (step.bbox) {
        const b = step.bbox;
        const mid = { lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 };
        return {
          lon: mid.lon,
          lat: mid.lat,
          zoom: zoomForView({ ...mid, spanLon: Math.max(0.4, b[2] - b[0]), spanLat: Math.max(0.3, b[3] - b[1]) }),
        };
      }
      if (step.focus) {
        const s = step.focus.span || 6;
        return { lon: step.focus.lon, lat: step.focus.lat, zoom: zoomForView({ lon: step.focus.lon, lat: step.focus.lat, spanLon: s, spanLat: s * 0.62 }) };
      }
      return { lon: 0, lat: 20, zoom: 1.4 };
    }

    /* ---- 绘制 ---- */
    function drawTiles() {
      const c = state.cam;
      const z = clamp(Math.round(c.zoom), 1, 14);
      const scale = Math.pow(2, c.zoom - z);
      const wp = TILE * Math.pow(2, z) * scale;
      const cx = ((c.lon + 180) / 360) * wp;
      const cy = mercY(c.lat) * wp;
      const tilePx = TILE * scale;
      const maxTile = 1 << z;

      const margin = state.cam.zoom >= 5 ? 0 : 1;
      const x0 = Math.floor((cx - W / 2) / tilePx) - margin;
      const x1 = Math.floor((cx + W / 2) / tilePx) + margin;
      const y0 = Math.floor((cy - H / 2) / tilePx) - margin;
      const y1 = Math.floor((cy + H / 2) / tilePx) + margin;

      // 放大到 scale=2 的高清瓦片（缩放到画布上，文字/道路更清楚）；
      // 只在需要瓦片不多时用，避免同时拉太多高清图。
      const needCount = (x1 - x0 + 1) * (y1 - y0 + 1);
      const ts = state.cam.zoom >= 4.5 && needCount <= 22 ? 2 : 1; // 放大后用 512px 高清瓦片
      TILE_STATS.lastDraw = { z, ts, need: needCount, cam: { lon: +c.lon.toFixed(2), lat: +c.lat.toFixed(2), zoom: +c.zoom.toFixed(2) } };

      ctx.fillStyle = '#aecfe8';
      ctx.fillRect(0, 0, W, H);

      let drawn = 0;
      for (let tx = x0; tx <= x1; tx++) {
        for (let ty = y0; ty <= y1; ty++) {
          if (ty < 0 || ty >= maxTile) continue;
          const sx = tx * tilePx - cx + W / 2;
          const sy = ty * tilePx - cy + H / 2;
          const rec = getTile(z, tx, ty, ts, scheduleRedraw);
          if (rec && rec.ok && rec.img) {
            ctx.drawImage(rec.img, sx, sy, tilePx + 1, tilePx + 1);
            drawn += 1;
          } else if (rec && rec.err) {
            ctx.fillStyle = '#dfe6ee';
            ctx.fillRect(sx, sy, tilePx + 1, tilePx + 1);
          }
        }
      }
      // 只有“一个瓦片都没成功过”时才退回矢量地图；个别 404 不影响
      if (drawn === 0 && TILE_STATS.ok === 0 && TILE_STATS.err >= 12 && TILE_STATS.ok + TILE_STATS.err >= 12) {
        state.mode = 'vector';
        drawVector();
      }
    }

    function drawVector() {
      const c = state.cam;
      const spanLon = 360 / Math.pow(2, c.zoom - 1.4);
      const spanLat = spanLon * (H / W);
      const x0 = c.lon - spanLon / 2;
      const yTop = c.lat + spanLat / 2;
      const sx = W / spanLon;
      const sy = H / spanLat;
      const toX = (lon) => (lon - x0) * sx;
      const toY = (lat) => (yTop - lat) * sy;

      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0a1526');
      g.addColorStop(1, '#091320');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      ctx.strokeStyle = 'rgba(110,160,210,0.10)';
      ctx.lineWidth = 1;
      for (let lon = Math.ceil(x0 / 30) * 30; lon <= x0 + spanLon; lon += 30) {
        ctx.beginPath();
        ctx.moveTo(toX(lon), 0);
        ctx.lineTo(toX(lon), H);
        ctx.stroke();
      }
      for (let lat = -80; lat <= 80; lat += 30) {
        const yy = toY(lat);
        if (yy < 0 || yy > H) continue;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(W, yy);
        ctx.stroke();
      }
      for (const ctry of COUNTRIES) {
        ctx.beginPath();
        for (const ring of ctry.r || []) {
          for (let i = 0; i < ring.length; i += 2) {
            const X = toX(ring[i]);
            const Y = toY(ring[i + 1]);
            if (i === 0) ctx.moveTo(X, Y);
            else ctx.lineTo(X, Y);
          }
          ctx.closePath();
        }
        ctx.fillStyle = '#233043';
        ctx.fill('evenodd');
        ctx.strokeStyle = 'rgba(150,190,230,0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    /* ---- 叠加层 ---- */
    function drawOverlays(step) {
      const c = state.cam;

      if (step && step.shade) {
        const wp = worldPx(c.zoom);
        const eqY = H / 2 + (mercY(0) * wp - mercY(c.lat) * wp);
        const y = clamp(eqY, -H, H * 2);
        ctx.fillStyle = 'rgba(37,99,235,0.20)';
        if (step.shade === 'north') ctx.fillRect(0, Math.min(0, y), W, Math.abs(y));
        else ctx.fillRect(0, y, W, H - y);
        if (y > 0 && y < H) {
          ctx.strokeStyle = 'rgba(37,99,235,0.85)';
          ctx.setLineDash([6, 5]);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(W, y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.font = '600 12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = 'rgba(29,78,216,0.95)';
        ctx.fillText(step.shade === 'north' ? '北半球' : '南半球', 10, clamp(step.shade === 'north' ? y - 8 : y + 18, 16, H - 8));
      }

      if (step && step.highlight) {
        let list = [];
        if (step.highlight.type === 'continent') {
          const key = continentKey(step.highlight.key);
          if (key) list = CONTINENTS[key];
        } else if (step.highlight.type === 'country') {
          const ctry = findCountry(step.highlight.key);
          if (ctry) list = [ctry];
        }
        ctx.fillStyle = 'rgba(37,99,235,0.22)';
        ctx.strokeStyle = 'rgba(37,99,235,0.9)';
        ctx.lineWidth = 1.8;
        for (const ctry of list) {
          ctx.beginPath();
          for (const ring of ctry.r || []) {
            let prev = null;
            for (let i = 0; i < ring.length; i += 2) {
              const p = project(ring[i + 1], ring[i]);
              if (!prev) ctx.moveTo(p.x, p.y);
              else if (Math.abs(p.x - prev.x) > W * 0.6) ctx.moveTo(p.x, p.y);
              else ctx.lineTo(p.x, p.y);
              prev = p;
            }
            ctx.closePath();
          }
          ctx.fill('evenodd');
          ctx.stroke();
        }
      }

      if (step && step.line && step.line.length >= 2) {
        const a = project(step.line[0].lat, step.line[0].lon);
        const b = project(step.line[1].lat, step.line[1].lon);
        ctx.strokeStyle = 'rgba(220,38,38,0.9)';
        ctx.lineWidth = 2.2;
        ctx.setLineDash([7, 6]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const markers = [];
      if (step && step.marker) markers.push(step.marker);
      if (step && Array.isArray(step.markers)) markers.push(...step.markers);
      for (const mk of markers) {
        if (!mk || !isFinite(mk.lon) || !isFinite(mk.lat)) continue;
        const p = project(mk.lat, mk.lon);
        const color = mk.color || '#e11d48';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
        ctx.fillStyle = color + '33';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        if (mk.label) {
          ctx.font = '600 12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
          const tw = ctx.measureText(mk.label).width;
          const lx = clamp(p.x + 11, 4, W - tw - 14);
          const ly = clamp(p.y - 11, 16, H - 6);
          ctx.fillStyle = 'rgba(255,255,255,0.94)';
          ctx.fillRect(lx - 5, ly - 13, tw + 10, 19);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(lx - 5, ly - 13, tw + 10, 19);
          ctx.fillStyle = color;
          ctx.fillText(mk.label, lx, ly);
        }
      }
    }

    function drawScaleBar() {
      const c = state.cam;
      const wp = worldPx(c.zoom);
      const degPerPx = 360 / wp;
      const kmPerDeg = 111.32 * Math.cos((c.lat * Math.PI) / 180);
      const targetPx = 90;
      const kmTarget = degPerPx * targetPx * kmPerDeg;
      const pow = Math.pow(10, Math.floor(Math.log10(Math.max(0.001, kmTarget))));
      const nice = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= kmTarget / 2) || pow;
      const px = nice / kmPerDeg / degPerPx;
      const x = 12;
      const y = H - 14;
      ctx.strokeStyle = 'rgba(30,41,59,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + px, y);
      ctx.moveTo(x, y - 4);
      ctx.lineTo(x, y + 4);
      ctx.moveTo(x + px, y - 4);
      ctx.lineTo(x + px, y + 4);
      ctx.stroke();
      ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
      ctx.fillStyle = 'rgba(30,41,59,0.9)';
      ctx.fillText(nice >= 1 ? `${Math.round(nice)} km` : `${Math.round(nice * 1000)} m`, x + px + 6, y + 4);
    }

    function drawFrame() {
      if (state.destroyed) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const step = state.steps[state.index];
      if (state.mode === 'vector') {
        drawVector();
      } else {
        drawTiles();
      }
      drawOverlays(step);
      drawScaleBar();
      const credit = '地图 © 华为云 · 与图寻同源';
      ctx.font = '10px -apple-system, sans-serif';
      const cw = ctx.measureText(credit).width;
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillRect(W - cw - 12, H - 20, cw + 8, 15);
      ctx.fillStyle = '#334155';
      ctx.fillText(credit, W - cw - 8, H - 9);
    }

    let redrawTimer = 0;
    function scheduleRedraw() {
      if (redrawTimer || state.destroyed) return;
      redrawTimer = setTimeout(() => {
        redrawTimer = 0;
        drawFrame();
      }, 120);
    }

    /* ---- 动画 ---- */
    function tick(now) {
      if (state.phase !== 'anim' || state.destroyed) return;
      const t = clamp((now - state.t0) / state.dur, 0, 1);
      const e = easeInOut(t);
      const a = state.from;
      const b = state.to;
      state.cam = {
        lon: a.lon + (b.lon - a.lon) * e,
        lat: a.lat + (b.lat - a.lat) * e,
        zoom: a.zoom + (b.zoom - a.zoom) * e,
      };
      drawFrame();
      if (t < 1) {
        state.raf = requestAnimationFrame(tick);
      } else {
        state.phase = 'idle';
        setTimeout(() => { if (!state.destroyed) drawFrame(); }, 350);
        if (state.auto && state.index < state.steps.length - 1) {
          state.holdTimer = setTimeout(() => goTo(state.index + 1), 1100);
        }
      }
    }

    function emit(step, i) {
      if (opts.onStep) opts.onStep(step, i, state.steps.length, state.auto);
    }

    function goTo(i, immediate) {
      if (!state.steps.length || state.destroyed) return;
      cancelAnimationFrame(state.raf);
      clearTimeout(state.holdTimer);
      const idx = clamp(i, 0, state.steps.length - 1);
      state.index = idx;
      const step = state.steps[idx];
      resize();
      const target = targetFromStep(step);
      if (immediate) {
        state.cam = target;
        state.phase = 'idle';
        drawFrame();
        setTimeout(() => { if (!state.destroyed) drawFrame(); }, 300);
        setTimeout(() => { if (!state.destroyed) drawFrame(); }, 900);
      } else {
        state.from = Object.assign({}, state.cam);
        state.to = target;
        state.t0 = performance.now();
        state.dur = step.duration || 950;
        state.phase = 'anim';
        state.raf = requestAnimationFrame(tick);
      }
      emit(step, idx);
    }

    /* ---- 交互 ---- */
    let drag = null;
    function onPointerDown(e) {
      if (state.destroyed) return;
      drag = { x: e.clientX, y: e.clientY, cam: Object.assign({}, state.cam) };
      cancelAnimationFrame(state.raf);
      clearTimeout(state.holdTimer);
      state.phase = 'idle';
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e) {
      if (!drag) return;
      const wp = worldPx(drag.cam.zoom);
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      const cx = ((drag.cam.lon + 180) / 360) * wp - dx;
      const cy = mercY(drag.cam.lat) * wp - dy;
      state.cam = {
        lon: (cx / wp) * 360 - 180,
        lat: invMercY(clamp(cy / wp, 0.0005, 0.9995)),
        zoom: drag.cam.zoom,
      };
      drawFrame();
    }
    function onPointerUp() {
      drag = null;
    }
    function onWheel(e) {
      if (state.destroyed) return;
      e.preventDefault();
      cancelAnimationFrame(state.raf);
      clearTimeout(state.holdTimer);
      state.phase = 'idle';
      state.cam = Object.assign({}, state.cam, {
        zoom: clamp(state.cam.zoom - e.deltaY * 0.0022, ZOOM_MIN, ZOOM_MAX),
      });
      drawFrame();
    }
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const api = {
      play(steps) {
        state.steps = Array.isArray(steps) ? steps : [];
        state.index = -1;
        state.auto = true;
        resize(true);
        goTo(0, true);
        if (state.steps.length > 1) state.holdTimer = setTimeout(() => goTo(1), 1100);
      },
      next() { if (state.index < state.steps.length - 1) goTo(state.index + 1); },
      prev() { if (state.index > 0) goTo(state.index - 1, true); },
      replay() { this.play(state.steps); },
      toggleAuto() { state.auto = !state.auto; return state.auto; },
      show(i) { goTo(i, true); },
      redraw() { resize(true); drawFrame(); },
      stop() {
        state.auto = false;
        cancelAnimationFrame(state.raf);
        clearTimeout(state.holdTimer);
        state.phase = 'idle';
      },
      destroy() {
        state.destroyed = true;
        cancelAnimationFrame(state.raf);
        clearTimeout(state.holdTimer);
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('wheel', onWheel);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        clearTimeout(redrawTimer);
        redrawTimer = 0;
        canvas.width = 1;
        canvas.height = 1;
      },
      get index() { return state.index; },
      get steps() { return state.steps; },
      get mode() { return state.mode; },
    };
    return api;
  }

  /* ---------------- 分步：数据驱动 ---------------- */
  function buildSteps({ guess, truth, aiLabel }) {
    const g = guess || {};
    const lat = Number(g.lat);
    const lng = Number(g.lng);
    const hasPoint = isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const contKey = continentKey(g.continent) || ZH_TO_CONTINENT[g.continent] || ZH_TO_CONTINENT[g.continentZh] || null;
    const country = findCountry(g.countryCode) || findCountry(g.countryEn) || findCountry(g.country);

    const steps = [];
    const aiSteps = Array.isArray(g.steps) ? g.steps.filter((s) => s && s.level) : [];
    const levelView = (level) => {
      const l = String(level || '').toLowerCase();
      if (l === 'hemisphere') {
        return { view: { lon: 0, lat: 12, spanLon: 360, spanLat: 180 }, shade: hasPoint ? (lat >= 0 ? 'north' : 'south') : null };
      }
      if (l === 'continent') {
        const v = viewForContinent(contKey);
        return v ? { view: v, highlight: { type: 'continent', key: contKey } } : null;
      }
      if (l === 'country' || l === 'region' || l === 'city') {
        if (country) return { bbox: country.mb || country.b, highlight: { type: 'country', key: country.i } };
        return null;
      }
      if (l === 'place' || l === 'point' || l === 'exact') {
        return hasPoint ? { focus: { lon: lng, lat, span: 7 }, marker: { lon: lng, lat, label: aiLabel || 'AI 猜测', color: '#e11d48' } } : null;
      }
      return null;
    };

    if (aiSteps.length >= 2) {
      for (const s of aiSteps) {
        const base = levelView(s.level);
        if (!base) continue;
        steps.push(
          Object.assign(
            {
              title: String(s.conclusion || '').slice(0, 24) || String(s.level),
              text: [s.conclusion, s.evidence].filter(Boolean).join(' —— '),
            },
            base,
          ),
        );
      }
    }

    if (steps.length < 2) {
      steps.length = 0;
      if (hasPoint) {
        steps.push({
          title: '第 1 步 · 先定半球',
          text: `${lat >= 0 ? '北半球' : '南半球'}、${lng >= 0 ? '东半球' : '西半球'} —— 由太阳方向、植被与气候带判断`,
          view: { lon: 0, lat: 12, spanLon: 360, spanLat: 180 },
          shade: lat >= 0 ? 'north' : 'south',
        });
      }
      const cv = viewForContinent(contKey);
      if (cv) {
        steps.push({
          title: '第 2 步 · 锁定大洲',
          text: CONTINENT_ZH[contKey] || contKey,
          view: cv,
          highlight: { type: 'continent', key: contKey },
        });
      }
      if (country) {
        steps.push({
          title: '第 3 步 · 锁定国家',
          text: country.z,
          bbox: country.mb || country.b,
          highlight: { type: 'country', key: country.i },
        });
      }
      if (hasPoint) {
        steps.push({
          title: '第 4 步 · 具体位置',
          text: [g.region, g.summary].filter(Boolean).join(' · '),
          focus: { lon: lng, lat, span: 7 },
          marker: { lon: lng, lat, label: aiLabel || 'AI 猜测', color: '#e11d48' },
        });
      }
    }

    const t = truth && isFinite(truth.lat) && isFinite(truth.lng) ? truth : null;
    if (t) {
      if (hasPoint) {
        const dkm = haversine(lat, lng, t.lat, t.lng);
        const span = clamp(Math.max(8, Math.abs(t.lng - lng) * 1.7, (Math.abs(t.lat - lat) * 1.7) / 0.62), 8, 120);
        steps.push({
          title: '答案 · 真实位置',
          text: `真实位置 ${t.lat.toFixed(4)}, ${t.lng.toFixed(4)}（距 AI 猜测 ${dkm.toFixed(0)} km）`,
          view: { lon: (t.lng + lng) / 2, lat: (t.lat + lat) / 2, spanLon: span, spanLat: span * 0.62 },
          line: [{ lon: lng, lat }, { lon: t.lng, lat: t.lat }],
          highlight: country ? { type: 'country', key: country.i } : null,
          markers: [
            { lon: lng, lat, label: 'AI 猜测', color: '#e11d48' },
            { lon: t.lng, lat: t.lat, label: '真实位置', color: '#16a34a' },
          ],
        });
      } else {
        steps.push({
          title: '答案 · 真实位置',
          text: `${t.lat.toFixed(4)}, ${t.lng.toFixed(4)}`,
          focus: { lon: t.lng, lat: t.lat, span: 7 },
          marker: { lon: t.lng, lat: t.lat, label: '真实位置', color: '#16a34a' },
        });
      }
    }
    return steps;
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r;
    const dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  window.__TX_MAP_ANIM__ = {
    create,
    buildSteps,
    findCountry,
    viewForContinent,
    continentZh: (k) => CONTINENT_ZH[k] || k,
    countries: COUNTRIES,
    renderStatic,
    tileUrlFor,
    zoomForPoint,
    clearTiles() {
      for (const [, rec] of tileCache) {
        if (rec && rec.img) {
          try {
            rec.img.src = '';
          } catch (e) {}
        }
      }
      tileCache.clear();
    },
  };
})();
