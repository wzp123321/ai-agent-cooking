export const APP_NAME = '厨神小助'

export const APP_SUBTITLE = 'AI 烹饪智能体'

export const APP_DESC = '专业烹饪 AI 顾问'

export const BASE_URL = '/api'

export const HEALTH_CHECK_INTERVAL = 30_000

export const MAX_SESSION_TITLE_LENGTH = 20

export const QUICK_QUESTIONS = [
  '🍖 红烧肉怎么做才能入口即化？',
  '🥬 如何炒出脆嫩的蔬菜？',
  '🍜 家常番茄鸡蛋汤的做法',
  '🔪 切洋葱不流泪有什么技巧？',
  '🌶 川菜为什么那么辣？',
  '🥘 用冰箱剩余食材能做什么菜？',
] as const

export const WELCOME_TAGS = [
  { label: '🍜 菜谱推荐' },
  { label: '🔪 烹饪技法' },
  { label: '🥗 营养搭配' },
  { label: '🛒 食材选购' },
] as const

export const AGENT_OFFLINE_TIP = '⚠️ Agent 未连接，请先启动后端服务'

export const AGENT_ONLINE_PLACEHOLDER = '问我任何做菜相关的问题... (Enter 发送，Shift+Enter 换行)'

export const DISCLAIMER = '厨神小助可能会犯错，重要食品安全问题请以权威资料为准'

export const ERROR_MSG_AGENT_OFFLINE =
  '❌ 请求失败：Agent 服务未连接\n\n请检查 Agent 服务是否已启动（cd cooking-agent && npm run dev）。'

/**
 * ============================================================
 * 流式请求超时配置（双计时器模式）
 * ============================================================
 *
 * 背景：
 *   原 STREAM_TIMEOUT_MS 是「单次硬上限」（60 秒到点必中止），
 *   但实际生产中遇到两类不同的问题：
 *
 *   场景 A：流式回答已正常输出 5 分钟，因 max_tokens 限制没完结
 *          → 单计时器会过早误杀
 *
 *   场景 B：LLM 输出几行后进入"长沉默"（可能是 LLM 内部推理、网络抖动、
 *          或交互式工具 options 为空被 Agent 静默吞掉）
 *          → 用户看不到任何提示，体验是"卡住了"
 *
 * 双计时器设计：
 *
 *   ① HARD（硬上限，默认 120 秒）
 *      - 整个流式会话的最大生命周期
 *      - 防止 LLM 失控、Agent 死循环等"持续在做事但没成果"的场景
 *      - 到点必杀，无论是否有事件
 *
 *   ② INACTIVITY（静默超时，默认 30 秒）
 *      - 上次事件（chunk / tool / interactive）距今的最大间隔
 *      - 每个事件到达时自动重置
 *      - 保护"流已开始但再没新数据"的卡死场景
 *
 * 二者择先触发。详见 useConversation.ts / interactive-dialogue-deep-dive.md §10。
 */
export const STREAM_HARD_TIMEOUT_MS = 120_000

export const STREAM_INACTIVITY_MS = 30_000

export const STREAM_INACTIVITY_MESSAGE = 'AI 似乎卡住了，请稍后重试或重新提问。'

/**
 * 「对话卡住」深度检测：当流进入「已静默 + 已触发过工具调用」的状态超过此时间，
 * 主动显示"AI 卡住了"提示（无需等到 inactivity 30 秒满）。
 *
 * 设计动机：见 interactive-dialogue-deep-dive.md §10 边界场景 #2
 *   - LLM 调起 ask_user_choice 但 options:[] 被 parseInteractiveArgs 跳过
 *   - 流不会触发 interactive_request 事件，也不会再发 chunk
 *   - 用户等待 30 秒看到 inactivity 提示，期间没有任何反馈
 *   - 优化：一旦检测到「流静默 + 上一次事件是 tool_calls」，
 *           立即显示「卡住」提示，不必等满 30 秒
 */
export const STUCK_AFTER_TOOL_HINT_MS = 15_000