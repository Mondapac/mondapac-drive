/**
 * Figma TableCell State=Loading: placeholder rows while a list loads. The label is read by screen
 * readers; the bars are decoration.
 */
export function SkeletonRows({
  label,
  rows = 3,
}: {
  readonly label: string;
  readonly rows?: number;
}) {
  return (
    <div role="status" className="rounded-lg border border-line bg-surface">
      <span className="sr-only">{label}</span>
      <ul aria-hidden="true" className="divide-y divide-line-row">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="flex flex-col gap-2 p-4 motion-safe:animate-pulse">
            <span className="h-3 w-2/5 rounded-sm bg-muted" />
            <span className="h-3 w-3/5 rounded-sm bg-muted" />
          </li>
        ))}
      </ul>
    </div>
  );
}
