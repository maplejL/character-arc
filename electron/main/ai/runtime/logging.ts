import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings, AiRunKnowledgeItem, PromptPair, AiRunUsage } from '../shared-types'
import { formatCacheUsageLine } from '../../../shared/auto-creation/cache-usage'
import type { SkillSelection } from '../skills/types'

/** 日志存放目录 */
const AI_PROMPT_LOG_DIR = join(process.cwd(), '.logs')
/** AI 提示词日志文件路径 */
const AI_PROMPT_LOG_FILE = join(AI_PROMPT_LOG_DIR, 'ai-prompts.log')

function resolveAppLogFile(): string | null {
  const root = process.env.CHARACTERARC_APP_ROOT?.trim()
  if (!root) return null
  return join(root, 'app.log')
}

/** 将内容追加写入提示词日志文件；服务端同时写入 app.log */
async function writePromptLogFile(content: string): Promise<void> {
  try {
    await mkdir(AI_PROMPT_LOG_DIR, { recursive: true })
    await appendFile(AI_PROMPT_LOG_FILE, `${content}\n`, 'utf8')
  } catch (error) {
    console.error('[ai] failed to write prompt log file:', error)
  }

  const appLog = resolveAppLogFile()
  if (!appLog) return
  try {
    await appendFile(appLog, `${content}\n`, 'utf8')
  } catch (error) {
    console.error('[ai] failed to write app.log:', error)
  }
}

/**
 * 记录 AI 提示词请求日志（系统提示词 + 用户提示词）
 * @param label - 日志标签，如 REQUEST、REPAIR_1
 * @param settings - 应用设置
 * @param prompt - 系统/用户提示词对
 * @param taskName - 任务名称
 * @param usedSkills - 可选的已使用技能 ID 列表
 */
export function logPrompt(
  label: string,
  settings: AppSettings,
  prompt: PromptPair,
  taskName: string,
  usedSkills?: string[],
  metaLines?: string[],
): void {
  const provider = settings.provider || 'unknown'
  const model = settings.model || 'unknown'
  const timestamp = new Date().toISOString()
  const skillLine = usedSkills?.length ? `技能: ${usedSkills.join(', ')}` : ''
  const content = [
    '',
    `===== AI 提示词 ${label} =====`,
    `时间: ${timestamp}`,
    `任务: ${taskName}`,
    `提供者: ${provider}`,
    `模型: ${model}`,
    ...(metaLines ?? []),
    skillLine,
    '--- SYSTEM ---',
    prompt.system || '',
    '--- USER ---',
    prompt.user || '',
    `===== END AI 提示词 ${label} =====`
  ].filter(Boolean).join('\n')

  console.log(`[ai] prompt logged: ${label} | task=${taskName} | provider=${provider} | model=${model}`)
  void writePromptLogFile(content)
}

/**
 * Log the matcher selection: which skills were picked (with score) and which
 * knowledge items were retrieved. Written before the REQUEST block so a reader
 * sees SELECTION → REQUEST → RESPONSE in chronological order.
 */
export function logSelection(
  taskName: string,
  skills: SkillSelection[],
  knowledge: AiRunKnowledgeItem[],
  metaLines?: string[],
): void {
  const timestamp = new Date().toISOString()
  const skillLines = skills.length
    ? skills.map((s, i) => {
        const b = s.scoreBreakdown
        const detail = b
          ? ` [task=${b.task} stage=${b.stage} trig=${b.trigger} narr=${b.narrative} len=${b.length} prio=${b.priority.toFixed(1)}]`
          : ''
        return `  ${i + 1}. ${s.id} (score=${s.score.toFixed(1)}${detail}, refs=${s.referenceContents.length}, content=${s.content.length}字)`
      })
    : ['  （无）']
  const knowledgeLines = knowledge.length
    ? knowledge.map((k, i) => {
        const snippet = (k.snippet || '').replace(/\s+/g, ' ').slice(0, 80)
        const kw = k.keywords.length ? ` [${k.keywords.slice(0, 5).join('、')}]` : ''
        return `  ${i + 1}. [${k.sourceType}] ${k.title} <- ${k.sourceLabel}${kw}\n     ${snippet}`
      })
    : ['  （无）']
  const content = [
    '',
    `===== AI 选择 SELECTION =====`,
    `时间: ${timestamp}`,
    `任务: ${taskName}`,
    ...(metaLines ?? []),
    '--- 选中的 SKILL ---',
    ...skillLines,
    '--- 检索到的知识 ---',
    ...knowledgeLines,
    `===== END AI 选择 =====`
  ].join('\n')

  console.log(`[ai] selection: task=${taskName} | skills=${skills.length} | knowledge=${knowledge.length}`)
  void writePromptLogFile(content)
}

/**
 * Log the raw response text from the model along with timing. Written after
 * the model call returns (success path).
 */
export function logResponse(
  label: string,
  settings: AppSettings,
  taskName: string,
  rawText: string,
  durationMs: number,
  extra?: { usedSkills?: string[]; metaLines?: string[]; usage?: AiRunUsage },
): void {
  const provider = settings.provider || 'unknown'
  const model = settings.model || 'unknown'
  const timestamp = new Date().toISOString()
  const skillLine = extra?.usedSkills?.length ? `技能: ${extra.usedSkills.join(', ')}` : ''
  const cacheLine = extra?.usage ? formatCacheUsageLine(extra.usage) : ''
  const previewSource = (rawText || '').replace(/\s+/g, ' ').trim()
  const preview = previewSource.length > 200 ? `${previewSource.slice(0, 200)}…` : previewSource
  const content = [
    '',
    `===== AI 响应 ${label} =====`,
    `时间: ${timestamp}`,
    `任务: ${taskName}`,
    `提供者: ${provider}`,
    `模型: ${model}`,
    `耗时: ${durationMs}ms`,
    `字数: ${rawText.length}`,
    ...(extra?.metaLines ?? []),
    cacheLine,
    skillLine,
    '--- BODY ---',
    rawText || '（空响应）',
    `===== END AI 响应 ${label} =====`
  ].filter(Boolean).join('\n')

  console.log(`[ai] response: ${label} | task=${taskName} | provider=${provider} | model=${model} | ${durationMs}ms | ${rawText.length}字 | ${preview}`)
  void writePromptLogFile(content)
}

/**
 * Log an AI call failure. Mirrors logResponse layout so prompt → error pairs are
 * obvious in the log file. Called from orchestrator / agent catch blocks; without
 * this, failed runs leave a REQUEST entry with no matching RESPONSE and the user
 * has no way to see what went wrong.
 */
export function logError(
  label: string,
  settings: AppSettings,
  taskName: string,
  error: unknown,
  durationMs: number,
  extra?: { usedSkills?: string[]; metaLines?: string[] },
): void {
  const provider = settings.provider || 'unknown'
  const model = settings.model || 'unknown'
  const timestamp = new Date().toISOString()
  const skillLine = extra?.usedSkills?.length ? `技能: ${extra.usedSkills.join(', ')}` : ''
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && error.stack ? error.stack : ''
  const details = formatErrorDetails(error)
  const content = [
    '',
    `===== AI 错误 ${label} =====`,
    `时间: ${timestamp}`,
    `任务: ${taskName}`,
    `提供者: ${provider}`,
    `模型: ${model}`,
    `耗时: ${durationMs}ms`,
    ...(extra?.metaLines ?? []),
    skillLine,
    '--- ERROR ---',
    message,
    details ? '--- DETAILS ---' : '',
    details,
    stack ? '--- STACK ---' : '',
    stack,
    `===== END AI 错误 ${label} =====`
  ].filter(Boolean).join('\n')

  console.error(`[ai] error: ${label} | task=${taskName} | provider=${provider} | model=${model} | ${durationMs}ms | ${message}${details ? ` | ${details}` : ''}`)
  void writePromptLogFile(content)
}

function formatErrorDetails(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return ''
  }

  const record = error as Record<string, unknown>
  const lines: string[] = []
  const statusCode = record.statusCode
  if (typeof statusCode === 'number' || typeof statusCode === 'string') {
    lines.push(`statusCode: ${statusCode}`)
  }

  const responseBody = record.responseBody
  if (typeof responseBody === 'string' && responseBody.trim()) {
    lines.push(`responseBody: ${responseBody.slice(0, 1200)}`)
  }

  const data = record.data
  if (data !== undefined) {
    try {
      lines.push(`data: ${JSON.stringify(data).slice(0, 1200)}`)
    } catch {
      lines.push(`data: ${String(data).slice(0, 1200)}`)
    }
  }

  const cause = record.cause
  if (cause && typeof cause === 'object' && cause !== error) {
    const causeDetails = formatErrorDetails(cause)
    if (causeDetails) {
      lines.push(`cause: ${causeDetails}`)
    }
  }

  return lines.join('\n')
}
