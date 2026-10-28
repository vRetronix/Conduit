import type { RecoveryResult } from './recovery';

/** Operator-facing text for a recovery result. The temporary password appears here only — never in logs. */
export function formatRecoveryResult(result: RecoveryResult, dataDir: string): { text: string; exitCode: number } {
  if (!result.ok) return { text: `Recovery refused (${result.code}): ${result.message}`, exitCode: 1 };
  return {
    exitCode: 0,
    text: [
      `Administrator password reset for "${result.username}".`,
      `Data folder: ${dataDir}`,
      `Sessions signed out: ${result.sessionsRevoked}`,
      '',
      `Temporary password:  ${result.temporaryPassword}`,
      '',
      'Start CONDUIT and sign in with this temporary password. You will be asked to choose a new password',
      'before you can do anything else. Do not store the temporary password anywhere.',
    ].join('\n'),
  };
}
