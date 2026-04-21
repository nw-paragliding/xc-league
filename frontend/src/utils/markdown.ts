// =============================================================================
// Shared markdown rendering config for user-authored league descriptions.
// Enables GitHub-style alert callouts (> [!NOTE] / [!TIP] / [!IMPORTANT]
// / [!WARNING] / [!CAUTION]) while keeping sanitization turned on.
// =============================================================================

import { defaultSchema } from 'rehype-sanitize';
import { remarkAlert } from 'remark-github-blockquote-alert';

// The alert plugin emits <div class="markdown-alert markdown-alert-note"> and
// an inline <svg><path /></svg> icon. The default sanitize schema strips
// class attributes and unknown tags, so widen it just enough to keep alerts
// intact.
export const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'svg', 'path'],
  attributes: {
    ...defaultSchema.attributes,
    div: [...((defaultSchema.attributes ?? {}).div ?? []), 'className'],
    p: [...((defaultSchema.attributes ?? {}).p ?? []), 'className'],
    svg: ['className', 'viewBox', 'width', 'height', 'fill', 'xmlns', 'ariaHidden'],
    path: ['d', 'fillRule', 'clipRule'],
  },
};

export const markdownRemarkPlugins = [remarkAlert];
