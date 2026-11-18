// Display formatting. Only the enumerated codes in shared/FORMAT.md are supported.

import { isErr, numberToText } from './values.js';

export const NUM_FORMATS = ['general', '0', '0.00', '#,##0', '#,##0.00', '0%', '0.00%', '$#,##0.00'];

function fixed(n, digits, grouping) {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: grouping,
  });
}

/** General: integers as-is, otherwise up to 10 significant digits. */
export function formatGeneral(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return numberToText(Number(n.toPrecision(10)));
}

/** Value -> display string for a cell. */
export function formatValue(v, numFmt = 'general') {
  if (v === null || v === undefined) return '';
  if (isErr(v)) return v.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v !== 'number') return String(v);
  switch (numFmt) {
    case '0': return fixed(v, 0, false);
    case '0.00': return fixed(v, 2, false);
    case '#,##0': return fixed(v, 0, true);
    case '#,##0.00': return fixed(v, 2, true);
    case '0%': return fixed(v * 100, 0, false) + '%';
    case '0.00%': return fixed(v * 100, 2, false) + '%';
    case '$#,##0.00': return (v < 0 ? '-$' : '$') + fixed(Math.abs(v), 2, true);
    default: return formatGeneral(v);
  }
}

