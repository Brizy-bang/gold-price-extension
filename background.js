// ===== 常量配置 =====
const ALARM_NAME = 'gold-refresh';
const POLL_MINUTES = 1;                  // 轮询周期（分钟），MV3 闹钟最短 30 秒
const JH_BACKOFF_MS = 5 * 60 * 1000;     // 金投接口限流（HTTP 666）后的退避时长
const HISTORY_MAX = 360;                 // 每个品种保留的历史点数（约 6 小时）

// 腾讯行情：hf_XAU 伦敦金（现货），whUSDCNY 美元人民币汇率，免 Referer
const TX_URL = 'https://qt.gtimg.cn/q=hf_XAU,whUSDCNY';
// 金投行情：需 Referer 头（由 DNR 规则注入），单请求批量返回
const JH_URL = 'https://api.jijinhao.com/quoteCenter/realTime.htm?codes=' +
  'JO_92233,JO_92232,JO_92229,JO_92230,' +
  'JO_71,JO_9753,JO_92226,JO_70,JO_73,JO_74,JO_9754,' +
  'JO_42660,JO_42657,JO_42653,JO_42625,JO_42646,JO_351126,JO_42634,JO_42632,JO_42638,JO_52678,JO_52670,' +
  'JO_78648,JO_78649,JO_78650,JO_321178,JO_78656,JO_94699,JO_346542,JO_346444,JO_346447,JO_346445,JO_351185,JO_351236';
// 新浪行情：金投限流时的兜底数据源（只覆盖金交所品种），同样需 Referer
const SINA_URL = 'https://hq.sinajs.cn/list=' +
  'gds_AU9999,gds_AUTD,gds_MAUTD,gds_AU9995,gds_AU100G,gds_PT9995,gds_AGTD';

// 金投代码 -> 内部键名（国际现货 / 上海金交所 / 品牌金饰 / 银行金条）
const JH_MAP = {
  JO_92233: 'xau',  JO_92232: 'xag', JO_92229: 'xpt', JO_92230: 'xpd',
  JO_71: 'au9999',  JO_9753: 'autd', JO_92226: 'mautd', JO_70: 'au9995',
  JO_73: 'au100g',  JO_74: 'pt9995', JO_9754: 'agtd',
  JO_42660: 'zdf',  JO_42657: 'lfx', JO_42653: 'zlf', JO_42625: 'zss',
  JO_42646: 'lf',   JO_351126: 'mjy', JO_42634: 'lm',  JO_42632: 'jzz',
  JO_42638: 'cb',   JO_52678: 'zds', JO_52670: 'chj',
  // 银行金条
  JO_78648: 'ccb',  JO_78649: 'boc', JO_78650: 'icbc', JO_321178: 'abc',
  JO_78656: 'pa',   JO_94699: 'spdb', JO_346542: 'psbc', JO_346444: 'bocom',
  JO_346447: 'cmbc', JO_346445: 'cmb', JO_351185: 'citic', JO_351236: 'cib'
};

// 新浪 gds 代码 -> 内部键名、单位与小数位（与金投对齐）
const SINA_MAP = {
  gds_AU9999: 'au9999', gds_AUTD: 'autd', gds_MAUTD: 'mautd',
  gds_AU9995: 'au9995', gds_AU100G: 'au100g', gds_PT9995: 'pt9995',
  gds_AGTD: 'agtd'
};
const SINA_META = { agtd: { unit: '元/千克', digits: 0 } };

const gbk = new TextDecoder('gbk');

// ===== 生命周期 =====
chrome.runtime.onInstalled.addListener(() => {
  ensureRefererRules();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
  refresh();
});
chrome.runtime.onStartup.addListener(() => {
  ensureRefererRules();
  refresh();
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM_NAME) refresh();
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'refresh') {
    refresh().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// SW 每次被唤醒都确保 DNR 规则存在（幂等，代价极小）
ensureRefererRules();
// 不再使用角标，清掉旧版本遗留的角标文字
chrome.action.setBadgeText({ text: '' });

// ===== Referer 注入（金投/新浪接口要求，仅限本扩展发起的请求）=====
function ensureRefererRules() {
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: 'https://quote.cngold.org/' }
          ]
        },
        condition: {
          urlFilter: '||api.jijinhao.com',
          resourceTypes: ['xmlhttprequest', 'other'],
          initiatorDomains: [chrome.runtime.id]
        }
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: 'https://finance.sina.com.cn/' }
          ]
        },
        condition: {
          urlFilter: '||hq.sinajs.cn',
          resourceTypes: ['xmlhttprequest', 'other'],
          initiatorDomains: [chrome.runtime.id]
        }
      }
    ]
  }).catch(e => console.warn('DNR 规则设置失败:', e));
}

// ===== 主刷新流程 =====
async function refresh() {
  const store = await chrome.storage.local.get(
    ['quotes', 'history', 'jhBackoffUntil']
  );
  const quotes = store.quotes || {};
  const history = store.history || {};
  const errors = {};

  // 1. 腾讯：国际现货金 + 美元汇率（免 Referer，每次必拉）
  try {
    const { xau, usdCny } = await fetchTencent();
    if (xau) {
      quotes.xau = xau;
      pushHistory(history, 'xau', xau.price);
    }
    if (usdCny) quotes.usdCny = usdCny;
  } catch (e) {
    errors.xau = String(e && e.message || e);
  }

  // 2. 金投：国内交易所品种 + 品牌金价（限流则退避并用新浪兜底）
  const now = Date.now();
  if (now >= (store.jhBackoffUntil || 0)) {
    try {
      const jh = await fetchJijinhao();
      if (!Object.keys(jh).length) throw new Error('金投返回空数据');
      for (const [k, v] of Object.entries(jh)) {
        quotes[k] = v;
        if (k === 'au9999' || k === 'autd') pushHistory(history, k, v.price);
      }
      await chrome.storage.local.set({ jhBackoffUntil: 0 });
    } catch (e) {
      errors.cn = String(e && e.message || e);
      await chrome.storage.local.set({ jhBackoffUntil: now + JH_BACKOFF_MS });
      try {
        const sina = await fetchSina();
        for (const [k, v] of Object.entries(sina)) {
          quotes[k] = v;
          pushHistory(history, k, v.price);
        }
        errors.sinaOk = true;
      } catch (e2) {
        errors.sina = String(e2 && e2.message || e2);
      }
    }
  }

  quotes.updatedAt = now;
  await chrome.storage.local.set({ quotes, history, errors });
}

// ===== 数据源：腾讯 =====
async function fetchTencent() {
  const res = await fetch(TX_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`腾讯行情 HTTP ${res.status}`);
  const text = gbk.decode(await res.arrayBuffer());
  const rateM = text.match(/v_whUSDCNY="([^"]*)"/);
  return {
    xau: parseHf(text, 'hf_XAU', '美元/盎司'),
    usdCny: rateM ? parseFloat(rateM[1].split('~')[3]) : null
  };
}

// 腾讯 hf_ 期货格式：现价,涨跌幅,?, ?,最高,最低,时间,昨结,今开,?, ?, ?,日期,名称
function parseHf(text, code, unit) {
  const m = text.match(new RegExp(`v_${code}="([^"]*)"`));
  if (!m || !m[1]) return null;
  const f = m[1].split(',');
  const price = +f[0];
  const prevClose = +f[7];
  return {
    name: f[13],
    price,
    prevClose,
    change: +(price - prevClose).toFixed(2),
    changePct: +f[1],
    open: +f[8],
    high: +f[4],
    low: +f[5],
    time: `${f[12]} ${f[6]}`,
    unit
  };
}

// ===== 数据源：金投 =====
async function fetchJijinhao() {
  const res = await fetch(JH_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`金投行情 HTTP ${res.status}`);
  const text = await res.text();
  // 响应格式：var quote_json = {...}
  const idx = text.indexOf('=');
  const data = JSON.parse(idx >= 0 ? text.slice(idx + 1) : text);
  const out = {};
  for (const [code, q] of Object.entries(data)) {
    const key = JH_MAP[code];
    if (!key || !q || typeof q !== 'object' || q.q63 == null) continue;
    out[key] = {
      name: q.showName,
      price: +q.q63,
      bid: +q.q5 || null,
      ask: +q.q6 || null,
      change: +q.q70,
      changePct: +q.q80,
      open: +q.q1,
      prevClose: +q.q2,
      high: +q.q3,
      low: +q.q4,
      time: q.time,
      unit: q.unit || '元/克',
      digits: q.digits == null ? 2 : q.digits
    };
  }
  return out;
}

// ===== 数据源：新浪（兜底）=====
// gds 格式：现价,?,买价,卖价,最高,最低,时间,昨收,今开,成交量,?, ?,日期,名称
async function fetchSina() {
  const res = await fetch(SINA_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`新浪行情 HTTP ${res.status}`);
  const text = gbk.decode(await res.arrayBuffer());
  const out = {};
  for (const [code, key] of Object.entries(SINA_MAP)) {
    const m = text.match(new RegExp(`hq_str_${code}="([^"]*)"`));
    if (!m || !m[1]) continue;
    const f = m[1].split(',');
    const price = +f[0];
    const prevClose = +f[7];
    const meta = SINA_META[key] || {};
    out[key] = {
      name: f[13],
      price,
      bid: +f[2] || null,
      ask: +f[3] || null,
      prevClose,
      change: +(price - prevClose).toFixed(2),
      changePct: +(((price - prevClose) / prevClose) * 100).toFixed(2),
      open: +f[8],
      high: +f[4],
      low: +f[5],
      time: `${f[12]} ${f[6]}`,
      unit: meta.unit || '元/克',
      digits: meta.digits == null ? 2 : meta.digits
    };
  }
  return out;
}

// ===== 历史数据（供弹窗迷你走势图）=====
function pushHistory(history, key, price) {
  if (!Number.isFinite(price)) return;
  const arr = history[key] || (history[key] = []);
  const t = Date.now();
  const last = arr[arr.length - 1];
  if (last && last.p === price) { last.t = t; return; }
  arr.push({ t, p: price });
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
}


