import { useEffect, useState } from 'react';

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event('brc:navigate'));
}

export function useLocation() {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, search: location.search }));
  useEffect(() => {
    const on = () => setLoc({ path: location.pathname, search: location.search });
    window.addEventListener('popstate', on);
    window.addEventListener('brc:navigate', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('brc:navigate', on);
    };
  }, []);
  return loc;
}
