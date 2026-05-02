import { AuditEvent, AuditAction } from '../types';

// Maps the existing AuditAction enum to the design's activity-log display
// strings. Falls back to lowercase action verb if a mapping isn't defined.
const DISPLAY: Partial<Record<AuditAction, string>> = {
  'EOD entry':         'submitted EOD count',
  'Item edit':         'edited item',
  'Item added':        'added item',
  'Item deleted':      'deleted item',
  'POS import':        'imported POS',
  'Waste log':         'logged waste',
  'User invite':       'invited user',
  'Recipe saved':      'saved recipe',
  'Prep recipe saved': 'saved prep recipe',
  'Stock adjusted':    'adjusted stock',
};

export function formatAuditAction(event: Pick<AuditEvent, 'action'>): string {
  return DISPLAY[event.action] ?? event.action.toLowerCase();
}
