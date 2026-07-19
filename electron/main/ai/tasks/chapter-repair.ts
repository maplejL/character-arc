import type { TaskHandler, PromptBuildInput } from './base'
import { normalizeAssistantText } from './base'
import type { AiTaskResult, ChapterAssistantResult } from '../shared-types'
import {
  formatCharacters,
  formatCharacterRelationships,
  formatCurrentOutlineItem,
  formatOpenPlotThreads,
  formatOutlineChapterSplit,
  formatOutlineItems,
  formatPreviousChapterHandoff,
  formatRelatedChapters,
  formatWorldviewEntries,
} from '../prompts/format-helpers'

/** 章节修复系统提示词：定义诊断维度（风格偏移、剧情bug、角色OOC、AI痕迹、节奏失衡）和最小改动修复原则 */
const CHAPTER_REPAIR_SYSTEM = `你是章节诊断修复专家，专精于识别和修复长篇创作中的问题章节。

你的工作流程分三步：
1. 诊断：识别章节中的具体问题（风格偏移、剧情bug、角色OOC、AI痕迹、节奏失衡、大纲跑偏）
2. 外科手术式重写：只修改有问题的段落，保留正常段落不动
3. 输出状态更新：列出本次修复涉及的角色状态、伏笔、关系变更

【诊断维度】
- 风格偏移：与前文语言风格不一致的段落
- 剧情bug：与已建立事实矛盾的内容
- 大纲跑偏：写穿后续节点、未兑现本章大纲任务、另起无关主线
- 角色OOC：不符合角色已建立性格/动机的行为或台词
- 关系漂移：违背关系网的敌友/亲密越级
- AI痕迹：机械化表达、套路化描写、过度使用特定词汇
- 节奏失衡：信息密度突变、场景转换生硬

【修复原则】
- 最小改动原则：能改一句不改一段，能改一段不改全章
- 保持前后文衔接：修复后的内容必须与未修改部分无缝衔接
- 尊重已建立设定与大纲边界：修复不能引入新的设定矛盾，也不能写穿后续大纲
- 保留作者意图：修复方向是让原有意图更好地表达，而非改变方向

【输出格式】
先输出诊断报告，再输出修复后的完整章节正文。`

/** 审计驱动的修复模式：跳过诊断，直接针对已知问题进行外科手术式修复 */
const AUDIT_REPAIR_SYSTEM = `你是章节修复专家。质量审计已经完成诊断，你只需根据审计发现的问题进行外科手术式修复。

【修复原则】
- 最小改动原则：只修改审计指出的问题段落，保留正常段落不动
- 保持前后文衔接：修复后的内容必须与未修改部分无缝衔接
- 尊重已建立设定：修复不能引入新的设定矛盾
- 字数约束：修复后总字数与原文偏差不超过 ±10%
- 保留作者意图：修复方向是让原有意图更好地表达，而非改变方向
- 必须以「剧情约束上下文」中的大纲/角色卡/关系网为修复基准；不得为修问题而再次 OOC 或写穿大纲
- 修 A 不得破坏 B：严禁为修复某条 issue 而删除/改写未被点名的剧情节拍、伏笔回收、角色立场或章末钩子

【若问题类别属于大纲/人设契约，必须优先修到可过审】
- outline-scope / plot-drift / forbidden-advance：删掉写穿节点或跑偏主线，拉回本章大纲边界
- outline-miss / payoff / ending-change：补上可定位的兑现动作/对白/信息变化
- character-ooc / relation-drift：改言行与关系，使符合角色卡与关系网
- continuity：修正与上一章状态/时间线矛盾
- hold / do-not-do：收回提前掀开的底牌或红线内容

【输出格式】
直接输出修复后的完整章节正文。不要诊断报告，不要解释，不要 markdown 标记。直接以正文第一句开始。`

function formatAuditIssues(issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) return ''
  return issues
    .map((issue) => {
      const i = issue as Record<string, unknown>
      const severity = String(i.severity ?? '')
      const category = String(i.category ?? '')
      const ref = String(i.ref ?? '')
      const hint = String(i.hint ?? '')
      return `[${severity}] ${category}：${ref}${hint ? `（建议：${hint}）` : ''}`
    })
    .join('\n')
}

function asBlock(title: string, body: string): string {
  const text = body.trim()
  if (!text) return ''
  return `## ${title}\n\n${text}`
}

function buildRepairConstraintBlock(context: Record<string, unknown>): string {
  const parts = [
    asBlock('当前绑定大纲（修复后不得写穿）', formatCurrentOutlineItem(context.currentOutlineItem)),
    asBlock('同一大纲拆章位置', formatOutlineChapterSplit(context.outlineChapterSplit)),
    asBlock('本卷相关大纲节点', formatOutlineItems(context.outlineItems)),
    asBlock('章节摘要', String(context.chapterSummary ?? '').trim()),
    asBlock('相邻章节', formatRelatedChapters(context.relatedChapters)),
    asBlock('上一章接续', formatPreviousChapterHandoff(context.previousChapterHandoff)),
    asBlock('未收伏笔', formatOpenPlotThreads(context.plotThreads)),
    asBlock('角色卡（OOC 修复基准）', formatCharacters(context.characters)),
    asBlock(
      '角色关系',
      formatCharacterRelationships(context.characterRelationships, context.characters),
    ),
    asBlock('世界观', formatWorldviewEntries(context.worldviewEntries)),
  ].filter(Boolean)
  if (parts.length === 0) return ''
  return ['== 剧情约束上下文（修复基准，必须遵守） ==', '', ...parts].join('\n\n')
}

/** 章节修复任务：对问题章节进行诊断并进行外科手术式重写 */
const handler: TaskHandler = {
  name: 'chapter-repair',
  outputType: 'text',
  maxSkills: 6,
  defaultCapabilities: [
    'settings',
    'chapters',
    'worldview',
    'characters',
    'relations',
    'outline',
    'writing-style',
    'project-skills',
  ],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble, skillsBlock, knowledgeBlock } = input
    const retrievalBlock = knowledgeBlock ? `\n\n检索到的项目记忆与参考资料：\n${knowledgeBlock}` : ''
    const auditIssuesBlock = formatAuditIssues(context.auditIssues)
    const isAuditDriven = Boolean(auditIssuesBlock)
    const constraintBlock = buildRepairConstraintBlock(context as Record<string, unknown>)

    const systemPrompt = isAuditDriven ? AUDIT_REPAIR_SYSTEM : CHAPTER_REPAIR_SYSTEM

    const userPromptParts = [
      `${capabilityPreamble.user}`,
      `\n\n请对以下章节进行${isAuditDriven ? '针对性修复' : '诊断并修复'}。`,
      `\n\n项目标题：${String(context.projectTitle ?? '')}`,
      `\n项目题材：${String(context.projectGenre ?? '')}`,
      `\n当前风格：${String(context.writingStyleLabel ?? '未指定')}`,
      `\n风格要求：${String(context.writingStylePrompt ?? '暂无')}`,
      `\n当前章节标题：${String(context.chapterTitle ?? '')}`,
      `\n当前章节摘要：${String(context.chapterSummary ?? '')}`,
    ]

    if (constraintBlock) {
      userPromptParts.push(`\n\n${constraintBlock}`)
    }

    userPromptParts.push(`\n\n当前章节正文：\n${String(context.chapterContent ?? '')}`)

    if (isAuditDriven) {
      userPromptParts.push(`\n\n== 质量审计发现的问题（必须全部修复） ==\n${auditIssuesBlock}`)
      const memoText = String(context.chapterMemoText ?? '').trim()
      if (memoText || context.chapterMemo) {
        userPromptParts.push(`\n\n== 本章写作备忘（修复时参考） ==\n${memoText || '（见上下文）'}`)
      }
      userPromptParts.push(
        '\n\n== 修复自检（内部执行，不要输出） ==\n'
        + '输出前逐条核对：① 每个审计问题是否已在正文中有可定位的修复动作；'
        + '② 是否误删/误改了未被点名的剧情节拍、伏笔、角色立场或章末钩子；'
        + '③ 修复后是否仍遵守绑定大纲边界与角色卡。发现冲突先修正再输出。',
      )
    } else {
      userPromptParts.push(`\n\n用户反馈的问题：${String(context.userPrompt ?? '请自动诊断')}`)
    }

    userPromptParts.push(retrievalBlock)
    userPromptParts.push(`\n\n当前项目启用 skills：\n${skillsBlock || '暂无'}`)

    return {
      system: `${capabilityPreamble.system}\n\n${systemPrompt}`,
      user: userPromptParts.join(''),
    }
  },
  normalize(raw: string): AiTaskResult {
    return normalizeAssistantText(raw) as AiTaskResult
  },
  validate(result: AiTaskResult): boolean {
    return Boolean((result as ChapterAssistantResult).content?.trim())
  },
  resolveMaxTokens(input: PromptBuildInput): number {
    const draftLength = String(input.context.chapterContent ?? '').length
    // 需完整输出修订正文；长章 + 约束上下文下给足 completion 余量
    if (draftLength > 5000) return 12000
    if (draftLength > 3000) return 8000
    return 5000
  },
}
export default handler
