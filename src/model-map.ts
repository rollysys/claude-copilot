/**
 * Map Claude Code's Anthropic-canonical model identifiers to GitHub Copilot's
 * dotted/short IDs.
 *
 *   claude-opus-4-7              → claude-opus-4.7
 *   claude-haiku-4-5-20251001    → claude-haiku-4.5
 *   claude-3-5-sonnet-20241022   → claude-3.5-sonnet
 *
 * Two transforms applied to `claude-*` ids only:
 *   1. trailing date stamp `-YYYYMMDD` is dropped (Copilot doesn't accept it)
 *   2. version digits `<a>-<b>` become `<a>.<b>` (e.g. 4-7 → 4.7)
 *
 * Non-claude ids pass through untouched.
 */

const VERSION_RE = /-(\d+)-(\d+)(?=$|-)/;
const DATE_SUFFIX_RE = /-\d{8}$/;

export function mapModelToCopilot(model: string): string {
  if (!model.startsWith('claude-')) return model;
  let out = model.replace(DATE_SUFFIX_RE, '');
  out = out.replace(VERSION_RE, '-$1.$2');
  return out;
}
