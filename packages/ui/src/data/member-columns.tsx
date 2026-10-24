/**
 * The columns of a team table (person, role, status, actions), shared by the admin and seller
 * Team pages so both panels lay a member out the same way. Person takes what is left; the
 * others have set widths. Below `lg` the table turns into cards and the columns are hidden.
 */
export function MemberColumns() {
  return (
    <colgroup className="max-lg:hidden">
      <col />
      <col className="w-56" />
      <col className="w-36" />
      <col className="w-28" />
    </colgroup>
  );
}
