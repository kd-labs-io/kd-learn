import { useEffect, useState } from 'react';

/** An object URL for a blob built from `make`, revoked when inputs change or on unmount. */
export const useObjectUrl = (make: () => Blob | undefined, deps: ReadonlyArray<unknown>) => {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const blob = make();
    if (blob === undefined) {
      setUrl(undefined);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, deps);
  return url;
};
