// src/screens/staff/components/CountOrderDragList.a11y.test.tsx — Spec 103
// review-fix pass (code-reviewer Critical).
//
// The staff CountOrderDragList is shared by BOTH the staff EOD screen and the
// staff Weekly screen. Before the fix it hardcoded `eod.reorder.moveUp`/
// `eod.reorder.moveDown` as the native ▲/▼ accessibility labels, so the Weekly
// Custom view announced its move buttons as EOD actions in every locale. The
// fix threads a screen-aware `moveUpLabel`/`moveDownLabel` prop pair so each
// call site passes its OWN i18n string (EOD → `eod.reorder.*`, Weekly →
// `weekly.reorder.*`).
//
// This renders the NATIVE path (jest's default Platform.OS is a native value,
// so the ▲/▼ buttons render rather than the web @dnd-kit handle) and asserts the
// buttons carry the LABELS PASSED IN — proving they are screen-aware, not
// hardcoded. (English collides — both reorder.moveUp values are literally "Move
// up" — so the test uses distinct sentinel strings to prove the wiring
// unambiguously, the way a non-English locale would surface the original bug.)

import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { CountOrderDragList } from './CountOrderDragList';

type Row = { id: string };
const ITEMS: Row[] = [{ id: 'item-1' }, { id: 'item-2' }];
const renderRow = (i: Row) => <Text>{i.id}</Text>;

describe('staff CountOrderDragList — native ▲/▼ a11y labels are screen-aware', () => {
  it('uses the PASSED moveUp/moveDown labels (e.g. the Weekly screen keys)', () => {
    const { getAllByLabelText } = render(
      <CountOrderDragList
        items={ITEMS}
        onReorder={jest.fn()}
        renderRow={renderRow}
        moveUpLabel="WEEKLY_MOVE_UP"
        moveDownLabel="WEEKLY_MOVE_DOWN"
      />,
    );
    // Two rows → two up buttons + two down buttons, all carrying the WEEKLY
    // labels (NOT the hardcoded eod.reorder.* defaults).
    expect(getAllByLabelText('WEEKLY_MOVE_UP')).toHaveLength(2);
    expect(getAllByLabelText('WEEKLY_MOVE_DOWN')).toHaveLength(2);
  });

  it('falls back to the EOD reorder labels when no label props are given', () => {
    const { getAllByLabelText } = render(
      <CountOrderDragList items={ITEMS} onReorder={jest.fn()} renderRow={renderRow} />,
    );
    // Default staff locale is English: eod.reorder.moveUp = "Move up".
    expect(getAllByLabelText('Move up')).toHaveLength(2);
    expect(getAllByLabelText('Move down')).toHaveLength(2);
  });
});
