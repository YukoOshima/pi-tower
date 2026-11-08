import { TowerProtocolError } from '../protocol/index.ts';

export class BranchLeases {
  private readonly leased = new Set<string>();

  isLeased(branch: string): boolean {
    return this.leased.has(branch);
  }

  async withLease<T>(branch: string, execute: () => Promise<T>): Promise<T> {
    if (this.leased.has(branch)) {
      throw new TowerProtocolError(
        `branch "${branch}" is leased by another tower merge/rebase — not waiting; retry after that operation finishes`,
      );
    }
    this.leased.add(branch);
    try {
      return await execute();
    } finally {
      this.leased.delete(branch);
    }
  }
}
