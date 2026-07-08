export function normalizeProviderPayload(payload: unknown): unknown {
  return normalizeInstructionsFields(payload);
}

function normalizeInstructionsFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeInstructionsFields);
  if (!isRecord(value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === 'instructions' ? stringifyInstructions(child) : normalizeInstructionsFields(child),
  ]));
}

function stringifyInstructions(instructions: unknown): string {
  if (instructions === undefined || instructions === null) return '';
  if (typeof instructions === 'string') return instructions;

  if (Array.isArray(instructions)) {
    return instructions.map(stringifyInstructions).filter(Boolean).join('\n');
  }

  if (isRecord(instructions)) {
    const text = instructions.text ?? instructions.content ?? instructions.instructions;
    if (typeof text === 'string') return text;
  }

  return JSON.stringify(instructions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
