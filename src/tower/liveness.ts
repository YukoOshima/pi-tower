export interface TowerOwnerRecord {
  readonly sessionId?: string;
  readonly pid?: number;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isOwnerLive(
  owner: TowerOwnerRecord,
  currentSessionId: string | undefined,
  alive: (pid: number) => boolean = isProcessAlive,
): boolean {
  if (owner.pid === undefined || !alive(owner.pid)) return false;
  return owner.pid !== process.pid || owner.sessionId === currentSessionId;
}

export function isForeignLiveOwner(
  owner: TowerOwnerRecord | undefined,
  currentSessionId: string | undefined,
  alive?: (pid: number) => boolean,
): owner is TowerOwnerRecord & { readonly sessionId: string } {
  return (
    owner?.sessionId !== undefined &&
    owner.sessionId !== currentSessionId &&
    isOwnerLive(owner, currentSessionId, alive)
  );
}
