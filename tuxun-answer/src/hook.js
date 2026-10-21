/**
 * 图寻 AI 助手 —— 页面主世界钩子（MAIN world, document_start）
 *
 * 作用：
 * 1. 在图寻加载 Google Maps JS API（b68v.daai.fun/st_v3/js_v32.js）时，
 *    拦截 google.maps.StreetViewPanorama 的构造，拿到街景实例；
 * 2. 通过 postMessage 向内容脚本暴露：当前街景 id、坐标、朝向、容器位置；
 * 3. 支持程序化转动视角（setPov），用于 360° 多角度截图；
 * 4. 旁路记录 WebSocket 消息，供“自动识别本回合得分”做尽力而为的尝试。
 *
 * 本文件运行在页面上下文，不读取/上传任何隐私数据，只服务于当前页面内的助手功能。
 */
(() => {
  'use strict';
  if (window.__TXAI_HOOK__) return;
  window.__TXAI_HOOK__ = true;

  const state = {
    inst: null,
    el: null,
    wrapped: 0,
    realCtor: null,
    origSVP: null,
    origWS: null,
    hookOff: false,
    deep: false,
  };
  const wsLog = [];
  let reqSeq = 0;

  function deepInstallGoogle() {
  /* ---------------- 1. 拦截 google / google.maps / StreetViewPanorama ---------------- */

  function makeAccessor(obj, prop, onSet) {
    let val;
    try {
      Object.defineProperty(obj, prop, {
        configurable: true,
        enumerable: true,
        get() {
          return val;
        },
        set(v) {
          val = v;
          try {
            onSet && onSet(v);
          } catch (e) {
            /* ignore */
          }
        },
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function wrapCtor(Orig) {
    if (typeof Orig !== 'function') return Orig;
    if (Orig.__txaiWrapped) return Orig;
    // 用 Proxy 包一层：toString() 仍然是 "function () { [native code] }"，
    // 比直接替换成自定义函数更不容易被页面的 toString 检测认出来。
    let proxy;
    try {
      proxy = new Proxy(Orig, {
        construct(target, args) {
          const inst = Reflect.construct(target, args);
          try {
            state.inst = inst;
            state.el = args && args[0];
            state.wrapped += 1;
          } catch (e) {
            /* ignore */
          }
          return inst;
        },
      });
      proxy.__txaiWrapped = true;
      state.origSVP = Orig;
      return proxy;
    } catch (e) {
      return Orig;
    }
  }

  let mapsObj = null;

  function patchMaps(maps) {
    if (!maps || typeof maps !== 'object' || mapsObj === maps) return;
    mapsObj = maps;
    try {
      makeAccessor(maps, 'StreetViewPanorama', (v) => {
        if (typeof v === 'function' && !v.__txaiWrapped) {
          state.origSVP = v;
          if (state.hookOff) {
            try {
              Object.defineProperty(maps, 'StreetViewPanorama', { configurable: true, enumerable: true, writable: true, value: v });
            } catch (e) {}
            return;
          }
          const wrapped = wrapCtor(v);
          state.realCtor = wrapped;
          // 把属性值换回包装后的构造函数
          try {
            Object.defineProperty(maps, 'StreetViewPanorama', {
              configurable: true,
              enumerable: true,
              writable: true,
              value: wrapped,
            });
          } catch (e) {
            /* ignore */
          }
        } else if (typeof v === 'function') {
          state.realCtor = v;
        }
      });
    } catch (e) {
      /* ignore */
    }
    // 万一页面用 defineProperty 绕过访问器，轮询兜底
    pollCtor();
  }

  function pollCtor() {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const C = mapsObj && mapsObj.StreetViewPanorama;
      if (typeof C === 'function' && !C.__txaiWrapped) {
        state.realCtor = wrapCtor(C);
        try {
          Object.defineProperty(mapsObj, 'StreetViewPanorama', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: state.realCtor,
          });
        } catch (e) {
          /* ignore */
        }
        clearInterval(timer);
        return;
      }
      if (state.realCtor || tries > 600) clearInterval(timer); // ~60s
    }, 100);
  }

  // 先在 window.google 上装访问器：js_v32.js 一赋值就能拿到 maps
  try {
    let googleObj = window.google;
    makeAccessor(window, 'google', (v) => {
      googleObj = v;
      if (v && typeof v === 'object') {
        try {
          makeAccessor(v, 'maps', (maps) => {
            if (maps && typeof maps === 'object') patchMaps(maps);
          });
        } catch (e) {
          /* ignore */
        }
        if (v.maps && typeof v.maps === 'object') patchMaps(v.maps);
      }
    });
    if (googleObj && googleObj.maps) patchMaps(googleObj.maps);
  } catch (e) {
    /* ignore */
  }

  // 再兜一层轮询：有的构建会先把 google 挂到别的全局上
  const boot = setInterval(() => {
    try {
      const g = window.google;
      if (g && g.maps) {
        patchMaps(g.maps);
        if (g.maps.StreetViewPanorama) clearInterval(boot);
      }
    } catch (e) {
      /* ignore */
    }
  }, 250);


  }

  function deepInstallWs() {
  /* ---------------- 2. WebSocket 旁路记录 ---------------- */

  try {
    const OrigWS = window.WebSocket;
    state.origWS = OrigWS;
    if (typeof OrigWS === 'function' && !OrigWS.__txaiWrapped) {
      const WSProxy = new Proxy(OrigWS, {
        construct(target, args) {
          const ws = Reflect.construct(target, args);
          try {
            ws.addEventListener('message', (ev) => {
              try {
                const data = typeof ev.data === 'string' ? ev.data : '[binary]';
                wsLog.push({ t: Date.now(), data: data.slice(0, 4000) });
                if (wsLog.length > 80) wsLog.splice(0, wsLog.length - 80);
              } catch (e) {
                /* ignore */
              }
            });
          } catch (e) {
            /* ignore */
          }
          return ws;
        },
      });
      try {
        WSProxy.__txaiWrapped = true;
        window.WebSocket = WSProxy;
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    /* ignore */
  }


  }

  function installDeep() {
    if (state.deep) return { ok: true, already: true };
    state.deep = true;
    try { deepInstallGoogle(); } catch (e) {}
    try { deepInstallWs(); } catch (e) {}
    return { ok: true, deep: true };
  }

  /* ---------------- 3. 对外接口 ---------------- */

  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.width < 40 || r.height < 40) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function posOf(inst) {
    try {
      const p = inst.getPosition && inst.getPosition();
      if (!p) return null;
      const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
      const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
      if (typeof lat !== 'number' || typeof lng !== 'number') return null;
      return { lat, lng };
    } catch (e) {
      return null;
    }
  }

  function linksOf(inst) {
    try {
      const links = inst.getLinks ? inst.getLinks() : null;
      if (!Array.isArray(links)) return null;
      return links.map((l) => ({
        pano: l && l.pano,
        heading: l && l.heading,
        description: l && l.description,
      }));
    } catch (e) {
      return null;
    }
  }

  function getState() {
    const inst = findPano();
    if (!inst) {
      return { ok: false, reason: 'no-pano', wrapped: state.wrapped };
    }
    let panoId = null;
    try {
      panoId = inst.getPano ? inst.getPano() : null;
    } catch (e) {
      /* ignore */
    }
    let pov = null;
    try {
      pov = inst.getPov ? inst.getPov() : null;
    } catch (e) {
      /* ignore */
    }
    let zoom = null;
    try {
      zoom = inst.getZoom ? inst.getZoom() : null;
    } catch (e) {
      /* ignore */
    }
    let status = null;
    try {
      status = inst.getStatus ? inst.getStatus() : null;
    } catch (e) {
      /* ignore */
    }
    return {
      ok: true,
      panoId,
      status,
      pov: pov ? { heading: pov.heading, pitch: pov.pitch } : null,
      position: posOf(inst),
      zoom,
      rect: rectOf(state.el),
      links: linksOf(inst),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      wrapped: state.wrapped,
    };
  }

  function setPov(heading, pitch, zoom) {
    const inst = findPano();
    if (!inst) return { ok: false, reason: 'no-pano' };
    try {
      const pov = {};
      if (typeof heading === 'number' && isFinite(heading)) pov.heading = heading;
      if (typeof pitch === 'number' && isFinite(pitch)) pov.pitch = pitch;
      inst.setPov(pov);
      if (typeof zoom === 'number' && isFinite(zoom) && inst.setZoom) inst.setZoom(zoom);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }


﻿  /* ---------------- 4. 猜点地图自动打点（MapLibre / Google 通用） ---------------- */

  const mapState = { map: null, kind: null, foundAt: 0 };

  function getFiber(el) {
    try {
      for (const k of Object.keys(el)) {
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k];
      }
    } catch (e) {}
    return null;
  }

  function mapKindOf(o) {
    if (!o || typeof o !== 'object') return null;
    try {
      if (typeof o.project === 'function' && typeof o.unproject === 'function' && typeof o.jumpTo === 'function' && typeof o.getCanvas === 'function') {
        return 'maplibre';
      }
      if (typeof o.getCenter === 'function' && typeof o.setView === 'function' && typeof o.latLngToContainerPoint === 'function') {
        return 'leaflet';
      }
      if (typeof o.getCenter === 'function' && typeof o.setCenter === 'function' && typeof o.getZoom === 'function' && typeof o.setZoom === 'function') {
        return 'google';
      }
      // 通用兜底：有容器 + 能取中心 + 能移动（不要求知道投影）
      const hasHost = typeof o.getCanvas === 'function' || typeof o.getContainer === 'function' || typeof o.getDiv === 'function';
      const hasCenter = typeof o.getCenter === 'function';
      const hasMove = typeof o.jumpTo === 'function' || typeof o.setView === 'function' || typeof o.setCenter === 'function' || typeof o.centerAndZoom === 'function';
      if (hasHost && hasCenter && hasMove) {
        return 'generic';
      }
    } catch (e) {}
    return null;
  }

  function panoKindOf(o) {
    if (!o || typeof o !== 'object') return false;
    try {
      return typeof o.getPano === 'function' && typeof o.getPov === 'function' && typeof o.setPov === 'function';
    } catch (e) {
      return false;
    }
  }

  function walkFiber(root, maxNodes, pred) {
    let n = 0;
    const queue = [root];
    const seen = new Set();
    while (queue.length && n < maxNodes) {
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      n += 1;
      try {
        const sn = f.stateNode;
        if (sn && typeof sn === 'object') {
          const candidates = [sn.map, sn.mapInstance, sn.mapbox, sn.mapRef, sn._map, sn.mapObj, sn.mMap, sn.panorama, sn.pano, sn.instance];
          for (const c of candidates) {
            if (pred(c)) return { val: c };
          }
        }
      } catch (e) {}
      let hook = f.memoizedState;
      let hn = 0;
      while (hook && hn < 60) {
        try {
          const st = hook.memoizedState;
          if (pred(st)) return { val: st };
          if (st && typeof st === 'object' && pred(st.current)) return { val: st.current };
        } catch (e) {}
        hook = hook.next;
        hn += 1;
      }
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
      // 关键：组件 ref 常常挂在「祖先」组件上，必须往上走
      if (f.return && !seen.has(f.return)) queue.push(f.return);
    }
    return null;
  }

  function scanElements(selector, pred, maxNodes) {
    const els = document.querySelectorAll(selector);
    const seen = new Set();
    for (const el of els) {
      const fiber = getFiber(el);
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const hit = walkFiber(fiber, maxNodes || 4000, pred);
      if (hit) return hit.val;
    }
    return null;
  }

  // 从 React fiber 里直接找街景实例（默认方式：完全不动页面 API）
  function findPano() {
    if (state.inst) {
      try {
        const d = state.inst.getDiv && state.inst.getDiv();
        if (!d || document.contains(d)) return state.inst;
      } catch (e) {
        state.inst = null;
      }
    }
    let found = scanElements('[class*="viewer"], [class*="pano"], [class*="Pano"], canvas, div', panoKindOf, 3000);
    if (!found) {
      try {
        for (const k of Object.keys(window)) {
          if (k.indexOf('__') === 0) continue;
          let v;
          try { v = window[k]; } catch (e) { continue; }
          if (panoKindOf(v)) { found = v; break; }
        }
      } catch (e) {}
    }
    if (found) {
      state.inst = found;
      try {
        state.el = found.getDiv ? found.getDiv() : state.el;
      } catch (e) {}
    }
    return found;
  }


  function findPickApi() {
    if (state.pickApi) return state.pickApi;
    const names = /^(setPickCoord|onPickLocation|setPick|onPick|onSelectLocation|selectLocation|onPickCoord|setPickLocation|setGuess|onGuess|guessCoord|onMapClick|handleMapClick|onClickMap|setMarker|placeMarker|setTarget|setLocation|setCoord|onSelect|pickLocation|onPickLocationChange)$/;
    const keysOf = (obj) => {
      try {
        return obj ? Object.keys(obj) : [];
      } catch (e) {
        return [];
      }
    };
    const found = { setPickCoord: null, onPickLocation: null, keys: [] };
    const els = document.querySelectorAll('canvas, [class*="map"], [class*="Map"], div');
    const seen = new Set();
    for (const el of els) {
      const fiber = getFiber(el);
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const queue = [fiber];
      let n = 0;
      const vis = new Set();
      while (queue.length && n < 2500) {
        const f = queue.shift();
        if (!f || vis.has(f)) continue;
        vis.add(f);
        n += 1;
        for (const src of [f.memoizedProps, f.stateNode]) {
          const ks = keysOf(src);
          for (const k of ks) {
            if (!names.test(k)) continue;
            let fn = null;
            try {
              fn = src[k];
            } catch (e) {}
            if (typeof fn === 'function') {
              found[k] = fn;
              if (found.keys.indexOf(k) < 0) found.keys.push(k);
            }
          }
        }
        if (f.child) queue.push(f.child);
        if (f.sibling) queue.push(f.sibling);
        if (f.return) queue.push(f.return);
      }
      if (found.setPickCoord || found.onPickLocation) break;
    }
    if (found.setPickCoord || found.onPickLocation) state.pickApi = found;
    return found.setPickCoord || found.onPickLocation ? found : null;
  }

  function placeByPickApi(lat, lng) {
    const api = findPickApi();
    if (!api) return { ok: false, reason: 'no-pick-api' };
    const coord = { lat, lng };
    const tries = [];
    if (api.setPickCoord) tries.push(() => api.setPickCoord(coord));
    if (api.onPickLocation) tries.push(() => api.onPickLocation(coord));
    for (const fn of tries) {
      try {
        fn();
        return { ok: true, kind: 'pick-api' };
      } catch (e) {}
    }
    return { ok: false, reason: 'pick-api-error' };
  }

  function scanFiberTree(pred, maxNodes) {
    const roots = reactRoots();
    if (!roots.length) return null;
    const queue = roots.slice();
    const seen = new Set();
    let n = 0;
    while (queue.length && n < maxNodes) {
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      n += 1;
      const cands = [];
      try { if (f.stateNode) cands.push(f.stateNode); } catch (e) {}
      try { if (f.memoizedProps) cands.push(f.memoizedProps); } catch (e) {}
      for (const c of cands) {
        if (!c || typeof c !== 'object') continue;
        const kind = pred(c);
        if (kind) return { val: c, kind, nodes: n };
        try {
          const ks = Object.keys(c);
          for (let i = 0; i < Math.min(ks.length, 24); i++) {
            const vv = c[ks[i]];
            if (vv && typeof vv === 'object') {
              const kk = pred(vv);
              if (kk) return { val: vv, kind: kk, nodes: n };
            }
          }
        } catch (e) {}
      }
      let hook = f.memoizedState;
      let hi = 0;
      while (hook && hi < 80) {
        let st = null;
        try { st = hook.memoizedState; } catch (e) {}
        if (st && typeof st === 'object') {
          const kind = pred(st) || pred(st.current);
          if (kind) return { val: pred(st) ? st : st.current, kind, nodes: n };
          try {
            const ks = Object.keys(st);
            for (let i = 0; i < Math.min(ks.length, 24); i++) {
              const vv = st[ks[i]];
              if (vv && typeof vv === 'object') {
                const kk = pred(vv);
                if (kk) return { val: vv, kind: kk, nodes: n };
              }
            }
          } catch (e) {}
        }
        hook = hook.next;
        hi += 1;
      }
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
      if (f.return) queue.push(f.return);
    }
    return null;
  }

  function guessMapReport() {
    const hit = scanFiberTree(mapKindOf, 30000);
    if (!hit) return { found: false };
    const m = hit.val || {};
    const methods = Object.keys(m).filter((k) => {
      try { return typeof m[k] === 'function'; } catch (e) { return false; }
    }).slice(0, 18);
    return { found: true, kind: hit.kind, nodes: hit.nodes, methods };
  }

  function findGuessMap() {
    if (mapState.map) {
      try {
        const c = mapState.map.getCanvas ? mapState.map.getCanvas() : null;
        if (!c || document.contains(c)) return mapState;
      } catch (e) {
        mapState.map = null;
      }
    }
    const rootHit = scanFiberTree(mapKindOf, 30000);
    if (rootHit) {
      mapState.map = rootHit.val;
      mapState.kind = rootHit.kind;
      mapState.foundAt = Date.now();
      return mapState;
    }
    const els = document.querySelectorAll('canvas, [class*="map"], [class*="Map"], [class*="leaflet"], [class*="maplibre"]');
    const seen = new Set();
    for (const el of els) {
      const fiber = getFiber(el);
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const hit = walkFiber(fiber, 4000, mapKindOf);
      if (hit && hit.val) {
        mapState.map = hit.val;
        mapState.kind = mapKindOf(hit.val);
        mapState.foundAt = Date.now();
        return mapState;
      }
    }
    try {
      for (const k of Object.keys(window)) {
        if (k.indexOf('__') === 0) continue;
        let v;
        try {
          v = window[k];
        } catch (e) {
          continue;
        }
        const kind = mapKindOf(v);
        if (kind) {
          mapState.map = v;
          mapState.kind = kind;
          return mapState;
        }
      }
    } catch (e) {}
    return null;
  }

  function mapInfo() {
    const found = findGuessMap();
    if (!found) return { ok: true, found: false };
    try {
      const m = found.map;
      const c = m.getCanvas ? m.getCanvas() : m.getDiv ? m.getDiv() : null;
      const r = c && c.getBoundingClientRect ? c.getBoundingClientRect() : null;
      const center = m.getCenter ? m.getCenter() : null;
      return {
        ok: true,
        found: true,
        kind: found.kind,
        rect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
        center: center && typeof center.lat === 'number' ? { lat: center.lat, lng: center.lng } : null,
        zoom: m.getZoom ? m.getZoom() : null,
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  function fireMapClick(m, lngLat, point) {
    try {
      m.fire('click', { lngLat, point, originalEvent: null });
      return true;
    } catch (e) {
      return false;
    }
  }

  function mercY(lat) {
    const l = Math.max(-85.05112878, Math.min(85.05112878, lat)) * (Math.PI / 180);
    return (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2;
  }

  function reactRoots() {
    const roots = [];
    const els = [document.getElementById('root'), document.body, document.documentElement];
    for (const el of els) {
      if (!el) continue;
      try {
        for (const k of Object.keys(el)) {
          const v = el[k];
          if (k.indexOf('__reactContainer$') === 0) roots.push(v);
          else if (k.indexOf('__reactFiber$') === 0) {
            let f = v;
            let n = 0;
            while (f.return && n < 300) {
              f = f.return;
              n += 1;
            }
            roots.push(f);
          }
        }
      } catch (e) {}
    }
    return roots;
  }

  // 方法 A：直接从 React 状态里找到「选中坐标」的 state，并 dispatch 新坐标
  function scanHookStates(pred, maxNodes) {
    const roots = reactRoots();
    if (!roots.length) return [];
    const out = [];
    const queue = roots.slice();
    const seen = new Set();
    let n = 0;
    while (queue.length && n < maxNodes) {
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      n += 1;
      let hook = f.memoizedState;
      let hi = 0;
      while (hook && hi < 80) {
        let st = null;
        try { st = hook.memoizedState; } catch (e) {}
        if (st && typeof st === 'object') {
          const got = pred(st);
          if (got) out.push(got);
          try {
            const ks = Object.keys(st);
            for (let i = 0; i < Math.min(ks.length, 24); i++) {
              const vv = st[ks[i]];
              if (vv && typeof vv === 'object') {
                const g2 = pred(vv);
                if (g2) out.push(g2);
              }
            }
          } catch (e) {}
        }
        hook = hook.next;
        hi += 1;
      }
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
      if (f.return) queue.push(f.return);
    }
    return out;
  }

  // 找「地图视图状态」：{center:{lat,lng} / center:[lng,lat] / lat,lng} + zoom/z
  function findMapViewStates() {
    return scanHookStates((st) => {
      if (!st || typeof st !== 'object') return null;
      const z = typeof st.zoom === 'number' ? st.zoom : typeof st.z === 'number' ? st.z : null;
      if (z == null) return null;
      let lat = null;
      let lng = null;
      const c = st.center || st.mapCenter || st.viewCenter;
      if (c) {
        if (typeof c.lat === 'number' && typeof c.lng === 'number') { lat = c.lat; lng = c.lng; }
        else if (Array.isArray(c) && c.length >= 2) { lng = c[0]; lat = c[1]; }
      }
      if (lat == null && typeof st.lat === 'number' && typeof st.lng === 'number') { lat = st.lat; lng = st.lng; }
      if (lat == null) return null;
      return { lat, lng, zoom: z, keys: Object.keys(st).slice(0, 8) };
    }, 30000);
  }

  function placeByViewState(targetLat, targetLng) {
    const states = findMapViewStates();
    if (!states.length) return { ok: false, reason: 'no-view-state' };
    const hit = findMapCanvas();
    if (!hit) return { ok: false, reason: 'no-canvas-view' };
    const st = states[0];
    const zoom = st.zoom;
    const TILE = 256;
    const size = TILE * Math.pow(2, zoom);
    const tx = ((targetLng + 180) / 360) * size;
    const ty = mercY(targetLat) * size;
    const cx = ((st.lng + 180) / 360) * size;
    const cy = mercY(st.lat) * size;
    const r = hit.r;
    const sx = r.left + r.width / 2 + (tx - cx);
    const sy = r.top + r.height / 2 + (ty - cy);
    if (!isFinite(sx) || !isFinite(sy)) return { ok: false, reason: 'bad-view-proj' };
    if (sx < r.left || sx > r.right || sy < r.top || sy > r.bottom) return { ok: false, reason: 'target-offscreen' };
    let target = null;
    try { target = document.elementFromPoint(sx, sy); } catch (e) {}
    if (!target) target = hit.c;
    const opts = { bubbles: true, cancelable: true, clientX: sx, clientY: sy, view: window, button: 0 };
    try {
      ['mousedown', 'mouseup', 'click'].forEach((t) => target.dispatchEvent(new MouseEvent(t, opts)));
    } catch (e) {
      return { ok: false, reason: 'dispatch-fail' };
    }
    return { ok: true, kind: 'view-state-click', zoom, x: Math.round(sx), y: Math.round(sy), states: states.length };
  }

  function placeByReactState(lat, lng) {
    const roots = reactRoots();
    if (!roots.length) return { ok: false, reason: 'no-react-root' };
    const hits = [];
    const queue = roots.slice();
    const seen = new Set();
    let n = 0;
    while (queue.length && n < 30000) {
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      n += 1;
      let hook = f.memoizedState;
      let hi = 0;
      while (hook && hi < 80) {
        let st = null;
        try {
          st = hook.memoizedState;
        } catch (e) {}
        if (st && typeof st === 'object' && Object.keys(st).length <= 6 && hook.queue && typeof hook.queue.dispatch === 'function') {
          const lat = typeof st.lat === 'number' ? st.lat : typeof st.latitude === 'number' ? st.latitude : null;
          const lng = typeof st.lng === 'number' ? st.lng : typeof st.longitude === 'number' ? st.longitude : null;
          if (lat != null && lng != null) hits.push(hook);
        }
        hook = hook.next;
        hi += 1;
      }
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
      if (f.return) queue.push(f.return);
    }
    hits.sort((a, b) => Object.keys(a.memoizedState).length - Object.keys(b.memoizedState).length);
    for (const hook of hits) {
      try {
        const cur = hook.memoizedState;
        const next = Object.assign({}, cur);
        if (typeof cur.lat === 'number') next.lat = lat;
        if (typeof cur.lng === 'number') next.lng = lng;
        if (typeof cur.latitude === 'number') next.latitude = lat;
        if (typeof cur.longitude === 'number') next.longitude = lng;
        hook.queue.dispatch(next);
        return { ok: true, kind: 'react-state', hits: hits.length };
      } catch (e) {}
    }
    return { ok: false, reason: 'no-react-coord', hits: hits.length };
  }

  // 方法 B：用页面上可见的瓦片 <img> 反推屏幕坐标，再点过去
  function placeByTiles(lat, lng) {
    const imgs = Array.from(document.images || []);
    const parsed = [];
    for (const im of imgs) {
      const src = im.src || '';
      if (!/getTile|maprastertile|dbankcdn/.test(src)) continue;
      const m = /\/getTile\/[^/]+\/(\d+)\/(\d+)\/(\d+)\//.exec(src);
      if (!m) continue;
      let r;
      try {
        r = im.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      if (!r || r.width < 20 || r.height < 20) continue;
      parsed.push({ z: +m[1], x: +m[2], y: +m[3], r });
    }
    if (!parsed.length) return { ok: false, reason: 'no-tile-imgs' };
    const zc = {};
    for (const p of parsed) zc[p.z] = (zc[p.z] || 0) + 1;
    const z = +Object.keys(zc).sort((a, b) => zc[b] - zc[a])[0];
    const t = parsed.filter((p) => p.z === z)[0];
    const scale = t.r.width / 256;
    const worldX = ((lng + 180) / 360) * 256 * Math.pow(2, z);
    const worldY = mercY(lat) * 256 * Math.pow(2, z);
    const sx = t.r.left + (worldX - t.x * 256) * scale;
    const sy = t.r.top + (worldY - t.y * 256) * scale;
    if (!isFinite(sx) || !isFinite(sy)) return { ok: false, reason: 'bad-proj' };
    let target = null;
    try {
      target = document.elementFromPoint(sx, sy);
    } catch (e) {}
    if (!target) return { ok: false, reason: 'no-element' };
    const tag = (target.tagName || '').toLowerCase();
    if (tag === 'button' || (target.closest && target.closest('button'))) return { ok: false, reason: 'hit-button' };
    const opts = { bubbles: true, cancelable: true, clientX: sx, clientY: sy, view: window, button: 0 };
    try {
      ['mousedown', 'mouseup', 'click'].forEach((t) => target.dispatchEvent(new MouseEvent(t, opts)));
    } catch (e) {
      return { ok: false, reason: 'dispatch-fail' };
    }
    return { ok: true, kind: 'tile-click', z, x: Math.round(sx), y: Math.round(sy) };
  }

  function findMapCanvas() {
    const winArea = window.innerWidth * window.innerHeight;
    let best = null;
    let bestMapish = null;
    for (const c of document.querySelectorAll('canvas')) {
      let r;
      try {
        r = c.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      if (!r || r.width < 120 || r.height < 80) continue;
      const area = r.width * r.height;
      // 判断是否在疑似地图容器里
      let inMap = false;
      let p = c.parentElement;
      for (let i = 0; i < 8 && p; i++) {
        const cls = p.className && typeof p.className === 'string' ? p.className : '';
        if (/map/i.test(cls) || /map/i.test(p.id || '')) {
          inMap = true;
          break;
        }
        p = p.parentElement;
      }
      if (inMap) {
        if (!bestMapish || area > bestMapish.area) bestMapish = { c, r, area };
        continue;
      }
      // 排除疑似全景画布（通常接近全屏）
      if (area > winArea * 0.75) continue;
      if (!best || area > best.area) best = { c, r, area };
    }
    return bestMapish || best;
  }

  function pinAtCanvasCenter() {
    const hit = findMapCanvas();
    if (!hit) return { ok: false, reason: 'no-canvas' };
    const r = hit.r;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let target = null;
    try {
      target = document.elementFromPoint(cx, cy);
    } catch (e) {}
    if (!target) target = hit.c;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window, button: 0 };
    try {
      ['mousedown', 'mouseup', 'click'].forEach((t) => target.dispatchEvent(new MouseEvent(t, opts)));
    } catch (e) {
      return { ok: false, reason: 'dispatch-fail' };
    }
    return { ok: true, kind: 'canvas-center', x: Math.round(cx), y: Math.round(cy), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function pickCoordMatches(lat, lng) {
    try {
      const coords = scanHookStates((st) => {
        if (!st || typeof st !== 'object') return null;
        const la = typeof st.lat === 'number' ? st.lat : typeof st.latitude === 'number' ? st.latitude : null;
        const ln = typeof st.lng === 'number' ? st.lng : typeof st.longitude === 'number' ? st.longitude : null;
        if (la == null || ln == null) return null;
        if (Object.keys(st).length > 6) return null;
        return { lat: la, lng: ln };
      }, 30000);
      return coords.some((c) => Math.abs(c.lat - lat) < 0.05 && Math.abs(c.lng - lng) < 0.05);
    } catch (e) {
      return false;
    }
  }

  function placeGuess(lat, lng) {
    const tried = [];
    const tryOne = (name, fn) => {
      let r = null;
      try {
        r = fn();
      } catch (e) {
        return null;
      }
      if (!r || !r.ok) return null;
      r.method = name;
      tried.push(name);
      // 关键：读回坐标验证，只有落在目标附近才算成功
      if (pickCoordMatches(lat, lng)) return Object.assign({}, r, { verified: true });
      return null;
    };
    let hit = tryOne('react-state', () => placeByReactState(lat, lng));
    if (hit) return hit;
    hit = tryOne('view-state', () => placeByViewState(lat, lng));
    if (hit) return hit;
    hit = tryOne('tile-click', () => placeByTiles(lat, lng));
    if (hit) return hit;
    mapState.tried = tried;
    const found = findGuessMap();
    if (!found) {
      const byApi = placeByPickApi(lat, lng);
      if (byApi.ok) return byApi;
      return { ok: false, error: 'no-map' };
    }
    const m = found.map;
    try {
      if (found.kind === 'maplibre') {
        const canvas = m.getCanvas();
        const rect = canvas.getBoundingClientRect();
        let pt = null;
        try {
          pt = m.project([lng, lat]);
        } catch (e) {}
        const inside = !!(pt && pt.x >= 0 && pt.y >= 0 && pt.x <= rect.width && pt.y <= rect.height);
        if (inside) {
          const ll = m.unproject([pt.x, pt.y]);
          fireMapClick(m, ll, pt);
          return { ok: true, kind: 'maplibre', moved: false, point: { x: Math.round(pt.x), y: Math.round(pt.y) } };
        }
        m.jumpTo({ center: [lng, lat] });
        const centerPt = { x: Math.round(rect.width / 2), y: Math.round(rect.height / 2) };
        setTimeout(() => {
          try {
            fireMapClick(m, m.getCenter(), centerPt);
          } catch (e) {}
        }, 450);
        return { ok: true, kind: 'maplibre', moved: true, point: centerPt };
      }
      if (found.kind === 'leaflet') {
        const c = m.getContainer ? m.getContainer() : null;
        const rect = c && c.getBoundingClientRect ? c.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
        const z = m.getZoom ? m.getZoom() : 4;
        let pt = null;
        try {
          pt = m.latLngToContainerPoint([lat, lng]);
        } catch (e) {}
        const inside = !!(pt && pt.x >= 0 && pt.y >= 0 && pt.x <= rect.width && pt.y <= rect.height);
        if (inside) {
          let ll = null;
          try {
            ll = m.unproject ? m.unproject(pt, z) : null;
          } catch (e) {}
          m.fire('click', { latlng: ll, containerPoint: pt });
          return { ok: true, kind: 'leaflet', moved: false, point: { x: Math.round(pt.x), y: Math.round(pt.y) } };
        }
        try {
          m.setView([lat, lng], z, { animate: false });
        } catch (e) {}
        return { ok: true, kind: 'leaflet', moved: true };
      }
      if (found.kind === 'generic') {
        const host = (m.getCanvas && m.getCanvas()) || (m.getContainer && m.getContainer()) || (m.getDiv && m.getDiv()) || null;
        try {
          if (typeof m.jumpTo === 'function') m.jumpTo({ center: [lng, lat] });
          else if (typeof m.setView === 'function') m.setView([lat, lng], m.getZoom ? m.getZoom() : 5, { animate: false });
          else if (typeof m.setCenter === 'function') m.setCenter([lng, lat]);
          else if (typeof m.centerAndZoom === 'function') m.centerAndZoom([lng, lat], m.getZoom ? m.getZoom() : 5);
        } catch (e) {}
        setTimeout(() => {
          try {
            if (host && host.getBoundingClientRect) {
              const r = host.getBoundingClientRect();
              const cx = r.left + r.width / 2;
              const cy = r.top + r.height / 2;
              const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window, button: 0 };
              ['mousedown', 'mouseup', 'click'].forEach((t) => host.dispatchEvent(new MouseEvent(t, opts)));
            }
            if (typeof m.fire === 'function') {
              const pt = { x: (host ? host.clientWidth : window.innerWidth) / 2, y: (host ? host.clientHeight : window.innerHeight) / 2 };
              m.fire('click', { lngLat: { lng, lat }, latlng: { lat, lng }, point: pt, containerPoint: pt });
            }
          } catch (e) {}
        }, 450);
        return { ok: true, kind: 'generic', moved: true };
      }
      // 任何带 setCenter/jumpTo/setView/centerAndZoom 的地图：先移过去，再在中心派发真实点击
      if (found.kind === 'generic' || found.kind === 'google' || found.kind === 'maplibre' || found.kind === 'leaflet') {
        // 已经在上面的分支处理过；这里只处理「有容器但没投影」的情况
      }
      if (found.kind === 'generic') {
        // 已在上面的 generic 分支处理
      }
      {
        const host = (m.getCanvas && m.getCanvas()) || (m.getContainer && m.getContainer()) || (m.getDiv && m.getDiv()) || null;
        let moved = false;
        try {
          if (typeof m.jumpTo === 'function') { m.jumpTo({ center: [lng, lat] }); moved = true; }
          else if (typeof m.setView === 'function') { m.setView([lat, lng], m.getZoom ? m.getZoom() : 5, { animate: false }); moved = true; }
          else if (typeof m.setCenter === 'function') { m.setCenter({ lat, lng }); moved = true; }
          else if (typeof m.panTo === 'function') { m.panTo([lat, lng]); moved = true; }
          else if (typeof m.centerAndZoom === 'function') { m.centerAndZoom({ lng, lat }, m.getZoom ? m.getZoom() : 5); moved = true; }
        } catch (e) {}
        if (moved && host && host.getBoundingClientRect) {
          setTimeout(() => {
            try {
              const r = host.getBoundingClientRect();
              const cx = r.left + r.width / 2;
              const cy = r.top + r.height / 2;
              const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window, button: 0 };
              ['mousedown', 'mouseup', 'click'].forEach((t) => {
                host.dispatchEvent(new MouseEvent(t, opts));
              });
              if (typeof m.fire === 'function') {
                try { m.fire('click', { lngLat: { lng, lat }, latlng: { lat, lng }, point: { x: r.width / 2, y: r.height / 2 } }); } catch (e2) {}
              }
            } catch (e3) {}
          }, 450);
          return { ok: true, kind: 'center-click', moved: true };
        }
      }
      if (found.kind === 'google') {
        m.setCenter({ lat, lng });
        if (window.google && google.maps && google.maps.event) {
          google.maps.event.trigger(m, 'click', { latLng: new google.maps.LatLng(lat, lng) });
        }
        return { ok: true, kind: 'google', moved: true };
      }
      return { ok: false, error: 'unsupported-map', tried };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  function hookOff() {
    state.hookOff = true;
    try {
      const g = window.google;
      if (g && g.maps) {
        if (state.origSVP) {
          Object.defineProperty(g.maps, 'StreetViewPanorama', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: state.origSVP,
          });
        }
        Object.defineProperty(g, 'maps', { configurable: true, enumerable: true, writable: true, value: g.maps });
      }
      if (g) Object.defineProperty(window, 'google', { configurable: true, enumerable: true, writable: true, value: g });
      if (state.origWS) window.WebSocket = state.origWS;
    } catch (e) {}
    return { ok: true, off: true };
  }

  function streetViewCanvas() {
    const inst = findPano();
    let root = null;
    try {
      root = inst && inst.getDiv ? inst.getDiv() : null;
    } catch (e) {}
    const scope = root && root.querySelectorAll ? root : document;
    let best = null;
    const scan = (list) => {
      for (const c of list) {
        const w = c.width || c.clientWidth || 0;
        const hh = c.height || c.clientHeight || 0;
        if (w * hh < 40000) continue;
        if (!best || w * hh > best.w * best.h) best = { c, w, h: hh };
      }
    };
    scan(scope.querySelectorAll('canvas'));
    if (!best) scan(document.querySelectorAll('canvas'));
    return best;
  }

  function grabCanvas() {
    const best = streetViewCanvas();
    if (!best) return { ok: false, reason: 'no-canvas', canvases: document.querySelectorAll('canvas').length };
    const out = { ok: true, w: best.w, h: best.h };
    // WebGL 画布如果没有 preserveDrawingBuffer，直接 toDataURL 会得到纯黑；
    // 再试一次「用 2D canvas drawImage 复制合成层」，两条路都交给内容脚本做亮度校验。
    try {
      out.dataUrl = best.c.toDataURL('image/jpeg', 0.9);
    } catch (e) {
      out.directError = String(e && e.message ? e.message : e);
    }
    try {
      const cv = document.createElement('canvas');
      cv.width = best.w;
      cv.height = best.h;
      const g = cv.getContext('2d');
      g.drawImage(best.c, 0, 0, best.w, best.h);
      out.altUrl = cv.toDataURL('image/jpeg', 0.9);
    } catch (e) {
      out.copyError = String(e && e.message ? e.message : e);
    }
    if (!out.dataUrl && !out.altUrl) {
      out.ok = false;
      out.reason = 'tainted';
    }
    return out;
  }

  function diag() {
    let cv = null;
    try {
      const b = streetViewCanvas();
      cv = b ? { w: b.w, h: b.h } : null;
    } catch (e) {}
    let gm = null;
    let svp = null;
    try {
      gm = !!(window.google && window.google.maps);
      svp = !!(gm && window.google.maps.StreetViewPanorama);
    } catch (e) {}
    return {
      ok: true,
      top: window.top === window,
      url: location.href,
      google: gm,
      svp: svp,
      wrapped: state.wrapped,
      hasInstance: !!state.inst,
      panoId: state.inst && state.inst.getPano ? state.inst.getPano() : null,
      iframes: document.querySelectorAll('iframe').length,
      iframeSrcs: Array.from(document.querySelectorAll('iframe')).slice(0, 5).map((f) => f.src || ''),
      canvases: document.querySelectorAll('canvas').length,
      canvas: cv,
      pickStates: (function () {
        try {
          return scanHookStates((st) => {
            if (!st || typeof st !== 'object' || Object.keys(st).length > 6) return null;
            const la = typeof st.lat === 'number' ? st.lat : typeof st.latitude === 'number' ? st.latitude : null;
            const ln = typeof st.lng === 'number' ? st.lng : typeof st.longitude === 'number' ? st.longitude : null;
            return la != null && ln != null ? st : null;
          }, 30000).length;
        } catch (e) { return -1; }
      })(),
      viewStates: (function () {
        try { return findMapViewStates().length; } catch (e) { return -1; }
      })(),
      reactRoots: (function () { try { return reactRoots().length; } catch (e) { return -1; } })(),
      tileImgs: (function () {
        try {
          return Array.from(document.images || []).filter((im) => /getTile|maprastertile|dbankcdn/.test(im.src || '')).length;
        } catch (e) {
          return -1;
        }
      })(),
      pickApi: (function () {
        try {
          const p = findPickApi();
          return p ? { found: true, keys: p.keys } : { found: false };
        } catch (e) {
          return { found: false };
        }
      })(),
      guessMap: (function () {
        try {
          const r = guessMapReport();
          if (r.found) return r;
        } catch (e) {}
        try {
          const m = findGuessMap();
          if (!m) return { found: false };
          const mm = m.map || {};
          const methods = Object.keys(mm).filter((k) => { try { return typeof mm[k] === 'function'; } catch (e) { return false; } }).slice(0, 14);
          return { kind: m.kind, found: true, methods };
        } catch (e) {
          return { found: false, error: String(e) };
        }
      })(),
    };
  }

  function handle(cmd, payload) {
    switch (cmd) {
      case 'state':
        return getState();
      case 'setPov':
        return setPov(payload && payload.heading, payload && payload.pitch, payload && payload.zoom);
      case 'ws':
        return { ok: true, messages: wsLog.slice(-60) };
      case 'deep-on':
        return installDeep();
      case 'canvas':
        return grabCanvas();
      case 'hook-off':
        return hookOff();
      case 'diag':
        return diag();
      case 'map-info':
        return mapInfo();
      case 'pin-center':
        return pinAtCanvasCenter();
      case 'place-guess':
        return placeGuess(payload && payload.lat, payload && payload.lng);
      case 'clearWs':
        wsLog.length = 0;
        return { ok: true };
      default:
        return { ok: false, error: 'unknown-cmd' };
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__txai !== 'req' || typeof d.id !== 'number') return;
    let res;
    try {
      res = handle(d.cmd, d.payload) || { ok: false };
    } catch (e) {
      res = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    try {
      window.postMessage(Object.assign({ __txai: 'res', id: d.id }, res), '*');
    } catch (e) {
      /* ignore */
    }
  });

  // 给内容脚本一个调试入口
  window.__TXAI_DEBUG__ = { getState, setPov, wsLog, mapInfo, placeGuess, findGuessMap, pinAtCanvasCenter, findMapCanvas };
})();
