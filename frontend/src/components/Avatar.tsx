import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { cn } from '../lib/utils';
import { AVATAR_FALLBACK_SRC, resolveAvatarSrc } from '../lib/avatar';
import { avatarAtom, userNameAtom } from '../store/settings';

/**
 * The login-dialog avatar: the source chosen in System Settings (a built-in
 * picture, Gravatar, or an uploaded picture), circle-masked. The fallback is
 * the built-in avatar derived from the user name — shown when nothing is
 * configured or the image fails to load — so the app logo is never used as a
 * user picture.
 */
export function Avatar({
  size,
  className,
  alt = '',
}: {
  /** Rendered size in CSS pixels; also drives the Gravatar request size. */
  size: number;
  className?: string;
  alt?: string;
}) {
  const settings = useAtomValue(avatarAtom);
  const userName = useAtomValue(userNameAtom);
  const src = resolveAvatarSrc(settings, size, userName);
  const [failed, setFailed] = useState(false);

  // A new source gets a fresh chance before we give up on it.
  useEffect(() => setFailed(false), [src]);

  // If even the name-derived avatar is missing, one fixed picture ends the loop.
  const shown = failed ? AVATAR_FALLBACK_SRC : src;

  return (
    <img
      src={shown}
      alt={alt}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={cn('rounded-full object-cover', className)}
    />
  );
}
