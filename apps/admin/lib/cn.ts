/** Join class names, skipping falsy values. (No conflict resolution: components compose disjoint utilities.) */
export const cn = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');
