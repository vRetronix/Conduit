import { EventEmitter } from 'node:events';

/** In-process domain events. The realtime layer uses them to cut off access immediately. */
export interface DomainEvents {
  /** Sessions that must stop working now (logout, revocation, password change, account disabled). */
  'sessions.revoked': { sessionIds: string[] };
  /** A user's membership in a profile was added, changed or removed, or ownership moved. */
  'membership.changed': { profileId: string; userIds: string[] };
  'profile.updated': { profileId: string };
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  on<K extends keyof DomainEvents>(event: K, listener: (payload: DomainEvents[K]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  emit<K extends keyof DomainEvents>(event: K, payload: DomainEvents[K]): void {
    this.emitter.emit(event, payload);
  }
}
