const OZ_TO_G = 31.1034768;  // 金衡盎司换算克

// 国际现货展示顺序（美元/盎司）
const SPOT_ORDER = ['xau', 'xag', 'xpt', 'xpd'];
// 上海金交所品种展示顺序（白银T+D 为元/千克）
const EXCHANGE_ORDER = ['au9999', 'autd', 'agtd', 'pt9995', 'mautd', 'au9995', 'au100g'];
// 品牌金饰展示顺序
const BRAND_ORDER = ['zdf', 'lfx', 'zlf', 'zss', 'lf', 'mjy', 'lm', 'jzz', 'cb', 'zds', 'chj'];
// 行情品种名（金投/新浪名称不统一，统一用本地名）
const QUOTE_NAMES = {
  xau: '现货黄金', xag: '现货白银', xpt: '现货铂金', xpd: '现货钯金',
  au9999: '黄金9999', autd: '黄金T+D', mautd: 'm黄金T+D', au9995: '黄金9995',
  au100g: '金条100g', pt9995: '铂金9995', agtd: '白银T+D'
};
// 非“元/克”单位的品种需在名称下标注
const QUOTE_UNIT = { agtd: '元/千克' };
// 金投接口品牌品种的 showName 均为通用的“黄金价格”，需用代码映射回品牌名
const BRAND_NAMES = {
  zdf: '周大福', lfx: '老凤祥', zlf: '周六福', zss: '周生生', lf: '六福珠宝',
  mjy: '梦金园', lm: '老庙', jzz: '金至尊', cb: '菜百', zds: '周大生', chj: '潮宏基'
};
// 银行金条展示顺序：名称 + 产品副标题
const BANK_ORDER = ['ccb', 'boc', 'icbc', 'abc', 'pa', 'spdb', 'psbc', 'bocom', 'cmbc', 'cmb', 'citic', 'cib'];
const BANK_NAMES = {
  ccb: '建行', boc: '中行', icbc: '工行', abc: '农行', pa: '平安银行', spdb: '浦发银行',
  psbc: '邮储银行', bocom: '交通银行', cmbc: '民生银行', cmb: '招商银行', citic: '中信银行', cib: '兴业银行'
};
const BANK_SUB = {
  ccb: '龙鼎金条', boc: '金条·积存', icbc: '如意金条', abc: '传世之宝', pa: '和谐平安', spdb: '投资金条',
  psbc: '邮储金', bocom: '沃德金', cmbc: '投资金条', cmb: '招行金', citic: '中信金', cib: '兴业盛世金'
};

const $ = s => document.querySelector(s);

init();

async function init() {
  $('#refresh').addEventListener('click', async () => {
    $('#refresh').classList.add('loading');
    await chrome.runtime.sendMessage({ type: 'refresh' });
    $('#refresh').classList.remove('loading');
  });
  // storage 变化时重渲染（后台轮询更新后弹窗同步刷新）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.quotes || changes.history || changes.errors)) render();
  });
  render();
  // 打开弹窗时若数据超过 60 秒未更新则主动触发一次刷新
  const { quotes } = await chrome.storage.local.get('quotes');
  if (!quotes || !quotes.updatedAt || Date.now() - quotes.updatedAt > 60000) {
    chrome.runtime.sendMessage({ type: 'refresh' });
  }
}

async function render() {
  const { quotes, history, errors } = await chrome.storage.local.get(
    ['quotes', 'history', 'errors']
  );

  const updatedEl = $('#updated');
  if (!quotes || !quotes.updatedAt) {
    updatedEl.textContent = '加载中…';
    return;
  }
  updatedEl.textContent = fmtTime(quotes.updatedAt) + ' 更新';

  renderHero(quotes, history || {});
  renderTradeRows($('#spotRows'), SPOT_ORDER, quotes);
  renderTradeRows($('#exchangeRows'), EXCHANGE_ORDER, quotes);
  renderListRows($('#brandRows'), BRAND_ORDER, quotes, BRAND_NAMES);
  renderListRows($('#bankRows'), BANK_ORDER, quotes, BANK_NAMES, BANK_SUB);
}

// ===== 顶部双卡片 =====
function renderHero(quotes, history) {
  const xau = quotes.xau;
  const au = quotes.au9999;

  const xauCard = $('#cardXau');
  if (xau) {
    xauCard.querySelector('.card-price').textContent = fmt(xau.price, 2);
    setChg(xauCard.querySelector('.chg'), xau);
    const cnyEl = xauCard.querySelector('.cny');
    if (quotes.usdCny) {
      const perGram = xau.price * quotes.usdCny / OZ_TO_G;
      cnyEl.textContent = `≈${perGram.toFixed(1)} 元/克`;
    } else {
      cnyEl.textContent = '';
    }
  }
  drawSpark($('#sparkXau'), history.xau);

  const auCard = $('#cardAu');
  if (au) {
    auCard.querySelector('.card-price').textContent = fmt(au.price, au.digits ?? 2);
    setChg(auCard.querySelector('.chg'), au);
    auCard.querySelector('.cny').textContent = au.time ? '行情 ' + fmtQuoteTime(au.time) : '';
  }
  drawSpark($('#sparkAu'), history.au9999);
}

// ===== 行情行：卖出(bid) / 买入(ask) / 高低 =====
function renderTradeRows(container, order, quotes) {
  container.innerHTML = '';
  let has = false;
  for (const key of order) {
    const q = quotes[key];
    if (!q || !Number.isFinite(q.price)) continue;
    has = true;
    const d = q.digits ?? 2;
    const row = document.createElement('div');
    row.className = 'row';
    const unit = QUOTE_UNIT[key] ? `<em class="name-sub">${QUOTE_UNIT[key]}</em>` : '';
    row.innerHTML =
      `<span class="name">${esc(QUOTE_NAMES[key] || q.name || key)}${unit}</span>` +
      `<span class="ba">${fmtNum(q.bid, d)}</span>` +
      `<span class="ba">${fmtNum(q.ask, d)}</span>` +
      `<span class="hl"><i class="hi">${fmtNum(q.high, d)}</i><i class="lo">${fmtNum(q.low, d)}</i></span>`;
    container.appendChild(row);
  }
  if (!has) container.appendChild(emptyRow());
}

// ===== 品牌/银行行：名称(副标题) / 价格 / 涨跌 / 更新时间 =====
function renderListRows(container, order, quotes, names, subs) {
  container.innerHTML = '';
  let has = false;
  for (const key of order) {
    const q = quotes[key];
    if (!q || !Number.isFinite(q.price)) continue;
    has = true;
    const d = q.digits ?? 2;
    const row = document.createElement('div');
    row.className = 'row';
    const sub = subs && subs[key] ? `<em class="name-sub">${esc(subs[key])}</em>` : '';
    row.innerHTML =
      `<span class="name">${esc(names[key] || q.name || key)}${sub}</span>` +
      `<span class="price">${fmt(q.price, d)}</span>` +
      `<span class="chg ${dirClass(q.change)}">${fmtSigned(q.change, d)}</span>` +
      `<span class="b-time">${fmtDayTime(q.time)}</span>`;
    container.appendChild(row);
  }
  if (!has) container.appendChild(emptyRow());
}

function emptyRow() {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = '暂无数据';
  return d;
}

// ===== 迷你走势图 =====
function drawSpark(svg, points) {
  svg.innerHTML = '';
  if (!points || points.length < 2) return;
  const W = 320, H = 40, PAD = 2;
  const ps = points.slice(-120);
  const min = Math.min(...ps.map(p => p.p));
  const max = Math.max(...ps.map(p => p.p));
  const span = max - min || 1;
  const stepX = (W - PAD * 2) / (ps.length - 1);
  const xy = ps.map((p, i) =>
    `${(PAD + i * stepX).toFixed(1)},${(H - PAD - ((p.p - min) / span) * (H - PAD * 2)).toFixed(1)}`
  );
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', xy.join(' '));
  svg.appendChild(line);
  // 底部渐变填充区
  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  fill.setAttribute('class', 'fill');
  fill.setAttribute('points', `${PAD},${H} ` + xy.join(' ') + ` ${W - PAD},${H}`);
  svg.insertBefore(fill, line);
}

// ===== 工具函数 =====
function dirClass(v) {
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'flat';
}
function setChg(el, q) {
  const cls = dirClass(q.changePct);
  el.className = 'chg ' + cls;
  el.textContent = `${fmtSigned(q.change, q.digits ?? 2)} (${fmtSigned(q.changePct, 2)}%)`;
}
function fmt(v, d) {
  return Number.isFinite(v) ? v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '--';
}
function fmtNum(v, d) {
  return Number.isFinite(v) ? v.toFixed(d) : '--';
}
// 行情时间戳：当天显示 HH:mm，跨天显示 MM-dd HH:mm
function fmtDayTime(t) {
  const ts = typeof t === 'number' ? t : NaN;
  if (!Number.isFinite(ts)) return fmtQuoteTime(t) || '--';
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}
function fmtSigned(v, d) {
  if (!Number.isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + v.toFixed(d);
}
function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtQuoteTime(t) {
  // 金投返回毫秒时间戳；腾讯/新浪返回 "YYYY-MM-DD HH:MM:SS" 字符串
  if (typeof t === 'number') return fmtTime(t);
  if (typeof t === 'string' && t.length >= 16) return t.slice(11, 16);
  return '';
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
