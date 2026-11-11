/**
 * 模型发现 + 回退表。
 *
 * zfr-core 是一个本地 OpenAI 兼容网关（默认 http://127.0.0.1:18788/v1），
 * 上游模型由 zfr 自己从 OpenCode Zen / Kilo 拉。所以这里**不硬编码模型名**：
 * 优先问网关要 /v1/models，拿不到再用 ZFR_MODELS 环境变量里手动钉的列表。
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:18788/v1'
const DISCOVERY_TIMEOUT_MS = 3000

function positive(n) {
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 兼容各家 OpenAI-compatible 网关的长度字段：
 * OpenAI(max_output_tokens) / OpenRouter(top_provider.*) / vLLM(max_model_len)
 * / 自建(context / max_output)。
 */
function pickLimits(raw) {
  const top = raw?.top_provider || {}
  const context =
    positive(raw?.context_length) ??
    positive(raw?.max_context_length) ??
    positive(top?.context_length) ??
    positive(raw?.max_model_len) ??
    positive(raw?.context)
  const output =
    positive(raw?.max_output_tokens) ??
    positive(raw?.max_completion_tokens) ??
    positive(top?.max_completion_tokens) ??
    positive(raw?.max_output) ??
    positive(raw?.output)
  return { context, output }
}

/**
 * 把网关返回的一条模型记录转成 Magpie/OpenCode 的 provider.models 条目。
 * 返回 { id, entry } 或 null。
 */
export function toModelEntry(m) {
  if (!m || !m.id) return null
  const entry = { name: m.name || m.display_name || m.id }
  const { context, output } = pickLimits(m)
  const limit = {}
  if (context) limit.context = context
  if (output) limit.output = output
  if (Object.keys(limit).length) entry.limit = limit
  if (m.reasoning === true) entry.reasoning = true
  if (m.tool_call === true || m.function_calling === true) entry.tool_call = true
  if (m.attachment === true) entry.attachment = true
  if (Number.isFinite(m.temperature)) entry.temperature = m.temperature
  // 只透传已是 models.dev 形状的数字 cost，避免猜测单位
  if (m.cost && typeof m.cost === 'object') {
    const cost = {}
    for (const k of ['input', 'output', 'cache_read', 'cache_write']) {
      if (Number.isFinite(m.cost[k])) cost[k] = m.cost[k]
    }
    if (Object.keys(cost).length) entry.cost = cost
  }
  return { id: m.id, entry }
}

/**
 * 从 ZFR_MODELS="id1,id2:65536" 解析手动钉的模型表。
 * 末尾冒号 + 纯数字才算 context 长度——模型 id 本身可能带冒号
 * （如 kilo/qwen3:free），不能简单 split(':')。
 */
export function parseEnvModels(raw) {
  const out = {}
  for (const piece of String(raw || '').split(',')) {
    const s = piece.trim()
    if (!s) continue
    const i = s.lastIndexOf(':')
    const tail = i > 0 ? s.slice(i + 1).trim() : ''
    const hasCtx = /^\d+$/.test(tail)
    const key = (hasCtx ? s.slice(0, i) : s).trim()
    if (!key) continue
    const limit = Number.parseInt(hasCtx ? tail : '', 10)
    out[key] = Number.isFinite(limit) && limit > 0
      ? { name: key, limit: { context: limit, output: 8192 } }
      : { name: key }
  }
  return out
}

/**
 * GET {base}/models，3 秒超时，失败返回 null（调用方决定回退）。
 * 网关带 --api-key 时 /v1/models 也要认证，所以支持传 apiKey。
 */
export async function fetchModels(
  baseURL = DEFAULT_BASE_URL,
  { timeoutMs = DISCOVERY_TIMEOUT_MS, apiKey = process.env.ZFR_API_KEY } = {},
) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/models`
  const headers = { accept: 'application/json' }
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (key) headers.authorization = `Bearer ${key}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal, headers })
    if (!res.ok) return null
    const body = await res.json()
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const out = {}
    for (const m of list) {
      const hit = toModelEntry(m)
      if (hit) out[hit.id] = hit.entry
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 模型来源优先级：网关实时发现 > ZFR_MODELS 环境变量 > 空表。
 * 空表时 Magpie 会显示 provider 但没有模型，README 里写了怎么救。
 */
export async function resolveModels(baseURL, env = process.env) {
  const live = await fetchModels(baseURL, { apiKey: env.ZFR_API_KEY })
  if (live) return { models: live, source: 'gateway' }
  const pinned = parseEnvModels(env.ZFR_MODELS)
  if (Object.keys(pinned).length) return { models: pinned, source: 'env' }
  return { models: {}, source: 'none' }
}

/**
 * 网关健康探针，给 CLI / 自检用。
 */
export async function probeGateway(baseURL = DEFAULT_BASE_URL, { apiKey = process.env.ZFR_API_KEY } = {}) {
  const models = await fetchModels(baseURL, { apiKey })
  return { reachable: models !== null, baseURL, modelCount: models ? Object.keys(models).length : 0 }
}
