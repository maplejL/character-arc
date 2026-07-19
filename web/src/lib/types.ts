export type UserRole = 'USER' | 'ADMIN'

export interface UserRead {
  id: string
  email: string
  role: UserRole
  createdAt: string
}

export interface TokenResponse {
  accessToken: string
  refreshToken: string
  user: UserRead
}

export interface AiProfileRead {
  id: string
  name: string
  provider: 'deepseek' | 'openai-compatible'
  model: string
  baseUrl: string
  hasApiKey: boolean
}

export interface ChapterProductionModelsRead {
  draftProfileId?: string
  draftModel?: string
  repairProfileId?: string
  repairModel?: string
  auditProfileId?: string
  auditModel?: string
}

export interface AiConfigRead {
  provider: 'deepseek' | 'openai-compatible'
  model: string
  baseUrl: string
  hasApiKey: boolean
  activeAiProfileId: string
  aiProfiles: AiProfileRead[]
  chapterProductionModels: ChapterProductionModelsRead
}

export interface AiProfileWrite {
  id?: string
  name: string
  provider: 'deepseek' | 'openai-compatible'
  model: string
  baseUrl?: string
  apiKey?: string
}

export interface AiConfigWrite {
  provider: 'deepseek' | 'openai-compatible'
  model: string
  baseUrl?: string
  apiKey?: string
  activeAiProfileId?: string
  aiProfiles?: AiProfileWrite[]
  chapterProductionModels?: ChapterProductionModelsRead
}
