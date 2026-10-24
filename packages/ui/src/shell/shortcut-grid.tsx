import { Icon, type IconName } from '../icon/icon.tsx';

export interface Shortcut {
  readonly id: string;
  readonly href: string;
  readonly icon: IconName;
  readonly title: string;
  /** One line on what the page is for. */
  readonly body: string;
}

/**
 * Links to the sections a person may open, as cards (a home page): the icon and name of the
 * section with one line on what it is for. One column on phones, two from 640 px, three from
 * 1280 px.
 */
export function ShortcutGrid({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly Shortcut[];
}) {
  return (
    <nav aria-label={label}>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <li key={item.id} className="flex">
            <a
              href={item.href}
              className="flex w-full items-start gap-3 rounded-lg border border-line bg-surface p-4 hover:bg-muted"
            >
              <span className="flex size-(--mp-size-control-lg) shrink-0 items-center justify-center rounded-md bg-muted text-icon">
                <Icon name={item.icon} />
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="break-words font-medium text-link">{item.title}</span>
                <span className="text-sm text-fg-muted">{item.body}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
