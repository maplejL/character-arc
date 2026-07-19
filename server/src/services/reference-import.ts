import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { userDataRoot } from '../ai/user-workspace-run.js'
import { runServerAiTask } from '../ai/run-task.js'
import { resolveUserAppSettings } from '../ai/settings.js'
import { readUserWorkspace, writeUserWorkspace, type WorkspacePayload } from '../workspace/json-store.js'

type ProgressEvent = Record<string, unknown>

export async function importReferenceNovelFromPath(
  userId: string,
  filePath: string,
  request: Record<string, unknown>,
  onProgress: (event: ProgressEvent) => void,
): Promise<{
  success: boolean
  canceled: boolean
  result?: {
    referenceWork: unknown
    suggestedWritingStylePrompt: string
    knowledgeDocuments: unknown[]
  }
  error?: string
}> {
  const { extractReferenceNovelContext } = await import('../../../electron/main/referenceAnalysis.js')
  const settings = await resolveUserAppSettings(userId)

  onProgress({ phase: 'extracting', message: '正在读取小说正文并提取基础统计...', current: 0, total: 1, percent: 8 })

  const localContext = await extractReferenceNovelContext(filePath)
  const resolvedTitle = String(request.preferredTitle ?? '').trim() || localContext.title
  const resolvedSource = String(request.preferredSource ?? '').trim() || localContext.fileType.toUpperCase()

  onProgress({
    phase: 'chunking',
    message: `已拆出 ${localContext.analysisChunks.length} 个分析分块，准备逐块提炼风格...`,
    current: 0,
    total: Math.max(localContext.analysisChunks.length, 1),
    percent: 16,
    sourceTitle: resolvedTitle,
  })

  const chunkResults: Array<{ label: string; characterCount: number; result: unknown }> = []
  for (const [index, chunk] of localContext.analysisChunks.entries()) {
    onProgress({
      phase: 'chunk-analysis',
      message: `正在分析第 ${index + 1} / ${localContext.analysisChunks.length} 个分块：${chunk.label}`,
      current: index + 1,
      total: localContext.analysisChunks.length,
      percent: Math.min(82, 16 + Math.round(((index + 1) / Math.max(localContext.analysisChunks.length, 1)) * 58)),
      sourceTitle: resolvedTitle,
    })
    const aiResult = await runServerAiTask(userId, {
      task: 'reference-style-chunk',
      context: {
        projectId: request.projectId ?? '',
        projectTitle: request.projectTitle ?? '',
        projectGenre: request.projectGenre ?? '',
        projectPlatform: request.projectPlatform ?? '',
        projectSkills: request.projectSkills ?? [],
        sourceTitle: resolvedTitle,
        chunkLabel: chunk.label,
        chunkIndex: index + 1,
        chunkTotal: localContext.analysisChunks.length,
        chunkCharacterCount: chunk.characterCount,
        chunkMetrics: chunk.metrics,
        chunkKeywords: chunk.topKeywords,
        chunkText: chunk.text,
      },
    })
    if (!aiResult.success) throw new Error(aiResult.error ?? '分块分析失败')
    chunkResults.push({ label: chunk.label, characterCount: chunk.characterCount, result: aiResult.result })
  }

  onProgress({
    phase: 'aggregating',
    message: '正在汇总所有分块结论，生成可复用仿写模板...',
    current: chunkResults.length,
    total: chunkResults.length,
    percent: 90,
    sourceTitle: resolvedTitle,
  })

  const chunkSummaries = chunkResults
    .map((item, index) => `【分块 ${index + 1}｜${item.label}】\n${JSON.stringify(item.result)}`)
    .join('\n\n')

  const analysisResult = await runServerAiTask(userId, {
    task: 'reference-style-analysis',
    context: {
      projectId: request.projectId ?? '',
      projectTitle: request.projectTitle ?? '',
      projectGenre: request.projectGenre ?? '',
      projectPlatform: request.projectPlatform ?? '',
      projectSkills: request.projectSkills ?? [],
      sourceTitle: resolvedTitle,
      sourceFileType: localContext.fileType,
      sourceCharacterCount: localContext.characterCount,
      sourceChapterCount: localContext.chapterCount,
      styleMetrics: localContext.metrics,
      topKeywords: localContext.topKeywords,
      sourceExcerpt: localContext.excerpt,
      analysisSample: localContext.analysisSample,
      chunkSummaries,
    },
  })
  if (!analysisResult.success) throw new Error(analysisResult.error ?? '汇总分析失败')
  const analysis = analysisResult.result as Record<string, string | string[] | unknown>

  onProgress({
    phase: 'saving',
    message: '正在整理结果并归档到拆书知识库...',
    current: 1,
    total: 1,
    percent: 96,
    sourceTitle: resolvedTitle,
  })

  const refId = `ref-${Date.now()}`
  const novelStorageDir = join(userDataRoot(userId), 'data', 'reference-novels')
  await mkdir(novelStorageDir, { recursive: true })
  const rawNovelText = await readFile(filePath, 'utf-8')
  await writeFile(join(novelStorageDir, `${refId}.txt`), rawNovelText, 'utf-8')

  const importedAt = new Date().toISOString()
  const referenceWork = {
    id: refId,
    title: resolvedTitle,
    source: resolvedSource,
    notes: String(analysis.overview ?? ''),
    fileName: localContext.fileName,
    analysis: {
      createdAt: importedAt,
      fileName: localContext.fileName,
      fileType: localContext.fileType,
      characterCount: localContext.characterCount,
      chapterCount: localContext.chapterCount,
      excerpt: localContext.excerpt,
      topKeywords: localContext.topKeywords,
      metrics: [
        ...localContext.metrics,
        { label: '分析分块数', value: `${localContext.analysisChunks.length} 块` },
      ],
      overview: analysis.overview,
      sentenceStyle: analysis.sentenceStyle,
      dialogueRatio: analysis.dialogueRatio,
      pacingControl: analysis.pacingControl,
      emotionExpression: analysis.emotionExpression,
      narrativePerspective: analysis.narrativePerspective,
      styleRules: analysis.styleRules,
      plotOutline: analysis.plotOutline,
      reusableStylePrompt: analysis.reusableStylePrompt,
      avoidRules: analysis.avoidRules,
    },
  }

  const knowledgeDocuments = [
    {
      id: `knowledge-ref-${refId}`,
      projectId: String(request.projectId ?? ''),
      title: `拆书｜${resolvedTitle}`,
      sourceType: 'reference-analysis',
      sourceLabel: 'reference-novel',
      content: String(analysis.reusableStylePrompt ?? analysis.overview ?? ''),
      summary: String(analysis.overview ?? ''),
      keywords: [resolvedTitle, 'reference-novel'],
      metadata: { refId, fileName: localContext.fileName },
      createdAt: importedAt,
      updatedAt: importedAt,
    },
  ]

  const workspace = await readUserWorkspace(userId)
  const next: WorkspacePayload = {
    ...workspace,
    referenceWorks: [...(workspace.referenceWorks ?? []), referenceWork as never],
    knowledgeDocuments: [...(workspace.knowledgeDocuments ?? []), ...(knowledgeDocuments as never[])],
  }
  await writeUserWorkspace(userId, next)

  onProgress({
    phase: 'done',
    message: `《${resolvedTitle}》拆书完成，结果已归档到拆书知识库。`,
    current: 1,
    total: 1,
    percent: 100,
    sourceTitle: resolvedTitle,
  })

  const suggestedWritingStylePrompt = String(analysis.reusableStylePrompt ?? analysis.overview ?? '')

  return {
    success: true,
    canceled: false,
    result: { referenceWork, suggestedWritingStylePrompt, knowledgeDocuments },
  }
}
