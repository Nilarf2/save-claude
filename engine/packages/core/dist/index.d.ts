import { type AdventureModule, type CompiledStory, type GameSession, type SessionOptions, type Story } from "@text-adventure/module-api";
export declare function createSession(input: CompiledStory | Story, modulesOrOptions?: readonly AdventureModule[] | SessionOptions, maybeOptions?: SessionOptions): GameSession;
export default createSession;
