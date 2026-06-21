<script setup lang="ts">
/**
 * MarkdownContent — Markdown 渲染（带节流 + Mermaid 图表 + KaTeX 公式）
 *
 * 行为：
 *   - 流式更新时 60ms 节流，避免每收到一个 chunk 都重新解析 markdown
 *   - 流结束后立即同步解析
 *   - ```mermaid 代码块：流中显示"图表占位"骨架；流结束后调用 mermaid.render
 *   - $..$（行内）/ $$..$$（块级）数学公式：流中显示原始 LaTeX 源码；
 *     流结束后通过 KaTeX 渲染（动态 import，不进初始 bundle）
 */
import { onUnmounted, ref, watch, nextTick } from 'vue'
import { marked, type Tokens } from 'marked'
// mermaid / katex 都用 dynamic import：避免 ~1MB 的图表/公式引擎打进初始 bundle
import type mermaidType from 'mermaid'
import type katexType from 'katex'
type Mermaid = typeof mermaidType
type Katex = typeof katexType
let mermaidModule: Mermaid | null = null
let katexModule: Katex | null = null
let katexCssLoaded = false

const props = defineProps<{
  text: string
  streaming?: boolean
}>()

const rendered = ref<string>('')
let parseTimer: ReturnType<typeof setTimeout> | null = null
let lastParsedLength = 0

/** Mermaid 初始化（懒加载 + 单次） */
let mermaidInitOnce = false
const initMermaidOnce = (): void => {
  if (mermaidInitOnce) return
  mermaidModule!.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: 'inherit',
  })
  mermaidInitOnce = true
}

/** Mermaid 块 id 计数器（避免同页重复 id 冲突） */
let mermaidIdCounter = 0
/**
 * 暂存本次解析得到的 mermaid 源码：{ id -> source }
 *  - 流中不渲染（避免每个 chunk 都重渲 + SVG 被下次 parse 覆盖）
 *  - 流结束后统一调用 renderMermaid()
 */
const pendingMermaid = new Map<string, string>()

/** 暂存本次解析得到的数学公式：{ id -> { tex, displayMode } } */
let mathIdCounter = 0
const pendingMath = new Map<string, { tex: string; displayMode: boolean }>()

/** 解码 marked 转义后的 HTML 实体（mermaid 需要原始源码） */
const decodeHtmlEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(parseInt(dec, 10)))

// ─── 注册 marked 数学扩展（全局，一次）────────────────────────────────

marked.use({
  extensions: [
    {
      // 行内公式 $...$
      name: 'math',
      level: 'inline',
      start(src: string) {
        const idx = src.indexOf('$')
        return idx === -1 ? undefined : idx
      },
      tokenizer(src: string) {
        // 匹配 $...$ 但不匹配 $$...$$（块级由 mathBlock 处理）
        const match = /^\$([^\$\n]+?)\$/.exec(src)
        if (match && src[match[0].length] !== '$') {
          return {
            type: 'math',
            raw: match[0],
            text: match[1].trim(),
          }
        }
        return undefined
      },
      renderer(token: Tokens.Generic): string {
        const id = `math-${++mathIdCounter}`
        const tex = String(token.text ?? '').trim()
        pendingMath.set(id, { tex, displayMode: false })
        // 占位保留原始 LaTeX 源码：流中可读、流后被 katex 替换
        return `<span class="math-inline" data-math-id="${id}">$${tex}$</span>`
      },
    },
    {
      // 块级公式 $$...$$
      name: 'mathBlock',
      level: 'block',
      start(src: string) {
        // 仅在行首出现 $$ 时才考虑（避免段落中间误识别）
        return src.startsWith('$$') ? 0 : undefined
      },
      tokenizer(src: string) {
        const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src)
        if (match) {
          return {
            type: 'mathBlock',
            raw: match[0],
            text: match[1].trim(),
          }
        }
        return undefined
      },
      renderer(token: Tokens.Generic): string {
        const id = `math-${++mathIdCounter}`
        const tex = String(token.text ?? '').trim()
        pendingMath.set(id, { tex, displayMode: true })
        return `<div class="math-block" data-math-id="${id}">${tex}</div>`
      },
    },
  ],
})

// ─── 解析主流程 ───────────────────────────────────────────

const parseMarkdown = (): void => {
  const text = props.text
  if (!text) {
    rendered.value = ''
    lastParsedLength = 0
    pendingMermaid.clear()
    pendingMath.clear()
    return
  }
  const len = text.length
  if (len === lastParsedLength) return

  pendingMermaid.clear()
  pendingMath.clear()
  let html = marked.parse(text) as string

  // 把 ```mermaid 代码块替换为占位 div，源码暂存待流结束后渲染
  html = html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_, code: string) => {
      const id = `mmd-${++mermaidIdCounter}`
      pendingMermaid.set(id, decodeHtmlEntities(code))
      return `<div class="mermaid-block" data-mermaid-id="${id}">📊 图表占位…</div>`
    },
  )

  rendered.value = html
  lastParsedLength = len
}

const renderMermaid = async (): Promise<void> => {
  if (pendingMermaid.size === 0) return
  if (props.streaming) return // 流中不渲染
  if (!mermaidModule) {
    mermaidModule = (await import('mermaid')).default
  }
  initMermaidOnce()
  await nextTick()
  for (const [id, code] of pendingMermaid.entries()) {
    const el = document.querySelector(`[data-mermaid-id="${id}"]`) as HTMLElement | null
    if (!el) continue
    try {
      const { svg } = await mermaidModule.render(`${id}-svg`, code)
      el.innerHTML = svg
      el.classList.add('mermaid-rendered')
    } catch (err) {
      el.innerHTML = `<div class="mermaid-error">图表渲染失败：${(err as Error).message}</div>`
      console.error('[MarkdownContent] ❌ Mermaid 渲染失败：', err)
    }
  }
}

const renderMath = async (): Promise<void> => {
  if (pendingMath.size === 0) return
  if (props.streaming) return // 流中不渲染
  if (!katexModule) {
    // CSS 只需注入一次（Vite side-effect import）
    if (!katexCssLoaded) {
      await import('katex/dist/katex.min.css')
      katexCssLoaded = true
    }
    katexModule = (await import('katex')).default
  }
  await nextTick()
  for (const [id, { tex, displayMode }] of pendingMath.entries()) {
    const el = document.querySelector(`[data-math-id="${id}"]`) as HTMLElement | null
    if (!el) continue
    try {
      el.innerHTML = katexModule.renderToString(tex, {
        throwOnError: false,
        displayMode,
        output: 'html',
      })
      el.classList.add('math-rendered')
    } catch (err) {
      el.innerHTML = `<span class="math-error">公式渲染失败：${(err as Error).message}</span>`
      console.error('[MarkdownContent] ❌ KaTeX 渲染失败：', err)
    }
  }
}

/** 流结束后统一调用：mermaid + math */
const renderDynamic = async (): Promise<void> => {
  await Promise.all([renderMermaid(), renderMath()])
}

parseMarkdown()

watch(
  () => props.text,
  () => {
    if (props.streaming) {
      if (!parseTimer) {
        parseTimer = setTimeout(() => {
          parseTimer = null
          parseMarkdown()
        }, 60)
      }
    } else {
      if (parseTimer) {
        clearTimeout(parseTimer)
        parseTimer = null
      }
      parseMarkdown()
      void renderDynamic()
    }
  },
)

// 流结束（streaming 由 true → false）时强制重渲染：可能 text 长度没变但需要触发 mermaid/math
watch(
  () => props.streaming,
  (now, prev) => {
    if (prev === true && now === false) {
      if (parseTimer) {
        clearTimeout(parseTimer)
        parseTimer = null
      }
      // 强制重解析 + 渲染
      lastParsedLength = 0
      parseMarkdown()
      void renderDynamic()
    }
  },
)

onUnmounted(() => {
  if (parseTimer) clearTimeout(parseTimer)
})
</script>

<template>
  <div v-if="text" class="markdown-body" v-html="rendered" />
</template>

<style scoped>
.markdown-body {
  font-size: 14px;
  line-height: 1.65;
  color: var(--text-primary, #2d2d2d);
  word-break: break-word;
}

.markdown-body :deep(p) {
  margin: 0 0 8px;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 22px;
}
.markdown-body :deep(li) {
  margin: 2px 0;
}
.markdown-body :deep(code) {
  background: #f4f5f7;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 12.5px;
  font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
  color: #c0392b;
}
.markdown-body :deep(pre) {
  background: #1e1e2e;
  color: #e0e0e0;
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 12.5px;
  margin: 6px 0;
}
.markdown-body :deep(pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
}
.markdown-body :deep(a) {
  color: #c0651c;
  text-decoration: none;
  border-bottom: 1px dashed #f0a030;
}
.markdown-body :deep(a:hover) {
  border-bottom-style: solid;
}
.markdown-body :deep(strong) {
  font-weight: 600;
  color: #2d2d2d;
}
.markdown-body :deep(blockquote) {
  margin: 6px 0;
  padding: 4px 10px;
  border-left: 3px solid #f0a030;
  background: #fff8eb;
  color: #64748b;
  border-radius: 0 6px 6px 0;
}
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  margin: 10px 0 6px;
  font-weight: 600;
  line-height: 1.4;
}
.markdown-body :deep(h1) { font-size: 18px; }
.markdown-body :deep(h2) { font-size: 16px; }
.markdown-body :deep(h3) { font-size: 15px; }

/* ═══ Mermaid 图表容器 ═══ */
.markdown-body :deep(.mermaid-block) {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
  margin: 8px 0;
  padding: 16px;
  background: #fafbfc;
  border: 1px dashed #d6d8de;
  border-radius: 8px;
  color: #94a3b8;
  font-size: 13px;
  overflow-x: auto;
}
.markdown-body :deep(.mermaid-block.mermaid-rendered) {
  background: #fff;
  border: 1px solid #e5d5b5;
  border-style: solid;
  color: inherit;
  padding: 12px;
}
.markdown-body :deep(.mermaid-block.mermaid-rendered svg) {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;
}
.markdown-body :deep(.mermaid-error) {
  color: #c0392b;
  background: #fef5f3;
  border: 1px solid #f5c6c2;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12.5px;
  font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
}

/* ═══ KaTeX 公式容器 ═══ */
.markdown-body :deep(.math-inline) {
  display: inline-block;
  padding: 0 2px;
  font-family: 'KaTeX_Main', 'Times New Roman', serif;
  color: #2d2d2d;
  font-size: 0.95em;
  /* 渲染前显示原始 LaTeX（流中状态） */
  font-style: italic;
  color: #64748b;
}
.markdown-body :deep(.math-inline.math-rendered) {
  font-style: normal;
  color: inherit;
}
.markdown-body :deep(.math-block) {
  margin: 10px 0;
  padding: 8px 0;
  text-align: center;
  color: #64748b;
  font-style: italic;
  overflow-x: auto;
}
.markdown-body :deep(.math-block.math-rendered) {
  font-style: normal;
  color: inherit;
}
.markdown-body :deep(.math-error) {
  color: #c0392b;
  background: #fef5f3;
  border: 1px solid #f5c6c2;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
  font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
}
/* KaTeX 自身字体大小微调（与正文 14px 协调） */
.markdown-body :deep(.katex) {
  font-size: 1.05em;
}
.markdown-body :deep(.katex-display) {
  margin: 0.5em 0;
}
</style>
