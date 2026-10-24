import { CompiledStory, GameSession, JsonValue, SessionSnapshot } from "@text-adventure/module-api";
export interface SaveRecord {
    slotId: string;
    snapshot: SessionSnapshot;
    savedAt: string;
    label?: string;
}
export interface SaveEntry {
    slotId: string;
    gameId: string;
    contentVersion: string;
    savedAt: string;
    label?: string;
}
export interface SaveStore {
    list(gameId?: string): Promise<SaveEntry[]>;
    read(slotId: string): Promise<SaveRecord | null>;
    write(record: SaveRecord): Promise<void>;
    delete(slotId: string): Promise<boolean>;
}
export type ContentMigration = (snapshot: SessionSnapshot, compiled: CompiledStory) => SessionSnapshot;
export interface PrepareSnapshotOptions {
    migrateContent?: ContentMigration;
    isModuleVersionCompatible?: (savedVersion: string, currentVersion: string) => boolean;
    isEngineVersionCompatible?: (savedVersion: string, currentVersion: string) => boolean;
}
export declare function validateSnapshot(value: unknown): asserts value is SessionSnapshot;
export declare function serializeSnapshot(snapshot: SessionSnapshot): string;
export declare function parseSnapshot(serialized: string): SessionSnapshot;
/** Validate cursor and story-dependent invariants without migrating or mutating data. */
export declare function validateSnapshotForStory(snapshot: SessionSnapshot, compiled: CompiledStory): void;
export declare function prepareSnapshot(input: SessionSnapshot, compiled: CompiledStory, options?: PrepareSnapshotOptions): SessionSnapshot;
export declare class MemorySaveStore implements SaveStore {
    private readonly records;
    list(gameId?: string): Promise<SaveEntry[]>;
    read(slotId: string): Promise<SaveRecord | null>;
    write(save: SaveRecord): Promise<void>;
    delete(slotId: string): Promise<boolean>;
}
export declare class SaveManager {
    private readonly store;
    constructor(store: SaveStore);
    list(gameId?: string): Promise<SaveEntry[]>;
    read(slotId: string): Promise<SaveRecord | null>;
    save(slotId: string, source: SessionSnapshot | GameSession, label?: string): Promise<void>;
    load(slotId: string, compiled: CompiledStory, options?: PrepareSnapshotOptions): Promise<SessionSnapshot | null>;
    restore(slotId: string, session: GameSession, compiled: CompiledStory, options?: PrepareSnapshotOptions): Promise<import("@text-adventure/module-api").StepResult | null>;
    delete(slotId: string): Promise<boolean>;
    export(slotId: string): Promise<string | null>;
    import(slotId: string, serialized: string, label?: string): Promise<void>;
}
export type { JsonValue };
