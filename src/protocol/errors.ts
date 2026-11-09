export class TowerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TowerProtocolError';
  }
}
