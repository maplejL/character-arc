import { query } from '../db/pool.js'

export interface UserAppSettings {
  theme: string
  selectedProjectId: string
  autoSaveInterval: string
  uiScale: number
  darkMode: boolean
  darkModeStyle: string
}

const defaults: UserAppSettings = {
  theme: 'ocean',
  selectedProjectId: '',
  autoSaveInterval: '3000',
  uiScale: 1,
  darkMode: false,
  darkModeStyle: 'standard',
}

export async function getUserAppSettings(userId: string): Promise<UserAppSettings> {
  const { rows } = await query<{
    theme: string
    selected_project_id: string
    auto_save_interval: string
    ui_scale: number
    dark_mode: boolean
    dark_mode_style: string
  }>(
    `SELECT theme, selected_project_id, auto_save_interval, ui_scale, dark_mode, dark_mode_style
     FROM user_app_settings WHERE user_id = $1`,
    [userId],
  )
  const row = rows[0]
  if (!row) return { ...defaults }
  return {
    theme: row.theme,
    selectedProjectId: row.selected_project_id,
    autoSaveInterval: row.auto_save_interval,
    uiScale: row.ui_scale,
    darkMode: row.dark_mode,
    darkModeStyle: row.dark_mode_style,
  }
}

export async function upsertUserAppSettings(
  userId: string,
  input: Partial<UserAppSettings>,
): Promise<UserAppSettings> {
  const current = await getUserAppSettings(userId)
  const next = { ...current, ...input }
  await query(
    `INSERT INTO user_app_settings
       (user_id, theme, selected_project_id, auto_save_interval, ui_scale, dark_mode, dark_mode_style, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (user_id) DO UPDATE SET
       theme = EXCLUDED.theme,
       selected_project_id = EXCLUDED.selected_project_id,
       auto_save_interval = EXCLUDED.auto_save_interval,
       ui_scale = EXCLUDED.ui_scale,
       dark_mode = EXCLUDED.dark_mode,
       dark_mode_style = EXCLUDED.dark_mode_style,
       updated_at = now()`,
    [
      userId,
      next.theme,
      next.selectedProjectId,
      next.autoSaveInterval,
      next.uiScale,
      next.darkMode,
      next.darkModeStyle,
    ],
  )
  return next
}
