/**
 * 图寻 AI 助手 —— 后台 Service Worker
 *
 * 职责：
 *  1. 屏幕截图（chrome.tabs.captureVisibleTab）+ 按街景容器裁剪、压缩；
 *  2. 调用 DeepSeek 视觉模型，让 AI 看图猜坐标、给证据链、给教学；
 *  3. 用本地「GeoGuessr 线索库」（Plonk It 社区指南压缩而成）对初判做一次复核 / 修正；
 *  4. 保存设置（API Key、模型、截图张数等）。
 *
 * 说明：截图 API 需要 <all_urls> 或 activeTab 权限。本扩展使用 activeTab：
 *      在 tuxun.fun 页面上点一下工具栏图标即可授权（每次整页刷新后需再点一次）。
 */

// 线索库：self.__TX_GEO_META__ = { rules, countries: { RO: { n, z, c, t:[{tag, tips[]}] } } }
try {
  importScripts('geo-meta.js');
} catch (e) {
  console.warn('[图寻AI] 线索库加载失败', e);
}

const DEFAULT_SETTINGS = {
  // 预填了本机 ~/.claude 里已有的 DeepSeek Key，方便开箱即用；可在悬浮窗设置里替换。
  apiKey: '', // 填写你自己的 DeepSeek API Key，或安装后在「设置」里填
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',        // 支持图片输入；deepseek-v4-pro 是纯文本模型
  profile: 'fast',                // fast | balanced | quality
  frames: 3,                      // 360° 截几张（fast 档默认 3 张，120° 一张）
  settleMs: 600,                  // 转动视角后等待瓦片加载
  effort: 'low',                  // 推理强度：low 更省更快，high 更慢更贵
  maxTokens: 1600,                // 单次回答上限（含推理 token）
  maxWidth: 700,                  // 发给 AI 前每张图的最大宽度（越小越快）
  rounds: 20,                     // 对战回合数
  mapSizeKm: 14916.862,           // GeoGuessr 世界地图尺寸，用于算分
  metaReview: true,               // 用线索库复核初判（默认开）
  autoPin: true,                  // 出结果后自动在图寻猜点地图上打点
  language: 'zh',
};

const SCHEMA_VERSION = 1;

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(['settings', 'schemaVersion']);
  // 老版本升级：没有 profile 字段时，套用新的「快速档」默认值（保留用户填的 Key）
  if (cur.settings && !cur.settings.profile) {
    const keepKey = cur.settings.apiKey || DEFAULT_SETTINGS.apiKey;
    await chrome.storage.local.set({ settings: Object.assign({}, DEFAULT_SETTINGS, { apiKey: keepKey }) });
    return;
  }
  if (!cur.schemaVersion) {
    await chrome.storage.local.set({
      settings: Object.assign({}, DEFAULT_SETTINGS, cur.settings || {}),
      schemaVersion: SCHEMA_VERSION,
    });
  } else if (cur.settings) {
    await chrome.storage.local.set({
      settings: Object.assign({}, DEFAULT_SETTINGS, cur.settings),
    });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  // 点击工具栏图标 = 用户手势，Chrome/Edge 会因此给这个标签页授予 activeTab（截图权限）
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'action-clicked' });
  } catch (e) {
    // 页面在扩展安装/刷新前就打开了：手动补注入一次
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/hook.js'],
        world: 'MAIN',
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content.js'],
      });
      await new Promise((r) => setTimeout(r, 300));
      await chrome.tabs.sendMessage(tab.id, { type: 'action-clicked' });
    } catch (err) {
      console.warn('[图寻AI] 注入失败', err);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = Object.assign({}, cur, patch || {});
  await chrome.storage.local.set({ settings: next });
  return next;
}

/* ------------------------------------------------------------------ */
/* 截图 + 裁剪                                                         */
/* ------------------------------------------------------------------ */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function cropAndEncode(fullDataUrl, rect, viewport, maxWidth) {
  const resp = await fetch(fullDataUrl);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);

  const vw = (viewport && viewport.w) || bmp.width;
  const vh = (viewport && viewport.h) || bmp.height;
  const scale = bmp.width / vw;

  let x = 0;
  let y = 0;
  let w = bmp.width;
  let h = bmp.height;
  if (rect && rect.w > 10 && rect.h > 10) {
    x = Math.round(Math.max(0, rect.x) * scale);
    y = Math.round(Math.max(0, rect.y) * scale);
    w = Math.round(Math.min(vw - Math.max(0, rect.x), rect.w) * scale);
    h = Math.round(Math.min(vh - Math.max(0, rect.y), rect.h) * scale);
    if (x + w > bmp.width) w = bmp.width - x;
    if (y + h > bmp.height) h = bmp.height - y;
  }
  if (w <= 8 || h <= 8) {
    x = 0;
    y = 0;
    w = bmp.width;
    h = bmp.height;
  }

  const outW = Math.max(1, Math.min(maxWidth || 1024, w));
  const outH = Math.max(1, Math.round((h * outW) / w));

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, x, y, w, h, 0, 0, outW, outH);
  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  try {
    bmp.close && bmp.close();
  } catch (e) {}
  return blobToDataUrl(outBlob);
}

async function shrinkDataUrl(dataUrl, maxW) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const w = Math.min(maxW || 512, bmp.width);
    const h = Math.round((bmp.height / bmp.width) * w);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    try { bmp.close && bmp.close(); } catch (e) {}
    return await blobToDataUrl(out);
  } catch (e) {
    return dataUrl;
  }
}

async function captureForTab(windowId, rect, viewport) {
  const settings = await getSettings();
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: 'jpeg',
    quality: 92,
  });
  const cropped = await cropAndEncode(dataUrl, rect, viewport, settings.maxWidth);
  return cropped;
}

/* ------------------------------------------------------------------ */
/* DeepSeek 调用                                                       */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = [
  '你是《图寻》(GeoGuessr) 的世界顶级玩家，同时也是最会教新手的教练。',
  '用户会把同一地点、不同朝向的若干张街景截图给你（合起来接近 360°）。',
  '你的任务：判断这个点位在地球上的真实位置，讲清依据，并把可复用的判断方法教给用户。',
  '',
  '硬性要求：',
  '1. 只依据图片里真实可见的信息推断；不确定就把 confidence 调低，不要硬猜。',
  '2. lat/lng 必须是“这个点位”的估计坐标（精确到城市/街道级别），不要用国家中心点。',
  '3. clues 每条都要写“看到了什么”（see）和“它说明了什么”（why），必须具体到图里的细节。',
  '4. teaching 要像教练带新手：给出可迁移到其它点位的口诀（如：看车牌、看路牌字体、看电线杆、看植被、看阳光方向、看道路标线）。',
  '5. 只输出一个 JSON 对象，不要输出 Markdown 代码块、不要输出任何 JSON 之外的文字。',
].join('\n');

function buildUserPrompt(frameCount, compact) {
  if (compact) {
    return [
      `这是同一个地点 ${frameCount} 个朝向的街景截图（接近 360°）。`,
      '请尽快判断位置，严格输出 JSON（不要 Markdown）：',
      '{',
      '  "country": "中文国名", "countryEn": "英文国名", "countryCode": "ISO2",',
      '  "continent": "Asia|Europe|Africa|North America|South America|Oceania|Antarctica",',
      '  "region": "省/州/城市", "lat": 数字, "lng": 数字, "confidence": 0到1, "summary": "一句话",',
      '  "clues": [{"kind":"车牌|路牌|文字|植被|地形|建筑|道路|其它","see":"看到的细节","why":"说明什么"}],',
      '  "steps": [{"level":"hemisphere","conclusion":"","evidence":""},{"level":"continent","conclusion":"","evidence":""},{"level":"country","conclusion":"","evidence":""},{"level":"place","conclusion":"","evidence":""}],',
      '  "teaching": "2-3 条口诀（简短）"',
      '}',
      'clues 给 2-4 条即可；steps 每级一句话。',
    ].join('\n');
  }

  return [
    `这是同一个地点 ${frameCount} 个朝向的街景截图（相当于原地环视 360°）。`,
    '请综合所有方向的信息判断位置，并严格按下面结构输出 JSON：',
    '{',
    '  "country": "国家或地区（中文）",',
    '  "countryEn": "国家英文名",',
    '  "countryCode": "ISO 3166-1 两位国家代码，如 RO / FR / JP",',
    '  "continent": "Asia | Europe | Africa | North America | South America | Oceania | Antarctica 之一（必须用英文）",',
    '  "region": "省/州/城市，尽量精确，不确定可留空字符串",',
    '  "lat": 数字, "lng": 数字,',
    '  "confidence": 0 到 1 的数字,',
    '  "summary": "一句话结论",',
    '  "steps": [',
    '    {"level": "hemisphere", "conclusion": "先定半球（如 北半球、东半球）", "evidence": "依据"},',
    '    {"level": "continent", "conclusion": "大洲", "evidence": "依据"},',
    '    {"level": "country", "conclusion": "国家", "evidence": "依据"},',
    '    {"level": "place", "conclusion": "具体到城市/区域", "evidence": "依据"}',
    '  ],',
    '  "clues": [{"kind": "车牌|路牌|文字|语言|植被|地形|建筑|道路|车辆|阳光|其它", "see": "图里看到的细节", "why": "它说明什么"}],',
    '  "teaching": "3-5 条新手可以直接复用的判断口诀",',
    '  "alternatives": [{"place": "备选地点", "reason": "为什么可能", "weight": 0 到 1}]',
    '}',
    '',
    'steps 必须严格按「半球 → 大洲 → 国家 → 具体位置」四级排除，每级都要写图里看到的依据；',
    '这份 steps 会直接驱动一个地图动画：先标半球，再缩到大洲、国家，最后落到具体点位。',
    '如果你觉得证据只够猜到国家，也请给出一个国家内的合理坐标，并在 teaching 里说明“这题只敢下到国家级”。',
  ].join('\n');
}

async function callDeepSeek(settings, messages, maxTokens) {
  if (!settings.apiKey) throw new Error('还没有填写 DeepSeek API Key');
  const url = `${String(settings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/v1/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model || 'deepseek-flash',
        messages,
        temperature: 0.2,
        max_tokens: maxTokens || Number(settings.maxTokens) || 4000,
        ...(settings.effort ? { reasoning_effort: settings.effort } : {}),
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* ignore */
  }
  if (!resp.ok) {
    const msg = (json && json.error && (json.error.message || json.error.type)) || text.slice(0, 300);
    throw new Error(`DeepSeek 接口 ${resp.status}: ${msg}`);
  }
  const choice = json && json.choices && json.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (!content) {
    if (choice && choice.finish_reason === 'length') {
      throw new Error('AI 输出被截断了（推理太长）。把「推理强度」改成 low，或把「最大输出 token」调大后再试。');
    }
    throw new Error('DeepSeek 没有返回内容');
  }
  return {
    content,
    reasoning: (choice.message && choice.message.reasoning_content) || '',
    usage: json.usage || null,
  };
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  const candidate = s.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    return null;
  }
}

function normalizeGuess(obj) {
  const out = {
    country: '',
    countryEn: '',
    countryCode: '',
    continent: '',
    region: '',
    lat: null,
    lng: null,
    confidence: null,
    summary: '',
    steps: [],
    clues: [],
    teaching: '',
    alternatives: [],
  };
  if (!obj || typeof obj !== 'object') return out;
  out.country = String(obj.country || obj.countryName || '').trim();
  out.countryEn = String(obj.countryEn || obj.countryNameEn || '').trim();
  out.countryCode = String(obj.countryCode || obj.iso2 || obj.iso || '').trim().toUpperCase().slice(0, 3);
  out.continent = String(obj.continent || '').trim();
  out.region = String(obj.region || obj.city || obj.province || '').trim();
  const lat = Number(obj.lat != null ? obj.lat : obj.latitude);
  const lng = Number(obj.lng != null ? obj.lng : obj.longitude);
  if (isFinite(lat) && lat >= -90 && lat <= 90) out.lat = lat;
  if (isFinite(lng) && lng >= -180 && lng <= 180) out.lng = lng;
  const conf = Number(obj.confidence);
  out.confidence = isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null;
  out.summary = String(obj.summary || '').trim();
  out.teaching = String(obj.teaching || '').trim();
  if (Array.isArray(obj.steps)) {
    out.steps = obj.steps
      .filter((s) => s && s.level)
      .slice(0, 6)
      .map((s) => ({
        level: String(s.level).slice(0, 16),
        conclusion: String(s.conclusion || s.result || s.answer || '').slice(0, 100),
        evidence: String(s.evidence || s.why || s.reason || '').slice(0, 200),
      }));
  }
  if (Array.isArray(obj.clues)) {
    out.clues = obj.clues
      .filter((c) => c && (c.see || c.text))
      .slice(0, 10)
      .map((c) => ({
        kind: String(c.kind || c.type || '其它').slice(0, 12),
        see: String(c.see || c.text || '').slice(0, 200),
        why: String(c.why || c.reason || '').slice(0, 200),
      }));
  }
  if (Array.isArray(obj.alternatives)) {
    out.alternatives = obj.alternatives
      .filter((a) => a && a.place)
      .slice(0, 5)
      .map((a) => ({
        place: String(a.place).slice(0, 60),
        reason: String(a.reason || '').slice(0, 160),
        weight: isFinite(Number(a.weight)) ? Math.max(0, Math.min(1, Number(a.weight))) : null,
      }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 线索库（Plonk It 社区指南）复核                                       */
/* ------------------------------------------------------------------ */

function getMeta() {
  try {
    return self.__TX_GEO_META__ || null;
  } catch (e) {
    return null;
  }
}

function metaForCountry(code, nameEn) {
  const meta = getMeta();
  if (!meta) return null;
  const countries = meta.countries || {};
  if (code) {
    const hit = countries[String(code).toUpperCase()];
    if (hit) return hit;
  }
  if (nameEn) {
    const k = String(nameEn).toLowerCase();
    for (const key of Object.keys(countries)) {
      const c = countries[key];
      if ((c.n || '').toLowerCase() === k) return c;
    }
  }
  return null;
}

function metaBrief(country, detailed) {
  if (!country) return '';
  const lines = [];
  for (const g of country.t || []) {
    const tips = (g.tips || []).slice(0, detailed ? 2 : 1).join(' ');
    if (tips) lines.push(`- ${g.tag}: ${tips.slice(0, detailed ? 360 : 220)}`);
  }
  return lines.slice(0, detailed ? 7 : 5).join('\n');
}

const REVIEW_SYSTEM = [
  '你是 GeoGuessr / 图寻 的复审员。第一步已经根据图片给出初步判断；现在给你这个国家的「本地线索库」，',
  '请把图里的细节和线索库逐条对照，判断初判是否成立，并在必要时修正国家/坐标。',
  '要求：1) 只依据图和线索库，不要编造；2) 如果线索库里的特征在图中明显矛盾，verdict 用 adjust 并给出更合理的国家和坐标；',
  '3) 如果吻合，verdict 用 agree，可比初判略微提高 confidence；4) 只输出一个 JSON 对象，不要 Markdown。',
].join('\n');

async function reviewWithMeta(settings, guess, country, imageUrl) {
  const detailed = settings.profile && settings.profile !== 'fast';
  const brief = metaBrief(country, detailed);
  if (imageUrl) imageUrl = await shrinkDataUrl(imageUrl, detailed ? 768 : 512);
  if (!brief) return null;
  const text = [
    `初判：国家 ${guess.country || guess.countryEn ||guess.countryCode}（代码 ${guess.countryCode || '?'}），地区 ${guess.region || '未知'}，坐标 ${guess.lat}, ${guess.lng}，置信度 ${guess.confidence}`,
    '',
    `本地线索库（${country.z || country.n}，来自 Plonk It 社区指南节选）：`,
    brief,
    '',
    '请对照图片复核，输出 JSON：',
    '{"verdict":"agree|adjust","country":"中文国名","countryCode":"ISO2","region":"地区","lat":数字,"lng":数字,"confidence":0到1,',
    ' "matched":["图里符合的国家特征"],"mismatched":["图里不符合/矛盾的地方"],"reason":"一句话说明"}',
  ].join('\n');

  const content = [{ type: 'text', text }];
  if (imageUrl) content.push({ type: 'image_url', image_url: { url: imageUrl } });
  const out = await callDeepSeek(
    settings,
    [
      { role: 'system', content: REVIEW_SYSTEM },
      { role: 'user', content },
    ],
    detailed ? 1400 : 700,
  );
  const obj = extractJson(out.content);
  if (!obj) return null;

  const lat = Number(obj.lat != null ? obj.lat : obj.latitude);
  const lng = Number(obj.lng != null ? obj.lng : obj.longitude);
  const verdict = String(obj.verdict || '').toLowerCase() === 'adjust' ? 'adjust' : 'agree';
  const conf = Number(obj.confidence);
  return {
    verdict,
    country: String(obj.country || '').trim().slice(0, 40),
    countryCode: String(obj.countryCode || '').trim().toUpperCase().slice(0, 3),
    region: String(obj.region || '').trim().slice(0, 80),
    lat: isFinite(lat) && Math.abs(lat) <= 90 ? lat : null,
    lng: isFinite(lng) && Math.abs(lng) <= 180 ? lng : null,
    confidence: isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
    matched: Array.isArray(obj.matched) ? obj.matched.filter(Boolean).slice(0, 6).map((x) => String(x).slice(0, 120)) : [],
    mismatched: Array.isArray(obj.mismatched) ? obj.mismatched.filter(Boolean).slice(0, 6).map((x) => String(x).slice(0, 120)) : [],
    reason: String(obj.reason || obj.summary || '').slice(0, 240),
    sourceCountry: country.z || country.n || '',
  };
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return sendResponse({ ok: false, error: 'bad-message' });

      if (msg.type === 'ping') return sendResponse({ ok: true, pong: Date.now() });

      if (msg.type === 'get-settings') {
        const settings = await getSettings();
        return sendResponse({ ok: true, settings: maskSettings(settings) });
      }

      if (msg.type === 'save-settings') {
        const settings = await saveSettings(msg.patch || {});
        return sendResponse({ ok: true, settings: maskSettings(settings) });
      }

      if (msg.type === 'capture') {
        const windowId = sender.tab && sender.tab.windowId;
        if (!windowId) return sendResponse({ ok: false, error: 'no-window' });
        try {
          const dataUrl = await captureForTab(windowId, msg.rect, msg.viewport);
          return sendResponse({ ok: true, dataUrl });
        } catch (e) {
          const em = String((e && e.message) || e);
          const needActiveTab = /activeTab|cannot access|permission/i.test(em);
          return sendResponse({
            ok: false,
            error: em,
            needActiveTab,
            hint: needActiveTab
              ? '点一下浏览器工具栏里的「图寻 AI 助手」图标，给扩展截图授权，然后再试一次。'
              : '',
          });
        }
      }

      if (msg.type === 'inject-modules') {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || !tab.id) return sendResponse({ ok: false, error: 'no-tab' });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['src/world-data.js', 'src/map-anim.js'],
          });
          return sendResponse({ ok: true });
        } catch (e) {
          return sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      }

      if (msg.type === 'ask') {
        const settings = await getSettings();
        const images = Array.isArray(msg.images) ? msg.images.slice(0, 6) : [];
        if (!images.length) return sendResponse({ ok: false, error: '没有截图' });
        const compact = settings.profile === 'fast';
        const content = [{ type: 'text', text: buildUserPrompt(images.length, compact) }];
        images.forEach((url) => content.push({ type: 'image_url', image_url: { url } }));
        const messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ];
        const t0 = Date.now();
        let out = await callDeepSeek(settings, messages, Number(settings.maxTokens) || 4000);
        let obj = extractJson(out.content);
        // 输出被截断/没解析出 JSON：自动重试一次，给足 token
        if (!obj) {
          try {
            const retry = await callDeepSeek(settings, messages, Math.max(3200, Number(settings.maxTokens) || 3200));
            const obj2 = retry && extractJson(retry.content);
            if (obj2) {
              out = retry;
              obj = obj2;
            }
          } catch (e) {
            /* 重试失败就继续用第一次的原始输出 */
          }
        }
        // 还是没 JSON：从原文里抠经纬度兜底
        if (!obj && out && out.content) {
          const m = /"lat"\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]{0,120}?"lng"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(out.content);
          if (m) obj = { lat: Number(m[1]), lng: Number(m[2]), confidence: 0.3 };
        }
        const firstMs = Date.now() - t0;
        const guess = normalizeGuess(obj);
        return sendResponse({
          ok: true,
          guess,
          firstMs,
          raw: obj ? null : out.content,
          reasoning: out.reasoning,
          usage: out.usage,
        });
      }

      // 第二段：用线索库复核（异步，不阻塞第一屏结果）
      if (msg.type === 'meta-review') {
        const settings = await getSettings();
        if (settings.metaReview === false) return sendResponse({ ok: true, review: null, skipped: true });
        const guess = msg.guess || {};
        const country = metaForCountry(guess.countryCode, guess.countryEn || guess.country);
        if (!country) return sendResponse({ ok: true, review: null, skipped: true });
        const t0 = Date.now();
        try {
          const review = await reviewWithMeta(settings, guess, country, msg.image || null);
          return sendResponse({ ok: true, review, ms: Date.now() - t0 });
        } catch (e) {
          return sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      }

      if (msg.type === 'review') {
        const settings = await getSettings();
        const images = Array.isArray(msg.images) ? msg.images.slice(0, 2) : [];
        const content = [
          {
            type: 'text',
            text: [
              '复盘这一回合。',
              `真实地点：${msg.truth || '未知'}（坐标 ${msg.truthLat}, ${msg.truthLng}）`,
              `上一轮你的猜测：${msg.guess || '未知'}（坐标 ${msg.guessLat}, ${msg.guessLng}）`,
              `你们相距约 ${msg.distanceKm} km。`,
              '请用教练口吻回答：1) 你当时漏掉了哪些关键线索；2) 这个点位最有辨识度的 3 个特征；3) 下次遇到类似场景的 3 条可复用口诀。直接输出纯文本，不要 JSON。',
            ].join('\n'),
          },
        ];
        images.forEach((url) => content.push({ type: 'image_url', image_url: { url } }));
        const out = await callDeepSeek(
          settings,
          [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
          1200,
        );
        return sendResponse({ ok: true, text: out.content });
      }

      if (msg.type === 'test-key') {
        const settings = await getSettings();
        const out = await callDeepSeek(
          settings,
          [{ role: 'user', content: '只回复两个字：可用' }],
          20,
        );
        return sendResponse({ ok: true, text: out.content.slice(0, 40) });
      }

      return sendResponse({ ok: false, error: 'unknown-type' });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 保持消息通道
});

function maskSettings(settings) {
  const s = Object.assign({}, settings);
  if (s.apiKey) {
    s.apiKeyMasked = s.apiKey.length > 10 ? `${s.apiKey.slice(0, 6)}…${s.apiKey.slice(-4)}` : '***';
    s.hasKey = true;
  } else {
    s.hasKey = false;
  }
  delete s.apiKey;
  return s;
}
