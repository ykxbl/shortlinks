/**
 * 阿里云 ESA 边缘函数 — 短链接生成器
 * =======================================
 * 功能：
 *   GET  /:code         → 302 重定向到目标 URL（浏览器直接访问）
 *   POST /api/shorten   → 创建短链接
 *   POST /api/delete    → 手动消耗/删除短链接
 *
 * 密钥统一放在请求体（body.key）中。
 *
 * 使用前：
 *   1. 在 ESA 控制台创建 KV 命名空间（例如 shortlinks）
 *   2. 修改下方 SECRET_KEY 为你自己的密钥
 *   3. 部署此函数并绑定域名或路由
 */

// ==================== 配置 ====================

const SECRET_KEY = 'your-fixed-secret-key-here'; // ← 改成你自己的密钥
const KV_NAMESPACE = 'shortlinks';               // ← KV 命名空间（需先在控制台创建）
const SHORT_LENGTH = 8;                          // 短码长度
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';
const MAX_RETRY = 8;                             // 碰撞重试次数

// ==================== 工具函数 ====================

/**
 * 生成指定长度的随机短码，字符集为 \w
 * 优先使用 crypto.getRandomValues，降级到 Math.random
 */
function genCode(length) {
  const chars = CHARS;
  const clen = chars.length;
  let out = '';

  try {
    const buf = new Uint8Array(length);
    crypto.getRandomValues(buf);
    for (let i = 0; i < length; i++) {
      out += chars[buf[i] % clen];
    }
  } catch {
    // fallback: 安全降级（碰撞概率仍极低）
    for (let i = 0; i < length; i++) {
      out += chars[Math.floor(Math.random() * clen)];
    }
  }

  return out;
}

/**
 * JSON 响应快捷方法
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * 解析请求体（JSON 或 form-urlencoded）
 */
async function parseBody(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    return request.json();
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const t = await request.text();
    const p = new URLSearchParams(t);
    const obj = {};
    for (const [k, v] of p) obj[k] = v;
    return obj;
  }
  return null;
}

/**
 * 检查短码是否合法：\w{8}
 */
function isValidCode(s) {
  return /^\w{8}$/.test(s);
}

// ==================== 核心业务 ====================

async function handleRedirect(edgeKv, code) {
  const raw = await edgeKv.get(code, { type: 'text' });

  if (raw === undefined) {
    return json({ error: '短链接不存在' }, 404);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: '数据损坏' }, 500);
  }

  // 检查是否过期
  if (data.expiresAt && Date.now() > data.expiresAt) {
    return json({ error: '短链接已过期' }, 410);
  }

  // 302 临时重定向
  return Response.redirect(data.url, 302);
}

async function handleCreate(edgeKv, body, origin) {
  // 鉴权：密钥统一从请求体取
  if (!body.key || body.key !== SECRET_KEY) {
    return json({ error: '密钥无效' }, 403);
  }

  const longUrl = body.url;
  if (!longUrl) {
    return json({ error: '缺少 url 参数' }, 400);
  }

  // 校验 URL 格式
  try {
    new URL(longUrl);
  } catch {
    return json({ error: '无效的 URL 格式，需包含协议（http/https）' }, 400);
  }

  // TTL：秒数，0 或留空 = 永不过期
  let ttl = parseInt(body.ttl, 10);
  if (isNaN(ttl) || ttl < 0) ttl = 0;

  // 是否指定了自定义短码
  let code = body.code || '';

  if (code) {
    // 自定义短码
    if (!isValidCode(code)) {
      return json({ error: '自定义短码格式不合法，需为 \\w{8}' }, 400);
    }
    const exist = await edgeKv.get(code, { type: 'text' });
    if (exist !== undefined) {
      return json({ error: '该短码已被占用' }, 409);
    }
  } else {
    // 自动生成（带碰撞重试）
    for (let i = 0; i < MAX_RETRY; i++) {
      code = genCode(SHORT_LENGTH);
      const exist = await edgeKv.get(code, { type: 'text' });
      if (exist === undefined) break;
      code = '';
    }
    if (!code) {
      return json({ error: '生成短码失败，请重试' }, 500);
    }
  }

  // 写入 KV
  const record = {
    url: longUrl,
    createdAt: Date.now(),
    expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : null,
  };
  await edgeKv.put(code, JSON.stringify(record));

  const shortUrl = `${origin}/${code}`;

  return json(
    {
      ok: true,
      short: shortUrl,
      code,
      url: longUrl,
      ttl: ttl > 0 ? ttl : null,
      expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
    },
    201
  );
}

async function handleDelete(edgeKv, body) {
  // 鉴权：密钥统一从请求体取
  if (!body.key || body.key !== SECRET_KEY) {
    return json({ error: '密钥无效' }, 403);
  }

  const code = body.code;
  if (!code) {
    return json({ error: '缺少 code 参数' }, 400);
  }

  if (!isValidCode(code)) {
    return json({ error: '短码格式不合法，需为 \\w{8}' }, 400);
  }

  const raw = await edgeKv.get(code, { type: 'text' });
  if (raw === undefined) {
    return json({ error: '短链接不存在' }, 404);
  }

  await edgeKv.delete(code);

  return json({ ok: true, message: '短链接已删除', code });
}

// ==================== CORS 预检 ====================

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ==================== 路由入口 ====================

export default {
  async fetch(request) {
    const u = new URL(request.url);
    const path = u.pathname;
    const method = request.method.toUpperCase();

    // CORS 预检
    if (method === 'OPTIONS') return handleOptions();

    const edgeKv = new EdgeKV({ namespace: KV_NAMESPACE });

    try {
      // ---- GET /:code (浏览器重定向) ----
      const redirectMatch = path.match(/^\/(\w{8})$/);
      if (method === 'GET' && redirectMatch) {
        return handleRedirect(edgeKv, redirectMatch[1]);
      }

      // ---- POST /api/shorten (创建短链接) ----
      if (method === 'POST' && path === '/api/shorten') {
        const body = await parseBody(request);
        if (!body) return json({ error: '请求体解析失败，请使用 JSON' }, 400);
        return handleCreate(edgeKv, body, u.origin);
      }

      // ---- POST /api/delete (手动消耗) ----
      if (method === 'POST' && path === '/api/delete') {
        const body = await parseBody(request);
        if (!body) return json({ error: '请求体解析失败，请使用 JSON' }, 400);
        return handleDelete(edgeKv, body);
      }

      // ---- GET / (说明页) ----
      if (method === 'GET' && path === '/') {
        return json({
          service: '短链接生成器 (ESA Edge Function)',
          version: '1.0.0',
          endpoints: {
            'GET /:code': '302 重定向到目标 URL',
            'POST /api/shorten': '创建短链接 — body: { url, ttl?, code?, key }',
            'POST /api/delete': '手动删除短链接 — body: { code, key }',
          },
          note: 'ttl 单位为秒，0 或不传表示永不过期（仅手动消耗）',
        });
      }

      // 404
      return json({ error: 'Not Found' }, 404);
    } catch (err) {
      return json({ error: '服务器内部错误', message: err.message }, 500);
    }
  },
};
