import { join } from 'node:path'

export const PROFILE_STATE_DATABASE_FILE_NAME = 'profile-state.db'

export function profileStateDatabaseFile(profileDirectory: string): string {
  return join(profileDirectory, PROFILE_STATE_DATABASE_FILE_NAME)
}

export function getHiveWardProfileDataFile(profileId: string, userDataPath: string): string {
  return join(userDataPath, 'profiles', profileId, 'hiveward-data.json')
}

export function getHiveWardProfileStateDatabaseFile(profileId: string, userDataPath: string): string {
  return profileStateDatabaseFile(join(userDataPath, 'profiles', profileId))
}
