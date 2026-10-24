import { Fragment } from 'react';

/**
 * An email address that wraps before the @ or before a dot of the domain, never inside a word;
 * the container's break-words only breaks a single part longer than its column.
 */
export function EmailText({ address }: { readonly address: string }) {
  const at = address.lastIndexOf('@');
  if (at <= 0) return <>{address}</>;
  const [first, ...rest] = address.slice(at).split('.');
  return (
    <>
      {address.slice(0, at)}
      <wbr />
      {first}
      {rest.map((part, index) => (
        <Fragment key={index}>
          <wbr />.{part}
        </Fragment>
      ))}
    </>
  );
}
