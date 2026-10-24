import { type Action, type AdventureModule, type CompiledStory, type Condition, type ModuleRegistry, type Story, type ValueExpression } from "@text-adventure/module-api";
export interface Diagnostic {
    code: string;
    message: string;
    path: string;
    severity: "error" | "warning";
}
export interface ValidationResult {
    diagnostics: Diagnostic[];
    valid: boolean;
}
export declare function validateStory(input: unknown, modules?: readonly AdventureModule[] | ModuleRegistry): ValidationResult;
export declare function compileStory(story: Story, modules?: readonly AdventureModule[]): CompiledStory;
export declare function formatDiagnostics(result: ValidationResult, format?: "text" | "json"): string;
export declare function validateExpressionForContent(expression: ValueExpression | Condition | Action): boolean;
