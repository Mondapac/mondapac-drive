'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../icon/icon.tsx';

/** Gap between the menu and its trigger, and the least space kept to the viewport edge. */
const GAP = 4;
const EDGE = 8;

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** A disabled item stays visible; `reason` says why and is read with it. */
  readonly disabled?: boolean;
  readonly reason?: string;
  readonly tone?: 'default' | 'critical';
  readonly icon?: IconName;
  /** Set on every item of a choose-one menu: the items become radio items, the chosen one ticked. */
  readonly checked?: boolean;
  readonly onSelect: () => void;
}

export interface MenuProps {
  /** Accessible name of the trigger, e.g. "Actions for Ada". */
  readonly label: string;
  readonly items: readonly MenuItem[];
  /** The trigger's icon; without one the trigger shows an ellipsis. */
  readonly icon?: IconName;
  /** Pointer hint on the trigger, such as the current choice. */
  readonly title?: string;
  /** `narrow` suits a few short labels, such as a choose-one menu. */
  readonly width?: 'default' | 'narrow';
}

/** A button that opens a menu of actions (WAI-ARIA menu button: arrows, Home, End, Escape). */
export function Menu({ label, items, icon, title, width = 'default' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [place, setPlace] = useState<CSSProperties | null>(null);

  // The list is drawn in a portal with fixed coordinates, so a table box with overflow never
  // clips it. It lines up with the trigger's end edge and opens upwards when there is no room.
  const position = useCallback(() => {
    const button = trigger.current;
    const node = list.current;
    if (button === null || node === null) return;
    const anchor = button.getBoundingClientRect();
    const width = Math.min(node.offsetWidth, window.innerWidth - 2 * EDGE);
    const left = getComputedStyle(button).direction === 'rtl' ? anchor.left : anchor.right - width;
    const below = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const openUp = node.scrollHeight > below && above > below;
    setPlace({
      left: Math.min(Math.max(left, EDGE), window.innerWidth - width - EDGE),
      maxHeight: Math.max(openUp ? above : below, 0),
      ...(openUp
        ? { bottom: window.innerHeight - anchor.top + GAP }
        : { top: anchor.bottom + GAP }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return undefined;
    }
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, position]);

  const focusItem = (index: number) => {
    const nodes = list.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemradio"]',
    );
    if (nodes === undefined || nodes.length === 0) return;
    nodes[(index + nodes.length) % nodes.length]?.focus();
  };

  useEffect(() => {
    // A choose-one menu opens on the chosen item (WAI-ARIA menu with radio items).
    if (open)
      focusItem(
        Math.max(
          0,
          items.findIndex((item) => item.checked === true),
        ),
      );
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nodes = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ??
        [],
    );
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') focusItem(at + 1);
    else if (event.key === 'ArrowUp') focusItem(at - 1);
    else if (event.key === 'Home') focusItem(0);
    else if (event.key === 'End') focusItem(nodes.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      if (event.key === 'Escape') trigger.current?.focus();
      return;
    } else return;
    event.preventDefault();
  };

  return (
    <div className="inline-block">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={title}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-(--mp-size-control) w-(--mp-size-control) items-center justify-center rounded-md border border-line-control bg-surface text-fg hover:bg-muted"
      >
        {icon === undefined ? <span aria-hidden="true">⋯</span> : <Icon name={icon} />}
      </button>
      {open
        ? createPortal(
            <div
              ref={list}
              id={menuId}
              role="menu"
              aria-label={label}
              onKeyDown={onKeyDown}
              style={{
                position: 'fixed',
                ...place,
                visibility: place === null ? 'hidden' : 'visible',
              }}
              className={`z-50 ${width === 'narrow' ? 'w-44' : 'w-64'} max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg`}
            >
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={item.checked}
                  aria-disabled={item.disabled === true ? true : undefined}
                  tabIndex={-1}
                  onClick={() => {
                    if (item.disabled === true) return;
                    setOpen(false);
                    item.onSelect();
                    trigger.current?.focus();
                  }}
                  className={[
                    // At least one control high: 48 px touch targets on phones (panels IA 4).
                    'flex min-h-(--mp-size-control) w-full flex-col justify-center px-4 py-2 text-start text-sm',
                    item.disabled === true
                      ? 'cursor-not-allowed text-fg-muted'
                      : item.tone === 'critical'
                        ? 'text-critical-fg hover:bg-muted'
                        : 'text-fg hover:bg-muted',
                  ].join(' ')}
                >
                  {item.icon === undefined && item.checked === undefined ? (
                    item.label
                  ) : (
                    <span className="flex items-center gap-(--mp-space-2-5)">
                      {item.icon === undefined ? null : (
                        <Icon name={item.icon} className="text-icon" />
                      )}
                      <span
                        className={`min-w-0 flex-1 ${item.checked === true ? 'font-medium' : ''}`}
                      >
                        {item.label}
                      </span>
                      {item.checked === true ? <Icon name="check" className="text-link" /> : null}
                    </span>
                  )}
                  {item.disabled === true && item.reason !== undefined ? (
                    <span className="mt-0.5 block text-xs font-normal">{item.reason}</span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
