import { Icon } from '../icon/icon.tsx';
import type { NavItem } from './nav.ts';

export interface SidebarProps {
  readonly panelName: string;
  readonly items: readonly NavItem[];
  readonly activeId: string;
  /** Resolves a label key through the app's message catalogue. */
  readonly label: (key: string) => string;
}

// Inside the shell's column the sidebar can be an icon rail (`data-rail` on the `rail` group):
// labels stay for screen readers and every icon sits on the rail's centre line.
const RAIL_HIDDEN = 'group-data-[rail=true]/rail:sr-only';

export function Sidebar({ panelName, items, activeId, label }: SidebarProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-(--mp-size-topbar-phone) shrink-0 items-center gap-(--mp-space-2-5) border-b border-line px-4 pe-14 font-semibold text-fg md:h-(--mp-size-topbar) md:pe-4 group-data-[rail=true]/rail:justify-center group-data-[rail=true]/rail:px-0">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-on-accent"
        >
          {panelName.charAt(0)}
        </span>
        <span className={`min-w-0 truncate ${RAIL_HIDDEN}`}>{panelName}</span>
      </div>
      <nav
        aria-label={panelName}
        className="flex flex-col gap-1 overflow-y-auto overflow-x-hidden p-3"
      >
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <a
              key={item.id}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-(--mp-space-2-5) min-h-(--mp-size-control) rounded-md px-3 py-1 group-data-[rail=true]/rail:justify-center ${
                active
                  ? 'bg-selected font-medium text-link'
                  : 'text-fg-secondary hover:bg-muted hover:text-fg'
              }`}
            >
              <Icon name={item.icon} className={active ? undefined : 'text-icon'} />
              <span className={`min-w-0 break-words md:truncate ${RAIL_HIDDEN}`}>
                {label(item.labelKey)}
              </span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
