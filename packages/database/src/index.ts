export {
  checkIntegrity,
  execute,
  openDatabase,
  queryAll,
  queryOne,
  statement,
  withTransaction,
  type Database,
  type OpenDatabaseOptions,
  type SqlParam,
  type SqlParams,
} from './sqlite';
export { DATABASE_FILE, defaultDataDirectory } from './data-dir';
export {
  applyPendingRestore,
  checkDatabaseFile,
  createBackup,
  listBackups,
  pruneAutomaticBackups,
  readRestoreResult,
  stageRestore,
  verifyBackup,
  RESTORE_PENDING_FILE,
  RESTORE_RESULT_FILE,
  type BackupCheckResult,
  type BackupManifest,
  type BackupRecord,
  type PendingRestore,
  type RestoreOutcome,
} from './backup';
export { getSchemaVersion, migrate, MigrationError, type Migration, type MigrationResult } from './migrate';
export { migrations } from './migrations';
export {
  connectionsRepo,
  type ConnectionIdentity,
  type ConnectionPlatform,
  type ConnectionRecord,
  type ConnectionRecordStatus,
  type ConnectionRole,
} from './repositories/connections';
export {
  chatCommandsRepo,
  type ChatCommandCooldownMode,
  type ChatCommandPermission,
  type ChatCommandPlatform,
  type ChatCommandRecord,
} from './repositories/chat-commands';
export { commandCountersRepo } from './repositories/command-counters';
export { discordProtectionEventsRepo, type DiscordProtectionEventRecord } from './repositories/discord-protection-events';
export { discordQuarantineRepo, type DiscordQuarantineRecord } from './repositories/discord-quarantine';
export { discordPostedMessagesRepo, type DiscordPostedMessageRecord } from './repositories/discord-posted-messages';
export { discordLogEntriesRepo, type DiscordLogEntryRecord } from './repositories/discord-log-entries';
export { discordMessageTextsRepo, type DiscordMessageTextRecord } from './repositories/discord-message-texts';
export { kickClipsRepo, type KickClipRecord, type KickClipSeen } from './repositories/kick-clips';
export { kickChattersRepo } from './repositories/kick-chatters';
export { discordModerationEventsRepo, type DiscordModerationEventAction, type DiscordModerationEventRecord } from './repositories/discord-moderation-events';
export { discordCommandsRepo, type CommandRegistrationRecord } from './repositories/discord-commands';
export {
  giveawaysRepo,
  type GiveawayDrawRecord,
  type GiveawayEntryRecord,
  type GiveawayRecord,
  type GiveawayRedemptionRecord,
  type GiveawayWinnerRecord,
} from './repositories/giveaways';
export { discordRepo, type DiscordApplicationRecord, type DiscordGuildRecord } from './repositories/discord';
export { auditRepo, type AuditEntry, type AuditOutcome, type AuditRecord } from './repositories/audit';
export {
  profilesRepo,
  type MemberRecord,
  type MembershipRole,
  type ProfilePatch,
  type ProfileRecord,
  type ProfileRole,
  type ProfileWithRole,
} from './repositories/profiles';
export {
  logEventsRepo,
  notifiersRepo,
  savedEmbedsRepo,
  stickyRepo,
  timedMessagesRepo,
  type NotifierRecord,
  type NotifierState,
  type SavedEmbedRecord,
  type StickyRecord,
  type TimedMessageRecord,
} from './repositories/discord-features';
export {
  loyaltyRepo,
  type LoyaltyAccountRecord,
  type LoyaltyPlatform,
  type LoyaltyRedemptionRecord,
  type LoyaltyRedemptionStatus,
  type LoyaltyRewardRecord,
  type LoyaltyTransactionKind,
  type LoyaltyTransactionRecord,
} from './repositories/loyalty';
export {
  loyaltyLevelsRepo,
  type LoyaltyLevelRecord,
  type LoyaltyMemberRow,
  type LoyaltyRoleGrantRecord,
  type LoyaltyRoleRewardRecord,
  type LoyaltyXpEventRecord,
} from './repositories/loyalty-levels';
export { moderationRepo, type ModerationRecord, type ModerationRuleName } from './repositories/moderation';
export { sessionsRepo, type SessionRecord } from './repositories/sessions';
export { SETTING_KEYS, settingsRepo } from './repositories/settings';
export { usersRepo, type SystemRole, type UserRecord, type UserStatus } from './repositories/users';
