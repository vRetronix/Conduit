import { auditRepo, type AuditEntry, type Database } from '@conduit/database';
import { redact } from '@conduit/logger';

export type AuditAction =
  | 'setup.completed'
  | 'auth.login'
  | 'auth.logout'
  | 'session.revoked'
  | 'password.changed'
  | 'profile.created'
  | 'profile.updated'
  | 'member.added'
  | 'member.role_changed'
  | 'member.removed'
  | 'profile.ownership_transferred'
  | 'user.created'
  | 'user.status_changed'
  | 'user.password_reset'
  | 'user.password_recovered'
  | 'connection.created'
  | 'connection.removed'
  | 'connection.expired'
  | 'discord.application.saved'
  | 'discord.application.removed'
  | 'discord.bot.installed'
  | 'discord.commands.registered'
  | 'discord.command.used'
  | 'kick.chat.sent'
  | 'giveaway.created'
  | 'giveaway.started'
  | 'giveaway.ended'
  | 'giveaway.cancelled'
  | 'giveaway.deleted'
  | 'giveaway.drawn'
  | 'giveaway.redrawn'
  | 'giveaway.messages_updated'
  | 'moderation.action'
  | 'moderation.automod_updated'
  | 'automation.created'
  | 'automation.updated'
  | 'automation.deleted'
  | 'timed_message.created'
  | 'timed_message.updated'
  | 'timed_message.deleted'
  | 'sticky.created'
  | 'sticky.updated'
  | 'sticky.deleted'
  | 'notifier.created'
  | 'notifier.updated'
  | 'notifier.deleted'
  | 'discord_logging.updated'
  | 'kick_clips.updated'
  | 'kick_clips.login_set'
  | 'kick_clips.login_removed'
  | 'embed.saved'
  | 'embed.deleted'
  | 'embed.message_sent'
  | 'embed.message_edited'
  | 'embed.message_loaded'
  | 'embed.message_recreated'
  | 'embed.message_removed'
  | 'user.sessions_revoked'
  | 'backup.settings_updated'
  | 'backup.created'
  | 'backup.restore_requested'
  | 'loyalty.settings_updated'
  | 'loyalty.adjusted'
  | 'loyalty.reward_created'
  | 'loyalty.reward_updated'
  | 'loyalty.reward_removed'
  | 'loyalty.redemption_resolved'
  | 'loyalty.xp_adjusted'
  | 'loyalty.reset'
  | 'loyalty.role_reward_added'
  | 'loyalty.role_reward_removed'
  | 'discord.protection.messages_updated'
  | 'discord.protection.antinuke_updated'
  | 'discord.protection.quarantine_restored'
  | 'discord.protection.quarantine_released'
  | 'discord.protection.antiraid_updated'
  | 'discord.protection.lockdown_raised'
  | 'discord.protection.lockdown_lifted'
  | 'discord.protection.botbait_updated'
  | 'discord.protection.botbait_warning_posted'
  | 'discord.automod.rule_created'
  | 'discord.automod.rule_updated'
  | 'discord.automod.rule_enabled'
  | 'discord.automod.rule_disabled'
  | 'discord.automod.rule_deleted';

export interface AuditEvent extends Omit<AuditEntry, 'action'> {
  action: AuditAction;
}

/**
 * Writes an audit record. Call it inside the same transaction as the change it describes, so the change
 * and its audit record commit or roll back together. Metadata passes through the log redactor as a backstop.
 */
export function writeAudit(db: Database, event: AuditEvent, now: Date): void {
  auditRepo.insert(
    db,
    { ...event, metadata: event.metadata ? (redact(event.metadata) as Record<string, unknown>) : undefined },
    now.toISOString(),
  );
}
