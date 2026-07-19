import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult, ChapterQualityReviewResult } from '../shared-types'
import {
  formatCurrentOutlineItem,
  formatOutlineChapterSplit,
  formatRelatedChapters,
  formatPreviousChapterHandoff,
} from '../prompts/format-helpers'

const VALID_SEVERITIES = new Set(['critical', 'warning', 'hint'])
const CHAPTER_QUALITY_REVIEW_MAX_TOKENS = 26000

function recomputeQualityPass(
  issues: Array<{ severity: string }>,
  maxWarnings: number,
): boolean {
  let critical = 0
  let warning = 0
  for (const issue of issues) {
    if (issue.severity === 'critical') critical += 1
    else if (issue.severity === 'warning') warning += 1
  }
  return critical === 0 && warning <= maxWarnings
}

const handler: TaskHandler = {
  name: 'chapter-quality-review',
  outputType: 'json',
  defaultCapabilities: ['settings', 'chapters', 'analysis', 'worldview', 'characters', 'relations', 'outline'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    const draftText = String(context.draftText ?? '').trim()
    const maxWarnings = Number(context.qualityReviewMaxWarnings ?? 2)

    return {
      system: `${capabilityPreamble.system}\n\n你是小说章节网文体检员。任务：从追读、爽感、节奏、文风等维度审查章节，为终稿润色提供信号。体检不阻断章节保存。只返回 JSON，不要 markdown。

审查维度（逐项检查，与题材无关）：
1. outline-alignment：正文是否完成本章摘要/大纲节点任务，是否跑题或写穿整个节点
2. split-scope：若同一大纲拆成多章，本章是否只推进当前部分，是否侵占其他部分主情节
3. continuity：时间线、人物状态、与上一章接续是否矛盾
4. cross-chapter-recycle：场景节拍、开篇、意象是否实质复述前文（含语义复述）
5. dialogue-function：对白是否推进剧情与人物，而非纯说明
6. conflict-stake：是否存在可感知的障碍、代价或决策
7. pacing-flat：是否存在长段无变化（信息/关系/张力）
8. ending-hook：章末是否有可追踪的未完成项（非总结/升华）
9. narrator-intrusion：全知旁白是否越界、是否替读者剧透后文
10. character-voice：多角色台词是否可区分
11. imagery-density：「像/仿佛/好像」类比喻是否过密（约每千字 >3 次或单章 >15 次为 warning）；光影/脚步/沉默等模板意象是否堆叠
12. template-closing：章末是否用光影+沉默/脚步远去等模板叠收，而非具体动作或信息
13. split-opening-homogeneity：同一大纲拆章时，本章开篇是否与前置同纲章开篇节拍实质重复
14. dialogue-ratio：有效引号对白字数占比是否过低（约 <25% 为 warning，<18% 为 critical）
15. sentence-length：是否存在过多长复合句（单句 ≥45 字频繁，或连续多句 ≥40 字无对白打断）
16. info-density：信息点是否过密（技术参数/数字/专名连续倾泻，或每千字信息信号明显偏高）；是否缺动作/对白喘息
17. literary-register：是否文绉绉（书面连接词、成语腔、抽象感慨、物像比喻堆叠，整体像论文不像小说）
18. exposition-dialogue：对白是否沦为说明腔（也就是说/简单来说/换句话说），而非带冲突的对话
19. tell-not-show：是否过多用「感到/觉得/意识到」直述情绪，而非行为外化

issue 格式：
- severity: "critical" / "warning" / "hint"
- category: 使用上述英文 category
- ref: 正文证据片段或对比说明
- hint: 一句话问题说明
- repairAction: 可执行修复建议（改哪类段落、补什么戏）

返回格式：
{"review":{"pass":true|false,"issues":[{"severity":"","category":"","ref":"","hint":"","repairAction":""}]}}

pass 判定（由系统复核，不阻断保存）：critical == 0 且 warning <= ${maxWarnings}。`,
      user: `${capabilityPreamble.user}\n\n请审查以下章节正文质量。\n\n项目题材：${String(context.projectGenre ?? '')}\n当前章节标题：${String(context.chapterTitle ?? '')}\n当前章节摘要：${String(context.chapterSummary ?? '')}\n\n当前绑定大纲：\n${formatCurrentOutlineItem(context.currentOutlineItem) || '暂无'}\n\n同一大纲拆章情况：\n${formatOutlineChapterSplit(context.outlineChapterSplit) || '未拆分或暂无前置同纲章节'}\n\n相邻章节参考：\n${formatRelatedChapters(context.relatedChapters) || '暂无'}\n${formatPreviousChapterHandoff(context.previousChapterHandoff) ? `\n上一章接续：\n${formatPreviousChapterHandoff(context.previousChapterHandoff)}` : ''}\n\n## 章节正文\n\n${draftText}\n\n返回审查 JSON。`,
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw) as { review?: Partial<ChapterQualityReviewResult['review']> }
    const reviewRaw = parsed.review ?? {}
    const issuesRaw = Array.isArray(reviewRaw.issues) ? reviewRaw.issues : []
    const maxWarnings = 2
    const issues = issuesRaw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const r = item as Record<string, unknown>
        const severity = String(r.severity ?? '').trim()
        if (!VALID_SEVERITIES.has(severity)) return null
        return {
          severity: severity as 'critical' | 'warning' | 'hint',
          category: String(r.category ?? '').trim(),
          ref: String(r.ref ?? '').trim(),
          hint: String(r.hint ?? '').trim(),
          repairAction: String(r.repairAction ?? '').trim(),
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    const pass = recomputeQualityPass(issues, maxWarnings)
    return {
      review: {
        pass,
        issues,
      },
    } as ChapterQualityReviewResult
  },
  validate(result: AiTaskResult): boolean {
    return Boolean((result as ChapterQualityReviewResult).review)
  },
  resolveMaxTokens(): number {
    return CHAPTER_QUALITY_REVIEW_MAX_TOKENS
  },
}

export default handler
