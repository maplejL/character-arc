import type { AppSettings, AiRunUsage, AiStreamHandlers } from '../shared-types'
import { CHAPTER_PRODUCTION_UNIFIED_SYSTEM } from '../../../shared/auto-creation/chapter-production-prompts'
import type { ChapterConvergenceSession } from '../../../shared/auto-creation/convergence-session'
import { formatCacheUsageLine } from '../../../shared/auto-creation/cache-usage'
import { aiStreamTextWithMessagesUsage } from '../generate'
import { getTaskHandler } from '../tasks'
import type { AiTextGenerationResult } from '../generate'
import { buildSystemPrompt } from '../provider'
import { applyReasoningSafeFloor } from '../settings'
import type { AiTaskPayload } from '../shared-types'
import { logPrompt, logResponse } from './logging'

export type ConvergenceStreamPhase = 'chapter-quality-review' | 'chapter-audit' | 'chapter-repair'

const PHASE_MAX_TOKENS: Record<ConvergenceStreamPhase, number> = {
  'chapter-quality-review': 26000,
  'chapter-audit': 26000,
  'chapter-repair': 12000,
}

export async function streamChapterConvergencePhase(
  settings: AppSettings,
  session: ChapterConvergenceSession,
  phase: ConvergenceStreamPhase,
  userTurn: string,
  handlers: AiStreamHandlers,
  signal: AbortSignal,
  logContext?: { taskLabel?: string; metaLines?: string[] },
): Promise<AiTextGenerationResult> {
  session.appendUserTurn(userTurn)
  const system = buildSystemPrompt(settings, CHAPTER_PRODUCTION_UNIFIED_SYSTEM)
  const prompt = {
    system: CHAPTER_PRODUCTION_UNIFIED_SYSTEM,
    messages: session.messages,
  }
  const taskLabel = logContext?.taskLabel ?? phase
  const modelRole = (settings as { modelRole?: string }).modelRole
  const metaLines = [
    ...(logContext?.metaLines ?? []),
    ...(modelRole && modelRole !== 'default' ? [`模型角色: ${modelRole}`] : []),
  ]
  const systemForLog = typeof system === 'string' ? system : system.content
  logPrompt('CONVERGENCE', settings, {
    system: systemForLog,
    user: `[multi-turn ${session.messages.length} messages]\n--- latest user ---\n${userTurn}`,
  }, taskLabel, undefined, metaLines)

  const startedAt = Date.now()
  const generation = await aiStreamTextWithMessagesUsage(
    settings,
    prompt,
    handlers,
    signal,
    applyReasoningSafeFloor(PHASE_MAX_TOKENS[phase]),
  )
  session.appendAssistantTurn(generation.text)

  const cacheLine = formatCacheUsageLine(generation.usage)
  logResponse(
    'CONVERGENCE',
    settings,
    taskLabel,
    generation.text,
    Date.now() - startedAt,
    {
      metaLines: [...metaLines, cacheLine].filter(Boolean),
    },
  )

  return generation
}

export function normalizeConvergencePhaseResult(
  phase: ConvergenceStreamPhase,
  rawText: string,
  taskPayload?: AiTaskPayload,
  promptInput?: import('../tasks/base').PromptBuildInput,
): { text: string; result?: unknown } {
  const handler = getTaskHandler(phase)
  if (phase === 'chapter-repair') {
    const normalized = handler.normalize(rawText, promptInput)
    const content = (normalized as { content?: string }).content ?? rawText
    return { text: content, result: normalized }
  }

  try {
    const result = handler.normalize(rawText, promptInput)
    if (handler.validate(result)) {
      return { text: rawText, result }
    }
  } catch {
    /* fall through */
  }

  if (taskPayload) {
    return { text: rawText, result: undefined }
  }
  return { text: rawText, result: undefined }
}

export function mergeConvergenceUsage(
  left?: AiRunUsage,
  right?: AiRunUsage,
): AiRunUsage | undefined {
  if (!left) return right
  if (!right) return left
  const add = (a?: number, b?: number) => {
    const safeA = typeof a === 'number' && Number.isFinite(a) ? a : undefined
    const safeB = typeof b === 'number' && Number.isFinite(b) ? b : undefined
    if (safeA === undefined && safeB === undefined) return undefined
    return (safeA ?? 0) + (safeB ?? 0)
  }
  return {
    promptTokens: add(left.promptTokens, right.promptTokens),
    completionTokens: add(left.completionTokens, right.completionTokens),
    totalTokens: add(left.totalTokens, right.totalTokens),
    reasoningTokens: add(left.reasoningTokens, right.reasoningTokens),
    cachedInputTokens: add(left.cachedInputTokens, right.cachedInputTokens),
    promptCacheMissTokens: add(left.promptCacheMissTokens, right.promptCacheMissTokens),
  }
}
