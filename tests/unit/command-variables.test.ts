/** Custom command variables: parsing, every value, fallbacks, platforms, and safety (single pass, safe maths). */
import { describe, expect, it } from 'vitest';
import {
  counterOps,
  evalMath,
  fillVariables,
  formatDuration,
  parseCounter,
  unsupportedVariables,
  VARIABLES,
  variableTokens,
  type VariableData,
} from '@conduit/shared/community/command-variables';
import { renderCommand, unknownVariables, usesCommandText } from '@conduit/shared/community/custom-commands';

const NOW = new Date('2026-10-18T12:00:00Z');
const base = (over: Partial<VariableData> = {}): VariableData => ({ user: 'RetroFan', userId: '42', channel: 'retronix', args: '@Bob is here', message: '!hug @Bob is here', now: NOW, random: () => 0.5, ...over });
const kick = (t: string, d: Partial<VariableData> = {}) => fillVariables(t, base(d), 'kick');
const discord = (t: string, d: Partial<VariableData> = {}) => fillVariables(t, base(d), 'discord');

describe('parsing', () => {
  it('reads {name}, {name:arg}, {name|fallback} and {name:arg|fallback}', () => {
    expect(variableTokens('{user} {random:1-6} {touser|you} {time:Europe/Paris|?} {3}')).toEqual([
      { whole: '{user}', name: 'user', arg: null, fallback: null },
      { whole: '{random:1-6}', name: 'random', arg: '1-6', fallback: null },
      { whole: '{touser|you}', name: 'touser', arg: null, fallback: 'you' },
      { whole: '{time:Europe/Paris|?}', name: 'time', arg: 'Europe/Paris', fallback: '?' },
      { whole: '{3}', name: '3', arg: null, fallback: null },
    ]);
  });

  it('flags placeholders that aren’t variables, or aren’t available on the platform', () => {
    expect(unsupportedVariables('{user} {nope} {sender.username}')).toEqual(['{nope}', '{sender.username}']);
    expect(unknownVariables('{mention} {points}', 'kick')).toEqual(['{mention}', '{points}']);
    expect(unknownVariables('{submonths} {followage}', 'discord')).toEqual(['{submonths}', '{followage}']);
    expect(unknownVariables('{user} {2} {9}', 'kick')).toEqual([]);
    expect(unknownVariables('{10}', 'kick')).toEqual([]); // not a placeholder at all: posted as written
  });

  it('Discord offers the "text" box only when the reply reads it', () => {
    expect(usesCommandText('Hi {user}')).toBe(false);
    for (const t of ['{args}', '{message}', '{touser}', '{1}']) expect(usesCommandText(t)).toBe(true);
  });

  it('every catalogue entry has a description and an insertable example that parses', () => {
    for (const v of VARIABLES) {
      expect(v.description.length).toBeGreaterThan(5);
      expect(variableTokens(v.insert)[0]?.name).toBe(v.name);
    }
  });
});

describe('values', () => {
  it('user and input: {touser} without @ (or the sender), {1}…{9}, fallbacks', () => {
    expect(kick('{user} hugs {touser}: {1}/{2}/{3}/{4}')).toBe('RetroFan hugs Bob: @Bob/is/here/');
    expect(kick('{touser}', { args: '' })).toBe('RetroFan');
    expect(kick('{4|nothing}')).toBe('nothing');
    expect(kick('{platform} {userid}')).toBe('Kick 42');
    expect(discord('{platform}')).toBe('Discord');
  });

  it('random, pick and maths', () => {
    expect(kick('{random:1-6}')).toBe('4'); // 1 + floor(0.5 * 6)
    expect(kick('{random}')).toBe('51');
    expect(kick('{random:x|bad}')).toBe('bad');
    expect(kick('{pick:heads;tails;edge}')).toBe('tails');
    expect(kick('{math:2*(3+4)} {math:2^10} {math:7/2} {math:-3+1}')).toBe('14 1024 3.5 -2');
    expect(kick('{math:1/0|∞}')).toBe('∞');
  });

  it('maths is arithmetic only: no names, functions or code', () => {
    for (const bad of ['process.exit()', 'alert(1)', '2+', '((1)', '1e999', 'constructor', '2**2**2**999', '9'.repeat(101)]) expect(evalMath(bad)).toBeNull();
  });

  it('time, date, countdown and countup (an invalid time zone uses the fallback)', () => {
    expect(kick('{time:UTC} {date:UTC}')).toBe('12:00 PM October 18, 2026');
    expect(kick('{time:Not/AZone|?}')).toBe('?');
    expect(kick('{countdown:2026-10-20}', { now: new Date(2026, 9, 18, 12, 0) })).toBe('1 day 12 hours');
    expect(kick('{countup:2026-10-18}', { now: new Date(2026, 9, 18, 12, 30) })).toBe('12 hours 30 minutes');
    expect(formatDuration(400 * 86_400_000)).toBe('1 year 1 month');
  });

  it('your Kick stream: live values, "offline", or the fallback when Kick couldn’t be reached', () => {
    const stream = { streamer: 'Retronix', url: 'https://kick.com/retronix', live: true, title: 'Speedruns', category: 'Retro', viewers: 1234, startedAt: '2026-10-18T09:45:00Z' };
    expect(kick('{streamer} — {title} ({category}), {viewers} watching for {uptime} at {url}', { stream })).toBe(
      'Retronix — Speedruns (Retro), 1,234 watching for 2 hours 15 minutes at https://kick.com/retronix',
    );
    expect(kick('{uptime} {viewers|no one}', { stream: { ...stream, live: false } })).toBe('offline no one');
    expect(kick('{uptime|unknown}', { stream: null })).toBe('unknown');
  });

  it('counters, Kick-only and Discord-only values; a variable from the other platform gives its fallback', () => {
    expect(kick('#{count} deaths {counter:deaths+1}', { count: 12, counters: { deaths: 8 } })).toBe('#12 deaths 8');
    expect(kick('{roles} for {submonths} months', { roles: ['Moderator', 'Subscriber'], subMonths: 6 })).toBe('Moderator, Subscriber for 6 months');
    expect(discord('{mention} on {server} ({membercount}): {points}, level {level}, {xp} XP, {rank}', { mention: '<@42>', server: 'Lounge', memberCount: 1500, loyalty: { points: '1,200 points', level: 5, xp: 860, rank: 3 } })).toBe(
      '<@42> on Lounge (1,500): 1,200 points, level 5, 860 XP, #3',
    );
    expect(kick('{mention|@you}', { mention: '<@42>' })).toBe('@you');
  });

});

describe('safety', () => {
  it('single pass: a value containing a variable stays literal; unknown placeholders stay as written', () => {
    expect(kick('{args} {nope}', { args: '{user} {counter:x+1}' })).toBe('{user} {counter:x+1} {nope}');
  });

  it('values are one line and capped; replies are fitted to the platform', () => {
    expect(kick('{args}', { args: 'a\nb\tc' })).toBe('a b c');
    expect(kick('{args}', { args: 'x'.repeat(1000) }).length).toBe(400);
    expect(renderCommand('{args}{args}', base({ args: 'y'.repeat(400) }), 'kick').endsWith('…')).toBe(true);
  });

  it('counter changes are parsed strictly', () => {
    expect(counterOps('{counter:Deaths+2} {counter:wins} {counter:x=0} {counter:y-1} {counter:bad name+1}')).toEqual([
      { name: 'deaths', op: 'add', amount: 2 },
      { name: 'wins', op: 'get', amount: 0 },
      { name: 'x', op: 'set', amount: 0 },
      { name: 'y', op: 'add', amount: -1 },
    ]);
    expect(parseCounter('a+1e9')).toBeNull();
  });
});
