import { AssetDefinition, AudioChannel, RuntimeEffect, SessionSnapshot, SessionState, Story } from "@text-adventure/module-api";
import { SaveEntry, SaveRecord, SaveStore } from "@text-adventure/save";
export declare class LocalStorageSaveStore implements SaveStore {
    private readonly prefix;
    private readonly storage;
    constructor(storage?: Storage, prefix?: string);
    list(gameId?: string): Promise<SaveEntry[]>;
    read(slotId: string): Promise<SaveRecord | null>;
    write(record: SaveRecord): Promise<void>;
    delete(slotId: string): Promise<boolean>;
    private key;
}
export interface FadeOptions {
    fadeMs?: number;
}
export interface MusicOptions extends FadeOptions {
    loop?: boolean;
    volume?: number;
    channel?: AudioChannel;
}
export type AssetResolver = (assetId: string, definition?: AssetDefinition) => string | undefined | null | Promise<string | undefined | null>;
export interface AudioFailureContext {
    operation: string;
    assetId?: string;
    channel?: AudioChannel;
}
export interface AudioAdapterOptions {
    assets?: Story["assets"];
    resolveAsset?: AssetResolver;
    onError?: (error: unknown, context: AudioFailureContext) => void;
    createAudio?: (source: string) => HTMLAudioElement;
    fadeTickMs?: number;
}
export interface AudioPort {
    playMusic(assetId: string, options?: MusicOptions): Promise<void>;
    playAmbience(assetId: string, options?: Omit<MusicOptions, "channel">): Promise<void>;
    playSfx(assetId: string, volume?: number): Promise<void>;
    stopMusic(options?: FadeOptions): Promise<void>;
    stopAmbience(options?: FadeOptions): Promise<void>;
    pause(channel?: AudioChannel): void;
    resume(channel?: AudioChannel): Promise<void>;
    setVolume(channel: AudioChannel, volume: number, fadeMs?: number): Promise<void>;
}
export declare class WebAudioAdapter implements AudioPort {
    private readonly options;
    private readonly channels;
    private readonly generations;
    private readonly fades;
    private readonly soundEffects;
    private readonly blockedEffects;
    private disposed;
    private readonly createAudio;
    constructor(options?: AudioAdapterOptions);
    playMusic(assetId: string, options?: MusicOptions): Promise<void>;
    playAmbience(assetId: string, options?: Omit<MusicOptions, "channel">): Promise<void>;
    playSfx(assetId: string, volume?: number): Promise<void>;
    stopMusic(options?: FadeOptions): Promise<void>;
    stopAmbience(options?: FadeOptions): Promise<void>;
    stop(channel: AudioChannel, options?: FadeOptions): Promise<void>;
    pause(channel?: AudioChannel): void;
    resume(channel?: AudioChannel): Promise<void>;
    setVolume(channel: AudioChannel, volume: number, fadeMs?: number): Promise<void>;
    unlock(): Promise<void>;
    handleEffect(effect: RuntimeEffect): Promise<void>;
    reconcile(snapshot: SessionSnapshot | SessionState): Promise<void>;
    dispose(): void;
    private playTrack;
    private resolveAsset;
    private tryPlay;
    private fadeTo;
    private nextGeneration;
    private generation;
    private cancelFade;
    private releaseTrack;
    private releaseSfx;
    private clampVolume;
    private clampDuration;
    private report;
}
