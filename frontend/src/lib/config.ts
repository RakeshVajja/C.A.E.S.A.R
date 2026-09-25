// NEXT_PUBLIC_ values are inlined at build time, so they must be referenced statically.
export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5001/api";
