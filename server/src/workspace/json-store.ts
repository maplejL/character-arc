import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'

/** Server-side workspace snapshot (compatible with desktop JSON shape). */
export type WorkspacePayload = {
  theme?: string
  selectedProjectId?: string
  knowledgeDocuments?: unknown[]
  referenceWorks?: unknown[]
  projects: Array<{
    id: string
    title: string
    genre?: string
    novelLength?: 'short' | 'long'
    wordCount?: string
    lastEdited?: string
    cover?: string
    targetPlatform?: string
    coverHistory?: unknown[]
    writingStylePresetId?: string
    writingStylePrompt?: string
    novelWorkflowStages?: unknown[]
    projectSkills?: unknown[]
    chapterAssistantTemplates?: unknown[]
    selectedReferenceWorkIds?: string[]
  }>
  workspaces: Record<string, Record<string, unknown>>
  coverWorkbenchHistory?: unknown[]
  appSettings?: Record<string, unknown>
}

export type ProjectWorkspace = Record<string, unknown>

function userWorkspacePath(userId: string): string {
  return join(config.dataRoot, 'users', userId, 'workspace.json')
}

export function createEmptyWorkspace(): WorkspacePayload {
  return {
    theme: 'ocean',
    selectedProjectId: '',
    knowledgeDocuments: [],
    referenceWorks: [],
    projects: [],
    workspaces: {},
    coverWorkbenchHistory: [],
  }
}

function normalizePayload(raw: unknown): WorkspacePayload {
  if (!raw || typeof raw !== 'object') return createEmptyWorkspace()
  const p = raw as WorkspacePayload
  return {
    ...createEmptyWorkspace(),
    ...p,
    projects: Array.isArray(p.projects) ? p.projects : [],
    workspaces: p.workspaces && typeof p.workspaces === 'object' ? p.workspaces : {},
  }
}

export async function readUserWorkspace(userId: string): Promise<WorkspacePayload> {
  const path = userWorkspacePath(userId)
  await mkdir(join(config.dataRoot, 'users', userId), { recursive: true })
  try {
    const raw = await readFile(path, 'utf8')
    return normalizePayload(JSON.parse(raw) as unknown)
  } catch {
    return createEmptyWorkspace()
  }
}

export async function writeUserWorkspace(userId: string, payload: WorkspacePayload): Promise<void> {
  const path = userWorkspacePath(userId)
  await mkdir(join(config.dataRoot, 'users', userId), { recursive: true })
  const normalized = normalizePayload(payload)
  await writeFile(path, JSON.stringify(normalized, null, 2), 'utf8')
}

export function newProjectId(): string {
  return `project-${Date.now()}`
}

export function createEmptyProjectWorkspace(): ProjectWorkspace {
  return {
    worldviewEntries: [],
    characters: [],
    organizations: [],
    characterRelationships: [],
    organizationMemberships: [],
    inspirationEntries: [],
    outlineVolumes: [],
    outlineItems: [],
    chapters: [],
    chapterVersions: [],
    messages: [],
    globalAssistantSessions: [],
    activeGlobalAssistantSessionId: '',
    aiRuns: [],
    workflowDocuments: [],
    plotThreads: [],
  }
}
