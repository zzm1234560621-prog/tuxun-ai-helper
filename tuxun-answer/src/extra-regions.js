/* 补充地区：世界地图数据里没有单列的常见图寻地区（只有外包框时按框识别） */
(() => {
  const W = window.__TX_WORLD__;
  if (!W || !W.countries) return;
  const has = new Set(W.countries.map((c) => c.i));
  const add = [
    { i: 'HK', n: 'Hong Kong', z: '中国香港', c: 'Asia', b: [113.82, 22.15, 114.45, 22.56] },
    { i: 'MO', n: 'Macau', z: '中国澳门', c: 'Asia', b: [113.52, 22.1, 113.6, 22.22] },
    { i: 'GU', n: 'Guam', z: '关岛', c: 'Oceania', b: [144.6, 13.2, 144.97, 13.7] },
    { i: 'MP', n: 'Northern Mariana Islands', z: '北马里亚纳群岛', c: 'Oceania', b: [145.1, 14.1, 145.8, 20.6] },
  ];
  for (const e of add) if (!has.has(e.i)) W.countries.push(e);
})();
