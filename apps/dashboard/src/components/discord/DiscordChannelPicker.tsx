import { useEffect, useState } from 'react';
import { missingDiscordPermissions, type DiscordPermissionKey } from '@conduit/shared/discord/embeds';
import type { DiscordChannelsState } from '@conduit/shared/community/giveaways';
import { api, errorMessage } from '../../api';

/** The bot's servers and channels (with its permissions), loaded once per page and shared by its pickers. */
let cache: { at: number; promise: Promise<DiscordChannelsState> } | null = null;
export function useDiscordChannels(): DiscordChannelsState | null {
  const [state, setState] = useState<DiscordChannelsState | null>(null);
  useEffect(() => {
    if (!cache || Date.now() - cache.at > 30_000) cache = { at: Date.now(), promise: api<DiscordChannelsState>('GET', '/api/giveaways/discord/channels') };
    cache.promise.then(setState, (err) => setState({ guilds: [], problem: errorMessage(err) }));
  }, []);
  return state;
}

/**
 * Chooses a server + text channel. Channels where the bot lacks a permission this feature needs are disabled and say
 * which one, so a choice that can't work can't be made.
 */
export function DiscordChannelPicker({
  channels,
  guildId,
  channelId,
  needs,
  onChange,
  label = 'Discord channel',
  error,
}: {
  channels: DiscordChannelsState | null;
  guildId: string;
  channelId: string;
  needs: readonly DiscordPermissionKey[];
  onChange: (guildId: string, channelId: string) => void;
  label?: string;
  error?: string;
}) {
  // A saved channel that isn't in the list (Discord busy, or the list not loaded yet) stays selected.
  const listed = channels?.guilds.some((g) => g.id === guildId && g.channels.some((c) => c.id === channelId)) ?? false;
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        value={channelId ? `${guildId}:${channelId}` : ''}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          const [g = '', c = ''] = e.target.value.split(':');
          onChange(g, c);
        }}
      >
        <option value="">{channels ? 'Choose a channel…' : 'Loading channels…'}</option>
        {channelId && !listed && <option value={`${guildId}:${channelId}`}>Saved channel (list unavailable right now)</option>}
        {channels?.guilds.map((g) => (
          <optgroup key={g.id} label={g.name}>
            {g.channels.map((c) => {
              const missing = missingDiscordPermissions(c.permissions, needs);
              return (
                <option key={c.id} value={`${g.id}:${c.id}`} disabled={missing.length > 0}>
                  #{c.name}
                  {missing.length ? ` — bot needs ${missing.join(', ')}` : ''}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
      {error ? <span className="field-error">{error}</span> : channels?.problem ? <span className="field-hint text-warn">{channels.problem}</span> : null}
    </label>
  );
}
