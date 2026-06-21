/**
 * ============================================================
 * utils/tool-args.ts — 工具调用参数格式化工具
 * ============================================================
 *
 * 工具参数是 LLM 流式追加的 JSON 字符串，需要：
 *   - 解析：处理不完整 JSON、嵌套对象
 *   - 摘要：折叠态展示，避免长 JSON 撑爆气泡宽度
 *   - 完整：展开态展示 pretty-printed JSON
 */

/**
 * 解析并格式化工具参数（完整 JSON，展开态展示）。
 * 用 try-catch 兜底，解析失败时返回原始字符串。
 */
export const formatToolArgs = (raw: string): string => {
  if (!raw) return '(空参数)'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/**
 * 工具参数摘要（折叠态展示）。
 * 策略：截取 key=value 拼成简短列表。
 */
export const summarizeToolArgs = (raw: string): string => {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const parts = Object.entries(obj).map(([k, v]) => {
      const value = typeof v === 'string' ? v : JSON.stringify(v)
      const short = value.length > 16 ? value.slice(0, 16) + '…' : value
      return `${k}=${short}`
    })
    return parts.join(' · ')
  } catch {
    // 流式追加中 JSON 还不完整时，截前 24 字符作为占位
    return raw.length > 24 ? raw.slice(0, 24) + '…' : raw
  }
}
