import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { cn } from '../lib/utils';
import { AVATAR_FALLBACK_SRC, resolveAvatarSrc } from '../lib/avatar';
import { avatarAtom } from '../store/settings';

/**
 * The login-dialog avatar: the source chosen in System Settings (Gravatar or
 * an uploaded picture), circle-masked, with the Suwu logo as the fallback
 * whenever nothing is configured or the image fails to load.
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
  const src = resolveAvatarSrc(settings, size);
  const [failed, setFailed] = useState(false);

  // A new source gets a fresh chance before we give up and show the logo.
  useEffect(() => setFailed(false), [src]);

  return (
    <img
      src={failed ? AVATAR_FALLBACK_SRC : src}
      alt={alt}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={cn('rounded-full object-cover', className)}
    />
  );
}
