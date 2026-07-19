import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult, ContinuationReverseExtractResult } from '../shared-types'

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function asNumber(value: unknown, fallback = 50): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

const handler: TaskHandler = {
  name: 'continuation-reverse-extract',
  outputType: 'json',
  defaultCapabilities: ['settings', 'chapters', 'worldview', 'characters', 'relations', 'outline'],
  maxSkills: 2,
  resolveMaxTokens() {
    return 8192
  },
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    const sampleBlock = String(context.sampleBlock ?? '')
    const maxCharacters = Number(context.maxCharacters ?? 12)
    const maxOutlineItems = Number(context.maxOutlineItems ?? 30)
    const maxWorldview = Number(context.maxWorldview ?? 12)
    const maxRelations = Number(context.maxRelations ?? 40)

    const chunkHint = context.chunkIndex
      ? `当前是分块通读第 ${String(context.chunkIndex)}/${String(context.totalChunks)} 块（约第${String(context.chapterFrom)}–${String(context.chapterTo)}章）。只基于本块正文归纳；主角若已在本块出现必须标出。`
      : '请基于给定材料归纳全书已发生设定。'

    return {
      system: `${capabilityPreamble.system}

你是「半成品小说设定反推」助手。用户已有正文，需要你从正文与章标中归纳设定，供后续续写使用。
硬性要求：
1. 只根据给定材料归纳「已经发生」的内容，禁止编造未在正文/标题中出现的未来主线。
2. 只返回 JSON，不要 Markdown 代码围栏或解释。
3. 角色、关系、世界观、大纲必须彼此自洽；关系两端姓名必须出现在 characters 中。
4. 大纲按剧情弧线聚合，不要一章一个节点；节点数量受上限约束。
5. **主角必须识别**：characters 数组第一项必须是主角（role 填「主角」）。主角通常是开篇核心行动者/被称呼姓名最稳定的主视角人物，禁止用龙套顶替。
6. 若信息不足，用 warnings 说明，仍尽量给出可编辑的草稿设定。
7. ${chunkHint}`,
      user: `${capabilityPreamble.user}

项目标题：${String(context.projectTitle ?? '')}
项目题材：${String(context.projectGenre ?? '')}
全书识别章数：${String(context.totalChapters ?? '')}
本块/采样说明：${String(context.sampledBodyCount ?? '')}

材料：
${sampleBlock || '（无）'}

输出上限：
- worldviewEntries ≤ ${maxWorldview}（type 只能是：地理 / 法则 / 物种 / 势力 / 历史）
- characters ≤ ${maxCharacters}（**第一项必须是主角**，其余为重要配角）
- characterRelationships ≤ ${maxRelations}（完整关系网：fromName/toName/type/description/intensity0-100）
- outlineVolumes ≤ 8
- outlineItems ≤ ${maxOutlineItems}（status 视为已发生；volumeTitle 对应 outlineVolumes.title；chapterFrom/chapterTo 为章号范围可选）

返回 JSON：
{
  "worldviewEntries":[{"type":"","title":"","content":""}],
  "characters":[{"name":"","role":"主角","description":"","tags":[]}],
  "characterRelationships":[{"fromName":"","toName":"","type":"","description":"","intensity":50}],
  "outlineVolumes":[{"title":"","summary":"","wordTarget":""}],
  "outlineItems":[{"volumeTitle":"","title":"","wordTarget":"","conflict":"","summary":"","chapterFrom":1,"chapterTo":10}],
  "warnings":[]
}`,
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw) as Partial<ContinuationReverseExtractResult>
    const worldviewEntries = Array.isArray(parsed.worldviewEntries)
      ? parsed.worldviewEntries.map((entry) => ({
          type: asString((entry as { type?: string }).type, '法则') || '法则',
          title: asString((entry as { title?: string }).title, '未命名设定'),
          content: asString((entry as { content?: string }).content, '待补充'),
        })).filter((entry) => entry.title && entry.content)
      : []
    const characters = Array.isArray(parsed.characters)
      ? parsed.characters.map((entry) => {
          const tags = Array.isArray((entry as { tags?: unknown }).tags)
            ? (entry as { tags: unknown[] }).tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 6)
            : []
          return {
            name: asString((entry as { name?: string }).name),
            role: asString((entry as { role?: string }).role, '重要角色'),
            description: asString((entry as { description?: string }).description),
            tags,
          }
        }).filter((entry) => {
          if (!entry.name || !entry.description) return false
          // 过滤模型占位名
          if (/^(未指定|未知|无名|某人|路人|待定|角色\d*)/.test(entry.name)) return false
          if (entry.name.length < 2) return false
          return true
        })
      : []
    const nameSet = new Set(characters.map((item) => item.name))
    const characterRelationships = Array.isArray(parsed.characterRelationships)
      ? parsed.characterRelationships.map((entry) => ({
          fromName: asString((entry as { fromName?: string }).fromName),
          toName: asString((entry as { toName?: string }).toName),
          type: asString((entry as { type?: string }).type, '关系'),
          description: asString((entry as { description?: string }).description),
          intensity: asNumber((entry as { intensity?: number }).intensity, 50),
        })).filter((entry) => entry.fromName && entry.toName && entry.fromName !== entry.toName
          && nameSet.has(entry.fromName) && nameSet.has(entry.toName))
      : []
    const outlineVolumes = Array.isArray(parsed.outlineVolumes)
      ? parsed.outlineVolumes.map((entry) => ({
          title: asString((entry as { title?: string }).title, '第一卷'),
          summary: asString((entry as { summary?: string }).summary, '已发生剧情'),
          wordTarget: asString((entry as { wordTarget?: string }).wordTarget) || undefined,
        })).filter((entry) => entry.title)
      : []
    const outlineItems = Array.isArray(parsed.outlineItems)
      ? parsed.outlineItems.map((entry) => ({
          volumeTitle: asString((entry as { volumeTitle?: string }).volumeTitle, outlineVolumes[0]?.title || '第一卷'),
          title: asString((entry as { title?: string }).title),
          wordTarget: asString((entry as { wordTarget?: string }).wordTarget, '已发生'),
          conflict: asString((entry as { conflict?: string }).conflict, '冲突待补'),
          summary: asString((entry as { summary?: string }).summary),
          chapterFrom: typeof (entry as { chapterFrom?: number }).chapterFrom === 'number'
            ? (entry as { chapterFrom: number }).chapterFrom
            : undefined,
          chapterTo: typeof (entry as { chapterTo?: number }).chapterTo === 'number'
            ? (entry as { chapterTo: number }).chapterTo
            : undefined,
        })).filter((entry) => entry.title && entry.summary)
      : []
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.map((item) => String(item).trim()).filter(Boolean)
      : []

    return {
      worldviewEntries,
      characters,
      characterRelationships,
      outlineVolumes: outlineVolumes.length > 0
        ? outlineVolumes
        : [{ title: '第一卷', summary: '由正文反推的默认分卷' }],
      outlineItems,
      warnings,
    } satisfies ContinuationReverseExtractResult
  },
  validate(result: AiTaskResult): boolean {
    const r = result as ContinuationReverseExtractResult
    const hasProtagonist = Array.isArray(r.characters)
      && r.characters.some((c) => /主角|主人公|男主|女主/.test(String(c.role ?? '')))
    return Array.isArray(r.characters)
      && r.characters.length > 0
      && hasProtagonist
      && Array.isArray(r.outlineItems)
      && r.outlineItems.length > 0
  },
  describeValidationErrors(result: AiTaskResult): string[] {
    const r = result as ContinuationReverseExtractResult
    const errors: string[] = []
    if (!r.characters?.length) errors.push('characters 不能为空')
    else if (!r.characters.some((c) => /主角|主人公|男主|女主/.test(String(c.role ?? '')))) {
      errors.push('必须包含至少一名 role 为「主角」的角色')
    }
    if (!r.outlineItems?.length) errors.push('outlineItems 不能为空')
    return errors
  },
}

export default handler
