// Tiny inline markdown renderer for assistant chat bubbles. Block-level
// structure (paragraphs, list bullets) is handled by CSS `white-space:
// pre-wrap` — agents emit plain dashes for lists which read fine as-is.
//
// Only inline transforms here: **bold**, *italic*, `code`. HTML is escaped
// first so anything the agent emits is safe to set via innerHTML.

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInlineMarkdown(text) {
  let s = escapeHtml(text);
  // Inline code first so its contents aren't reinterpreted.
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold **…** before italic *…* so we don't half-eat asterisks.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italic *…* — single asterisks, not preceded or followed by another *.
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}
