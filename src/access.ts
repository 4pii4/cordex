import type { CordexConfig } from './types.js'

export type AccessPolicy = Pick<
  CordexConfig,
  'allowAllUsers' | 'allowedUserIds' | 'allowedRoleIds'
>

export function userHasAccess(
  policy: AccessPolicy,
  userId: string,
  guildId: string,
  guildOwnerId: string,
  roleIds: Iterable<string>,
): boolean {
  if (userId === guildOwnerId || policy.allowAllUsers) return true
  if (policy.allowedUserIds?.includes(userId)) return true
  const allowedRoleIds = new Set(
    (policy.allowedRoleIds || []).filter((roleId) => roleId !== guildId),
  )
  for (const roleId of roleIds) {
    if (allowedRoleIds.has(roleId)) return true
  }
  return false
}
