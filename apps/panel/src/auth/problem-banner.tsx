import { Banner } from '@mondapac-drive/ui';

/** The form-level message of a failed save; it takes focus when no field is invalid. */
export function ProblemBanner({ message }: { readonly message: string }) {
  return (
    <div data-form-problem tabIndex={-1}>
      <Banner tone="critical">{message}</Banner>
    </div>
  );
}
