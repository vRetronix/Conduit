import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiClientError } from '../api';
import { fieldError, issuesToFieldErrors, schemaFieldErrors } from '../components/forms';

describe('form field errors (one way for every page)', () => {
  const schema = z.object({ name: z.string().min(1, 'Enter a name').max(3, 'Too long'), activity: z.object({ url: z.string().url('Enter a link') }) });

  it('keys client errors like the server’s validation issues ("activity.url"), first issue per field', () => {
    expect(schemaFieldErrors(schema, { name: '', activity: { url: 'nope' } })).toEqual({ name: 'Enter a name', 'activity.url': 'Enter a link' });
    expect(schemaFieldErrors(schema, { name: 'ok', activity: { url: 'https://x.test' } })).toEqual({});
    expect(issuesToFieldErrors([{ path: ['x'], message: 'first' }, { path: ['x'], message: 'second' }])).toEqual({ x: 'first' });
  });

  it('keeps a whole-form issue (so the form still can’t be submitted)', () => {
    const whole = z.object({ a: z.string() }).refine(() => false, 'Not allowed');
    expect(schemaFieldErrors(whole, { a: 'x' })).toEqual({ '': 'Not allowed' });
  });

  it('shows the client check first, then the server’s answer for that field', () => {
    const server = new ApiClientError(400, { code: 'validation_error', message: 'Invalid', issues: [{ path: 'activity.url', message: 'Server says no' }] });
    expect(fieldError('activity.url', { 'activity.url': 'Enter a link' }, server)).toBe('Enter a link');
    expect(fieldError('activity.url', {}, server)).toBe('Server says no');
    expect(fieldError('name', {}, server)).toBeUndefined();
    expect(fieldError('name', {}, new Error('offline'))).toBeUndefined();
  });
});
