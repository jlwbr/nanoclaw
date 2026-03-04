import {
  DurableObjectId,
  DurableObjectState,
  DurableObjectStorage,
} from '../../src/cf-types.js';

class MemoryDurableObjectId implements DurableObjectId {
  constructor(private readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

class MemoryDurableObjectStorage implements DurableObjectStorage {
  private readonly values = new Map<string, unknown>();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm =
      typeof scheduledTime === 'number'
        ? scheduledTime
        : scheduledTime.getTime();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
}

export class MemoryDurableObjectState implements DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  readonly waits: Promise<unknown>[] = [];

  constructor(name: string) {
    this.id = new MemoryDurableObjectId(name);
    this.storage = new MemoryDurableObjectStorage();
  }

  waitUntil(promise: Promise<unknown>): void {
    this.waits.push(promise);
  }
}
