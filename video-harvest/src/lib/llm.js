// 大模型调用：OpenAI 兼容协议 + Anthropic。用户自带 baseURL / key / model。
// 与 ai-daily-intel 同源实现，保持两套插件行为一致。
import { joinEndpoint } from './util.js';

async function postJson(url, body, { headers = {}, timeoutMs = 120000, retries = 1 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctl.signal,
        credentials: 'omit',
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
      try {
        return { json: JSON.parse(text), text };
      } catch {
        throw new Error(`响应不是合法 JSON：${text.slice(0, 300)}`);
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries && e?.name !== 'AbortError') {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('网络错误');
}

export function buildRequest(settings, prompt, { jsonMode = false } = {}) {
  const llm = settings.llm || {};
  const provider = llm.provider || 'openai-compatible';

  if (provider === 'anthropic') {
    return {
      url: joinEndpoint(llm.baseURL || 'https://api.anthropic.com', '/messages'),
      headers: {
        'x-api-key': llm.apiKey || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model: llm.model,
        max_tokens: Math.min(Number(llm.maxTokens) || 2000, 8000),
        temperature: Number(llm.temperature) ?? 0.8,
        messages: [{ role: 'user', content: prompt }],
      },
    };
  }

  const body = {
    model: llm.model,
    temperature: Number(llm.temperature) ?? 0.8,
    max_tokens: Math.min(Number(llm.maxTokens) || 2000, 16000),
    stream: false,
    messages: [
      { role: 'system', content: '你是中文内容运营助手，只按要求输出 JSON，不输出多余文字。' },
      { role: 'user', content: prompt },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  return {
    url: joinEndpoint(llm.baseURL || 'https://api.openai.com/v1', '/chat/completions'),
    headers: { Authorization: `Bearer ${llm.apiKey || ''}` },
    body,
  };
}

export function pickText(provider, json) {
  if (!json) return '';
  if (provider === 'anthropic') {
    if (Array.isArray(json.content)) return json.content.map((p) => p?.text || '').join('\n').trim();
    return '';
  }
  const c = json.choices?.[0];
  return (c?.message?.content ?? c?.text ?? '').trim();
}

export async function callLLM(settings, prompt, opts = {}) {
  if (!settings.llm?.apiKey) throw new Error('未配置 API Key：请到「⑤ 设置」里填写，或点「快速导入」粘贴配置');
  if (!settings.llm?.model) throw new Error('未配置模型名');

  const provider = settings.llm.provider || 'openai-compatible';
  const req = buildRequest(settings, prompt, opts);
  const timeoutMs = Number(settings.llm.timeoutMs) || 120000;

  let out;
  try {
    out = await postJson(req.url, req.body, { headers: req.headers, timeoutMs, retries: 1 });
  } catch (e) {
    throw new Error(`调用模型失败：${e.message}\n（请求地址：${req.url}）`);
  }

  const text = pickText(provider, out.json);
  if (!text) throw new Error(`模型没有返回文本：${out.text.slice(0, 200)}`);

  const usage = out.json?.usage || null;
  const finishReason = provider === 'anthropic'
    ? (out.json?.stop_reason || '')
    : (out.json?.choices?.[0]?.finish_reason || '');
  return { text, url: req.url, usage, finishReason };
}

/** 测试连通性：返回实际请求地址，便于排查 404/401 */
export async function testLLM(settings) {
  const t0 = Date.now();
  const { text, url } = await callLLM({ ...settings, llm: { ...settings.llm, maxTokens: 64 } }, '只回复两个字：成功');
  return { ok: true, ms: Date.now() - t0, reply: text.slice(0, 100), url };
}

/** 拉取可用模型列表 */
export async function listModels(settings) {
  const base = String(settings.llm?.baseURL || '').replace(/\/+$/, '');
  let url;
  if (/\/chat\/completions$/.test(base)) url = base.replace(/\/chat\/completions$/, '/models');
  else if (/\/v1$/.test(base)) url = `${base}/models`;
  else url = `${base}/v1/models`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${settings.llm?.apiKey || ''}` },
      signal: ctl.signal,
      credentials: 'omit',
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, url };
    const json = JSON.parse(text);
    const ids = (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
    return { ok: true, url, models: ids };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e?.message || String(e), url };
  }
}
