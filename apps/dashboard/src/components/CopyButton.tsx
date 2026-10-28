import { useEffect, useState } from 'react';
import { Button } from './forms';

/**
 * Copies `text` to the clipboard and says so. If the clipboard is unavailable, it explains how to copy by hand
 * instead of failing silently (the text it belongs to is select-all on click).
 */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);

  useEffect(() => {
    if (result !== 'copied') return;
    const timer = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(timer);
  }, [result]);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setResult('copied');
    } catch {
      setResult('failed');
    }
  }

  return (
    <>
      <Button variant="ghost" onClick={() => void copy()} aria-live="polite">
        {result === 'copied' ? 'Copied' : label}
      </Button>
      {result === 'failed' && (
        <span className="field-error" role="alert">
          Couldn't copy automatically. Select the address and press Ctrl+C.
        </span>
      )}
    </>
  );
}
