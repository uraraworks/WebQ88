/** 「…」メニューの DOM に依存しない状態遷移。 */
export type OverflowGroup = 'display' | 'input' | 'sound' | 'disk' | 'rom';
export type OverflowState = { level: 'closed' } | { level: 'root' } | { level: 'group'; group: OverflowGroup };

export const closedMenu: OverflowState = { level: 'closed' };
export const rootMenu: OverflowState = { level: 'root' };

export function toggleMenu(state: OverflowState): OverflowState {
  return state.level === 'closed' ? rootMenu : closedMenu;
}

export function selectGroup(state: OverflowState, group: OverflowGroup): OverflowState {
  return state.level === 'group' && state.group === group ? rootMenu : { level: 'group', group };
}

export function isWideMenu(width: number): boolean {
  return width >= 640;
}
