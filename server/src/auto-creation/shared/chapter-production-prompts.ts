export const CHAPTER_PRODUCTION_UNIFIED_SYSTEM = `你是 CharacterArc 小说章节生产助手，在同一对话中依次完成网文体检、契约审计、定点修复。
始终只返回当前阶段要求的 JSON 或正文（不要 markdown 包裹）。

网文体检输出：{"review":{"pass":true|false,"issues":[{"severity":"","category":"","ref":"","hint":"","repairAction":""}]}}
契约审计输出：{"audit":{"pass":true|false,"wordCount":0,"issues":[{"severity":"","category":"","ref":"","hint":""}]}}
修复阶段输出修订后的完整章节正文纯文本（非 JSON）。

体检/审计的 issues 含 severity/category/ref/hint；体检另含 repairAction。
体检 pass 由系统记录但不阻断保存；契约审计与字数才是返修依据。
契约审计必须覆盖大纲边界、角色 OOC、关系漂移、接续矛盾与备忘硬契约（category 见审计任务）。`

export function buildQualityPhaseInstruction(round: number, maxWarnings: number): string {
  const roundLabel = round === 0 ? '首轮' : `第 ${round} 轮复查`
  return `${roundLabel}网文体检（不阻断保存，issue 供终稿润色参考）。warning 上限 ${maxWarnings}。优先检查 ending-hook（追读）、pacing-flat（节奏）、conflict-stake（爽感/推进）、dialogue-ratio、literary-register、tell-not-show；并覆盖 outline-alignment、split-scope、continuity、cross-chapter-recycle、dialogue-function、narrator-intrusion、character-voice。只返回 review JSON。`
}

export function buildAuditPhaseInstruction(targetWordCount: number): string {
  return `契约审计（大纲闸门）。目标字数约 ${targetWordCount}。除备忘 payoffs/endingChanges/doNotDo/holds 外，必须核对：outline-scope、outline-miss、plot-drift、character-ooc、relation-drift、continuity、forbidden-advance。明确违规须标 critical。只返回 audit JSON。`
}

export type RepairIssueLine = {
  severity?: string
  category?: string
  ref?: string
  hint?: string
}

export function formatRepairIssueLine(issue: RepairIssueLine | string, index: number): string {
  if (typeof issue === 'string') return `${index + 1}. ${issue}`
  const hint = issue.hint?.trim() || issue.ref?.trim() || ''
  const category = issue.category?.trim()
  const severity = issue.severity?.trim()
  const prefix = [severity ? `(${severity})` : '', category ? `[${category}]` : ''].filter(Boolean).join(' ')
  return `${index + 1}. ${prefix ? `${prefix} ` : ''}${hint || '（无描述）'}`
}

export function buildRepairPhaseInstruction(
  issues: Array<RepairIssueLine | string>,
  wordCountStrict: boolean,
): string {
  const list =
    issues.length > 0
      ? issues.map((item, index) => formatRepairIssueLine(item, index)).join('\n')
      : '（无具体问题，请按字数与结构微调）'
  const wordLine = wordCountStrict
    ? '字数偏差为 critical，必须优先收敛到目标字数范围内。'
    : '字数可微调，但不要大幅删减情节。'
  return `定点修复。${wordLine}
修复必须以冻结上下文中的绑定大纲、角色卡、关系网、上一章接续与写作备忘为基准。
若问题含 outline-scope / outline-miss / plot-drift / character-ooc / relation-drift / continuity / forbidden-advance / payoff / ending-change / hold / do-not-do：优先修到可过审，禁止为修问题再次 OOC 或写穿后续大纲。

待修复问题：
${list}

输出修订后的完整章节正文（纯文本，不要 JSON）。`
}

export function buildConvergenceDraftSeedUserTurn(frozenPrefix: string, draftText: string): string {
  return `${frozenPrefix.trim()}\n\n【阶段】初稿入库\n\n以下为待检章节正文。后续轮次以对话历史中 assistant 输出的正文为准，勿要求重复粘贴全文：\n\n${draftText.trim()}`
}
