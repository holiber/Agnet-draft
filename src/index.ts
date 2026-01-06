export function helloWorld(name?: string): string {
  const who = name?.trim() ? name.trim() : "world";
  return `Hello, ${who}!`;
}

export * from "./local-runtime.js";
export * from "./protocol.js";
export * from "./framing.js";
export * from "./stdio-transport.js";

