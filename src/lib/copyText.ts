/** Copy inside the current dialog so its focus trap preserves the selection. */
export async function copyText(text: string, current: () => boolean = () => true): Promise<boolean> {
  if (!current()) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* HTTP deployments use the dialog-local fallback below. */ }
  if (!current()) return false;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement ? previous : null;
  const start = input?.selectionStart, end = input?.selectionEnd, direction = input?.selectionDirection;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  const container = previous?.closest('[role="dialog"]') || document.querySelector('[role="dialog"]') || document.body;
  try {
    container.appendChild(textarea);
    textarea.focus({ preventScroll: true }); textarea.select();
    return document.execCommand('copy');
  } catch { return false; }
  finally {
    textarea.remove();
    if (previous?.isConnected) {
      previous.focus({ preventScroll: true });
      if (input && start != null && end != null) input.setSelectionRange(start, end, direction || undefined);
    }
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range);
    }
  }
}
