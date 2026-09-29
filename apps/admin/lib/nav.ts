import type { Icon } from '@phosphor-icons/react';
import { BellRinging, Fingerprint, GlobeHemisphereWest, ListChecks, LockKey, Pulse, Binoculars, SquaresFour, UsersThree } from '@phosphor-icons/react';

export interface NavItem {
  href: string;
  label: string;
  icon: Icon;
  /** which overview counter (if any) to show beside the label */
  badge?: 'failing' | 'tasks' | 'access';
}

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Operate',
    items: [
      { href: '/overview', label: 'Overview', icon: SquaresFour },
      { href: '/sites', label: 'Sites', icon: GlobeHemisphereWest, badge: 'failing' },
      { href: '/team', label: 'Team', icon: UsersThree },
      { href: '/tasks', label: 'Tasks', icon: ListChecks, badge: 'tasks' },
    ],
  },
  {
    label: 'Security',
    items: [
      { href: '/findings', label: 'Findings', icon: Pulse },
      { href: '/scans', label: 'Scans', icon: Binoculars },
      { href: '/jit', label: 'Access requests', icon: LockKey, badge: 'access' },
      { href: '/telegram', label: 'Alert routing', icon: BellRinging },
      { href: '/security', label: 'Account security', icon: Fingerprint },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
