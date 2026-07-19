import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import {
  newProjectId,
  type ProjectWorkspace,
  type WorkspacePayload,
} from './json-store.js'

export type CarcPreview = {
  archiveVersion: string
  appVersion: string
  projectId: string
  projectTitle: string
  exportedAt: string
  modules: Record<string, { count: number }>
}

type ArchiveManifest = CarcPreview & { app: 'CharacterArc' }

type ArchiveContent = {
  manifest: ArchiveManifest
  project: Record<string, unknown>
  workspace: ProjectWorkspace
  assistantV2: Record<string, unknown>
  knowledgeDocuments: Array<Record<string, unknown>>
  referenceWorks: Array<Record<string, unknown>>
}

const ALL_MODULES = [
  'project',
  'worldview',
  'characters',
  'relations',
  'inspiration',
  'outline',
  'plotThreads',
  'chapters',
  'chapterVersions',
  'workflowDocuments',
  'knowledgeDocuments',
  'referenceWorks',
  'aiRuns',
  'assistantSessions',
] as const

type ArchiveModule = (typeof ALL_MODULES)[number]

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function idWithPrefix(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

async function readZipJson<T>(zip: JSZip, path: string, fallback: T): Promise<T> {
  const file = zip.file(path)
  if (!file) return fallback
  return parseJson(await file.async('string'), fallback)
}

function emptyAssistantV2(): Record<string, unknown> {
  return { sessions: [], turns: [], events: [], stagedChanges: [] }
}

function normalizeAssistantV2(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return emptyAssistantV2()
  const v = value as Record<string, unknown>
  return {
    sessions: Array.isArray(v.sessions) ? v.sessions : [],
    turns: Array.isArray(v.turns) ? v.turns : [],
    events: Array.isArray(v.events) ? v.events : [],
    stagedChanges: Array.isArray(v.stagedChanges) ? v.stagedChanges : [],
  }
}

export async function readCarcArchive(buffer: Buffer): Promise<ArchiveContent> {
  const zip = await JSZip.loadAsync(buffer)
  const manifest = await readZipJson<ArchiveManifest | null>(zip, 'manifest.json', null)
  const project = await readZipJson<Record<string, unknown> | null>(zip, 'project.json', null)
  if (!manifest || manifest.app !== 'CharacterArc' || !project) {
    throw new Error('归档包缺少 manifest.json 或 project.json。')
  }

  const characterPayload = await readZipJson<{
    characters?: unknown[]
    organizations?: unknown[]
  }>(zip, 'workspace/characters.json', {})
  const relationPayload = await readZipJson<{
    characterRelationships?: unknown[]
    organizationMemberships?: unknown[]
  }>(zip, 'workspace/relations.json', {})
  const outlinePayload = await readZipJson<{
    outlineVolumes?: unknown[]
    outlineItems?: unknown[]
  }>(zip, 'workspace/outline.json', {})
  const assistantPayload = await readZipJson<{
    messages?: unknown[]
    globalAssistantSessions?: unknown[]
    activeGlobalAssistantSessionId?: string
    assistantV2?: unknown
  }>(zip, 'workspace/assistantSessions.json', {})

  const workspace: ProjectWorkspace = {
    worldviewEntries: await readZipJson(zip, 'workspace/worldview.json', []),
    characters: characterPayload.characters ?? [],
    organizations: characterPayload.organizations ?? [],
    characterRelationships: relationPayload.characterRelationships ?? [],
    organizationMemberships: relationPayload.organizationMemberships ?? [],
    inspirationEntries: await readZipJson(zip, 'workspace/inspiration.json', []),
    outlineVolumes: outlinePayload.outlineVolumes ?? [],
    outlineItems: outlinePayload.outlineItems ?? [],
    chapters: await readZipJson(zip, 'workspace/chapters.json', []),
    chapterVersions: await readZipJson(zip, 'workspace/chapterVersions.json', []),
    messages: assistantPayload.messages ?? [],
    globalAssistantSessions: assistantPayload.globalAssistantSessions ?? [],
    activeGlobalAssistantSessionId: assistantPayload.activeGlobalAssistantSessionId ?? '',
    aiRuns: await readZipJson(zip, 'workspace/aiRuns.json', []),
    workflowDocuments: await readZipJson(zip, 'workspace/workflowDocuments.json', []),
    plotThreads: await readZipJson(zip, 'workspace/plotThreads.json', []),
  }

  return {
    manifest,
    project,
    workspace,
    assistantV2: normalizeAssistantV2(assistantPayload.assistantV2),
    knowledgeDocuments: await readZipJson(zip, 'workspace/knowledgeDocuments.json', []),
    referenceWorks: await readZipJson(zip, 'workspace/referenceWorks.json', []),
  }
}

export async function inspectCarcArchive(buffer: Buffer): Promise<CarcPreview> {
  const content = await readCarcArchive(buffer)
  if (!content.manifest.projectId || !content.manifest.projectTitle) {
    throw new Error('这不是有效的 CharacterArc 项目归档包。')
  }
  return {
    archiveVersion: content.manifest.archiveVersion,
    appVersion: content.manifest.appVersion,
    projectId: content.manifest.projectId,
    projectTitle: content.manifest.projectTitle,
    exportedAt: content.manifest.exportedAt,
    modules: content.manifest.modules ?? {},
  }
}

function expandModules(modules?: ArchiveModule[]): Set<ArchiveModule> {
  const selected = new Set<ArchiveModule>(modules ?? ALL_MODULES)
  if (selected.has('relations')) selected.add('characters')
  if (selected.has('chapters')) selected.add('outline')
  if (selected.has('chapterVersions')) selected.add('chapters').add('outline')
  if (selected.has('workflowDocuments')) selected.add('outline')
  if (selected.has('aiRuns')) selected.add('knowledgeDocuments')
  return selected
}

function mapId(map: Map<string, string>, oldId: string | undefined): string {
  if (!oldId) return ''
  return map.get(oldId) ?? oldId
}

function remapAssistantEventPayload(payloadJson: string, idMap: Map<string, string>): string {
  const payload = parseJson<Record<string, unknown> | null>(payloadJson, null)
  if (!payload || typeof payload !== 'object') return payloadJson
  const next = { ...payload }
  if (typeof next.changeId === 'string') next.changeId = mapId(idMap, next.changeId)
  return JSON.stringify(next)
}

function remapAssistantV2(
  archive: Record<string, unknown>,
  targetProjectId: string,
  idMap: Map<string, string>,
  modules: Set<ArchiveModule>,
): Record<string, unknown> {
  if (!modules.has('assistantSessions')) return emptyAssistantV2()
  const sessions = (archive.sessions as Array<Record<string, unknown>>) ?? []
  const turns = (archive.turns as Array<Record<string, unknown>>) ?? []
  const events = (archive.events as Array<Record<string, unknown>>) ?? []
  const stagedChanges = (archive.stagedChanges as Array<Record<string, unknown>>) ?? []
  return {
    sessions: sessions.map((session) => ({
      ...session,
      id: mapId(idMap, session.id as string),
      projectId: targetProjectId,
    })),
    turns: turns.map((turn) => ({
      ...turn,
      id: mapId(idMap, turn.id as string),
      sessionId: mapId(idMap, turn.sessionId as string),
    })),
    events: events.map((event) => ({
      ...event,
      id: mapId(idMap, event.id as string),
      turnId: mapId(idMap, event.turnId as string),
      payloadJson: remapAssistantEventPayload(String(event.payloadJson ?? ''), idMap),
    })),
    stagedChanges: stagedChanges.map((change) => ({
      ...change,
      id: mapId(idMap, change.id as string),
      sessionId: mapId(idMap, change.sessionId as string),
      turnId: mapId(idMap, change.turnId as string),
      entityId: change.entityId ? mapId(idMap, change.entityId as string) : undefined,
      candidates: Array.isArray(change.candidates)
        ? (change.candidates as Array<Record<string, unknown>>).map((candidate) => ({
            ...candidate,
            entityId: mapId(idMap, candidate.entityId as string),
          }))
        : [],
    })),
  }
}

function remapArchiveContent(
  content: ArchiveContent,
  targetProjectId: string,
  modules: Set<ArchiveModule>,
): ArchiveContent {
  const idMap = new Map<string, string>([[String(content.project.id), targetProjectId]])
  const assign = (id: string | undefined, prefix: string): string => {
    if (!id) return ''
    const existing = idMap.get(id)
    if (existing) return existing
    const next = idWithPrefix(prefix)
    idMap.set(id, next)
    return next
  }

  for (const work of content.referenceWorks) assign(work.id as string, 'ref')
  for (const document of content.knowledgeDocuments) assign(document.id as string, 'knowledge')
  for (const volume of content.workspace.outlineVolumes as Array<Record<string, unknown>>) {
    assign(volume.id as string, 'volume')
  }
  for (const item of content.workspace.outlineItems as Array<Record<string, unknown>>) {
    assign(item.id as string, 'outline')
  }
  for (const chapter of content.workspace.chapters as Array<Record<string, unknown>>) {
    assign(chapter.id as string, 'chapter')
  }
  for (const version of content.workspace.chapterVersions as Array<Record<string, unknown>>) {
    assign(version.id as string, 'version')
  }
  for (const character of content.workspace.characters as Array<Record<string, unknown>>) {
    assign(character.id as string, 'character')
  }
  for (const organization of content.workspace.organizations as Array<Record<string, unknown>>) {
    assign(organization.id as string, 'org')
  }
  for (const relationship of content.workspace.characterRelationships as Array<Record<string, unknown>>) {
    assign(relationship.id as string, 'relation')
  }
  for (const membership of content.workspace.organizationMemberships as Array<Record<string, unknown>>) {
    assign(membership.id as string, 'member')
  }
  for (const entry of content.workspace.worldviewEntries as Array<Record<string, unknown>>) {
    assign(entry.id as string, 'world')
  }
  for (const entry of content.workspace.inspirationEntries as Array<Record<string, unknown>>) {
    assign(entry.id as string, 'idea')
  }
  for (const thread of content.workspace.plotThreads as Array<Record<string, unknown>>) {
    assign(thread.id as string, 'plot')
  }
  for (const message of content.workspace.messages as Array<Record<string, unknown>>) {
    assign(message.id as string, 'message')
  }
  for (const session of content.workspace.globalAssistantSessions as Array<Record<string, unknown>>) {
    assign(session.id as string, 'session')
  }
  for (const run of content.workspace.aiRuns as Array<Record<string, unknown>>) {
    assign(run.id as string, 'airun')
  }
  for (const session of (content.assistantV2.sessions as Array<Record<string, unknown>>) ?? []) {
    assign(session.id as string, 'session-v2')
  }
  for (const turn of (content.assistantV2.turns as Array<Record<string, unknown>>) ?? []) {
    assign(turn.id as string, 'turn')
  }
  for (const event of (content.assistantV2.events as Array<Record<string, unknown>>) ?? []) {
    assign(event.id as string, 'event')
  }
  for (const change of (content.assistantV2.stagedChanges as Array<Record<string, unknown>>) ?? []) {
    assign(change.id as string, 'stage')
  }

  const project: Record<string, unknown> = {
    ...content.project,
    id: targetProjectId,
    lastEdited: new Date().toISOString(),
    selectedReferenceWorkIds: modules.has('referenceWorks')
      ? ((content.project.selectedReferenceWorkIds as string[] | undefined) ?? [])
          .map((id) => mapId(idMap, id))
          .filter(Boolean)
      : [],
  }

  const workspace: ProjectWorkspace = {
    worldviewEntries: modules.has('worldview')
      ? (content.workspace.worldviewEntries as Array<Record<string, unknown>>).map((entry) => ({
          ...entry,
          id: mapId(idMap, entry.id as string),
        }))
      : [],
    characters: modules.has('characters')
      ? (content.workspace.characters as Array<Record<string, unknown>>).map((character) => ({
          ...character,
          id: mapId(idMap, character.id as string),
        }))
      : [],
    organizations: modules.has('characters')
      ? (content.workspace.organizations as Array<Record<string, unknown>>).map((organization) => ({
          ...organization,
          id: mapId(idMap, organization.id as string),
        }))
      : [],
    characterRelationships: modules.has('relations')
      ? (content.workspace.characterRelationships as Array<Record<string, unknown>>).map((relationship) => ({
          ...relationship,
          id: mapId(idMap, relationship.id as string),
          fromCharacterId: mapId(idMap, relationship.fromCharacterId as string),
          toCharacterId: mapId(idMap, relationship.toCharacterId as string),
        }))
      : [],
    organizationMemberships: modules.has('relations')
      ? (content.workspace.organizationMemberships as Array<Record<string, unknown>>).map((membership) => ({
          ...membership,
          id: mapId(idMap, membership.id as string),
          characterId: mapId(idMap, membership.characterId as string),
          organizationId: mapId(idMap, membership.organizationId as string),
        }))
      : [],
    inspirationEntries: modules.has('inspiration')
      ? (content.workspace.inspirationEntries as Array<Record<string, unknown>>).map((entry) => ({
          ...entry,
          id: mapId(idMap, entry.id as string),
        }))
      : [],
    outlineVolumes: modules.has('outline')
      ? (content.workspace.outlineVolumes as Array<Record<string, unknown>>).map((volume) => ({
          ...volume,
          id: mapId(idMap, volume.id as string),
          workflowDocuments: modules.has('workflowDocuments') ? volume.workflowDocuments : [],
        }))
      : [],
    outlineItems: modules.has('outline')
      ? (content.workspace.outlineItems as Array<Record<string, unknown>>).map((item) => ({
          ...item,
          id: mapId(idMap, item.id as string),
          volumeId: mapId(idMap, item.volumeId as string),
        }))
      : [],
    chapters: modules.has('chapters')
      ? (content.workspace.chapters as Array<Record<string, unknown>>).map((chapter) => ({
          ...chapter,
          id: mapId(idMap, chapter.id as string),
          volumeId: mapId(idMap, chapter.volumeId as string),
          outlineItemId: mapId(idMap, chapter.outlineItemId as string),
        }))
      : [],
    chapterVersions: modules.has('chapterVersions')
      ? (content.workspace.chapterVersions as Array<Record<string, unknown>>).map((version) => ({
          ...version,
          id: mapId(idMap, version.id as string),
          chapterId: mapId(idMap, version.chapterId as string),
        }))
      : [],
    messages: modules.has('assistantSessions')
      ? (content.workspace.messages as Array<Record<string, unknown>>).map((chatMessage) => ({
          ...chatMessage,
          id: mapId(idMap, chatMessage.id as string),
        }))
      : [],
    globalAssistantSessions: modules.has('assistantSessions')
      ? (content.workspace.globalAssistantSessions as Array<Record<string, unknown>>).map((session) => ({
          ...session,
          id: mapId(idMap, session.id as string),
          messages: Array.isArray(session.messages)
            ? (session.messages as Array<Record<string, unknown>>).map((chatMessage) => ({
                ...chatMessage,
                id: mapId(idMap, chatMessage.id as string),
              }))
            : [],
        }))
      : [],
    activeGlobalAssistantSessionId: modules.has('assistantSessions')
      ? mapId(idMap, content.workspace.activeGlobalAssistantSessionId as string)
      : '',
    aiRuns: modules.has('aiRuns')
      ? (content.workspace.aiRuns as Array<Record<string, unknown>>).map((run) => ({
          ...run,
          id: mapId(idMap, run.id as string),
          chapterId: mapId(idMap, run.chapterId as string),
          usedKnowledge: Array.isArray(run.usedKnowledge)
            ? (run.usedKnowledge as Array<Record<string, unknown>>).map((item) => ({
                ...item,
                documentId: mapId(idMap, item.documentId as string),
              }))
            : [],
        }))
      : [],
    workflowDocuments: modules.has('workflowDocuments') ? content.workspace.workflowDocuments : [],
    plotThreads: modules.has('plotThreads')
      ? (content.workspace.plotThreads as Array<Record<string, unknown>>).map((thread) => ({
          ...thread,
          id: mapId(idMap, thread.id as string),
          openedInChapterId: mapId(idMap, thread.openedInChapterId as string),
          closedInChapterId: mapId(idMap, thread.closedInChapterId as string),
        }))
      : [],
    assistantV2: remapAssistantV2(content.assistantV2, targetProjectId, idMap, modules),
  }

  const referenceWorks = modules.has('referenceWorks')
    ? content.referenceWorks.map((work) => ({ ...work, id: mapId(idMap, work.id as string) }))
    : []
  const knowledgeDocuments = modules.has('knowledgeDocuments')
    ? content.knowledgeDocuments.map((document) => ({
        ...document,
        id: mapId(idMap, document.id as string),
        projectId: targetProjectId,
      }))
    : []

  return {
    ...content,
    project,
    workspace,
    assistantV2: workspace.assistantV2 as Record<string, unknown>,
    knowledgeDocuments,
    referenceWorks,
  }
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const incomingIds = new Set(incoming.map((item) => item.id))
  const preserved = current.filter((item) => !incomingIds.has(item.id))
  return [...preserved, ...incoming]
}

export async function importCarcAsNewProjectAsync(
  snapshot: WorkspacePayload,
  buffer: Buffer,
): Promise<{ workspace: WorkspacePayload; projectId: string; preview: CarcPreview }> {
  const modules = expandModules()
  const sourceContent = await readCarcArchive(buffer)
  const preview = await inspectCarcArchive(buffer)
  const targetProjectId = newProjectId()
  const incoming = remapArchiveContent(sourceContent, targetProjectId, modules)

  const nextPayload: WorkspacePayload = {
    ...snapshot,
    selectedProjectId: targetProjectId,
    projects: [
      ...snapshot.projects,
      {
        id: targetProjectId,
        title: String(incoming.project.title ?? '导入作品'),
        genre: String(incoming.project.genre ?? ''),
        novelLength: (incoming.project.novelLength as 'short' | 'long' | undefined) ?? 'long',
        wordCount: String(incoming.project.wordCount ?? ''),
        lastEdited: String(incoming.project.lastEdited ?? new Date().toISOString()),
        cover: String(incoming.project.cover ?? ''),
        targetPlatform: String(incoming.project.targetPlatform ?? ''),
        coverHistory: (incoming.project.coverHistory as unknown[]) ?? [],
        writingStylePresetId: String(incoming.project.writingStylePresetId ?? 'cinematic-cool'),
        writingStylePrompt: String(incoming.project.writingStylePrompt ?? ''),
        novelWorkflowStages: (incoming.project.novelWorkflowStages as unknown[]) ?? [],
        projectSkills: (incoming.project.projectSkills as unknown[]) ?? [],
        chapterAssistantTemplates: (incoming.project.chapterAssistantTemplates as unknown[]) ?? [],
        selectedReferenceWorkIds: (incoming.project.selectedReferenceWorkIds as string[]) ?? [],
      },
    ],
    workspaces: {
      ...snapshot.workspaces,
      [targetProjectId]: incoming.workspace,
    },
    referenceWorks: mergeById(
      (snapshot.referenceWorks ?? []) as Array<{ id: string }>,
      incoming.referenceWorks as Array<{ id: string }>,
    ),
    knowledgeDocuments: mergeById(
      (snapshot.knowledgeDocuments ?? []) as Array<{ id: string }>,
      incoming.knowledgeDocuments as Array<{ id: string }>,
    ),
  }

  return { workspace: nextPayload, projectId: targetProjectId, preview }
}

export async function importCarcIntoProjectAsync(
  snapshot: WorkspacePayload,
  buffer: Buffer,
  options: {
    mode: 'overwrite-project' | 'new-project'
    targetProjectId?: string
    modules?: string[]
  },
): Promise<{ workspace: WorkspacePayload; projectId: string; preview: CarcPreview }> {
  const modules = expandModules(options.modules as never)
  const sourceContent = await readCarcArchive(buffer)
  const preview = await inspectCarcArchive(buffer)

  if (options.mode === 'new-project') {
    return importCarcAsNewProjectAsync(snapshot, buffer)
  }

  const targetProjectId = String(options.targetProjectId ?? '').trim()
  if (!targetProjectId) throw new Error('覆盖导入需要 targetProjectId')
  if (!snapshot.projects.some((project) => project.id === targetProjectId)) {
    throw new Error('目标项目不存在')
  }

  const incoming = remapArchiveContent(sourceContent, targetProjectId, modules)
  const existingWs = snapshot.workspaces[targetProjectId] ?? ({} as ProjectWorkspace)
  const mergedWs: ProjectWorkspace = {
    ...existingWs,
    ...incoming.workspace,
    worldviewEntries: modules.has('worldview')
      ? incoming.workspace.worldviewEntries
      : existingWs.worldviewEntries,
    characters: modules.has('characters') ? incoming.workspace.characters : existingWs.characters,
    organizations: modules.has('characters') ? incoming.workspace.organizations : existingWs.organizations,
    characterRelationships: modules.has('relations')
      ? incoming.workspace.characterRelationships
      : existingWs.characterRelationships,
    organizationMemberships: modules.has('relations')
      ? incoming.workspace.organizationMemberships
      : existingWs.organizationMemberships,
    inspirationEntries: modules.has('inspiration')
      ? incoming.workspace.inspirationEntries
      : existingWs.inspirationEntries,
    outlineVolumes: modules.has('outline') ? incoming.workspace.outlineVolumes : existingWs.outlineVolumes,
    outlineItems: modules.has('outline') ? incoming.workspace.outlineItems : existingWs.outlineItems,
    chapters: modules.has('chapters') ? incoming.workspace.chapters : existingWs.chapters,
    chapterVersions: modules.has('chapterVersions')
      ? incoming.workspace.chapterVersions
      : existingWs.chapterVersions,
    messages: modules.has('assistantSessions') ? incoming.workspace.messages : existingWs.messages,
    globalAssistantSessions: modules.has('assistantSessions')
      ? incoming.workspace.globalAssistantSessions
      : existingWs.globalAssistantSessions,
    activeGlobalAssistantSessionId: modules.has('assistantSessions')
      ? incoming.workspace.activeGlobalAssistantSessionId
      : existingWs.activeGlobalAssistantSessionId,
    aiRuns: modules.has('aiRuns') ? incoming.workspace.aiRuns : existingWs.aiRuns,
    workflowDocuments: modules.has('workflowDocuments')
      ? incoming.workspace.workflowDocuments
      : existingWs.workflowDocuments,
    plotThreads: modules.has('plotThreads') ? incoming.workspace.plotThreads : existingWs.plotThreads,
    assistantV2: modules.has('assistantSessions')
      ? incoming.workspace.assistantV2
      : (existingWs as { assistantV2?: unknown }).assistantV2,
  }

  const projectIndex = snapshot.projects.findIndex((project) => project.id === targetProjectId)
  const projects = [...snapshot.projects]
  projects[projectIndex] = {
    ...projects[projectIndex],
    ...incoming.project,
    id: targetProjectId,
    lastEdited: new Date().toISOString(),
  } as never

  const nextPayload: WorkspacePayload = {
    ...snapshot,
    selectedProjectId: targetProjectId,
    projects,
    workspaces: { ...snapshot.workspaces, [targetProjectId]: mergedWs },
    referenceWorks: modules.has('referenceWorks')
      ? mergeById((snapshot.referenceWorks ?? []) as Array<{ id: string }>, incoming.referenceWorks as Array<{ id: string }>)
      : snapshot.referenceWorks,
    knowledgeDocuments: modules.has('knowledgeDocuments')
      ? mergeById(
          (snapshot.knowledgeDocuments ?? []) as Array<{ id: string }>,
          incoming.knowledgeDocuments as Array<{ id: string }>,
        )
      : snapshot.knowledgeDocuments,
  }

  return { workspace: nextPayload, projectId: targetProjectId, preview }
}
